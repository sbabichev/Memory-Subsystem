import { getLLMClient } from "./llm";
import {
  db,
  ensureTenant,
  getNoteById,
  getNotesByIds,
  findRelatedNoteIds,
  insertNote,
  insertRawItem,
  linkNoteEntities,
  setNoteMarkdownPath,
  setNoteEmbedding,
  upsertEntities,
  type NoteWithEntities,
} from "./repository";
import { getRetriever } from "./retriever";
import { notesBundleMarkdown, writeNoteMarkdown } from "./markdownStore";
import { embedText } from "./voyage-client";
import { logger } from "../lib/logger";

function serializeNote(n: NoteWithEntities) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    summary: n.summary,
    tags: n.tags,
    sourceItemId: n.sourceItemId,
    createdAt: n.createdAt,
    entities: n.entities,
  };
}

function buildEmbeddingInput(note: { title: string; body: string; summary: string | null }): string {
  return [note.title, note.summary ?? "", note.body].filter(Boolean).join("\n");
}

async function embedNoteAfterIngest(
  noteId: string,
  tenantId: string,
  note: { title: string; body: string; summary: string | null },
): Promise<void> {
  try {
    if (!process.env.VOYAGE_API_KEY) {
      return;
    }
    const input = buildEmbeddingInput(note);
    const result = await embedText(input, "document");
    await setNoteEmbedding(noteId, tenantId, result.embedding);
  } catch (err) {
    logger.warn({ err, noteId }, "embed-on-ingest: failed to embed note, leaving embedding NULL");
  }
}

export async function ingestText(
  input: {
    text: string;
    source?: string | null;
    author?: string | null;
  },
  tenantSlug: string,
) {
  const tenantId = await ensureTenant(tenantSlug);
  const llm = getLLMClient();

  const classified = await llm.classifyNotes(input.text, {
    source: input.source,
    author: input.author,
  });
  const perNoteEntities = await Promise.all(
    classified.map((n) => llm.extractEntities(n.body)),
  );

  const persisted = await db.transaction(async (tx) => {
    const raw = await insertRawItem(tx, {
      tenantId,
      text: input.text,
      source: input.source,
      author: input.author,
    });
    const created: NoteWithEntities[] = [];
    for (let i = 0; i < classified.length; i++) {
      const n = classified[i];
      const inserted = await insertNote(tx, {
        tenantId,
        type: n.type,
        title: n.title,
        body: n.body,
        summary: n.summary ?? null,
        tags: n.tags,
        sourceItemId: raw.id,
      });
      const upserted = await upsertEntities(tx, tenantId, perNoteEntities[i]);
      await linkNoteEntities(tx, inserted.id, upserted.map((e) => e.id));
      created.push({
        id: inserted.id,
        type: inserted.type,
        title: inserted.title,
        body: inserted.body,
        summary: inserted.summary,
        tags: inserted.tags ?? [],
        sourceItemId: inserted.sourceItemId,
        createdAt: inserted.createdAt,
        entities: upserted,
      });
    }
    return { rawId: raw.id, notes: created };
  });

  for (const n of persisted.notes) {
    const mdPath = await writeNoteMarkdown(n, tenantSlug, tenantId);
    if (mdPath) {
      await setNoteMarkdownPath(n.id, tenantId, mdPath);
    }
    await embedNoteAfterIngest(n.id, tenantId, {
      title: n.title,
      body: n.body,
      summary: n.summary,
    });
  }

  return {
    rawItemId: persisted.rawId,
    notes: persisted.notes.map(serializeNote),
  };
}

export async function fetchNote(id: string, tenantSlug: string) {
  const tenantId = await ensureTenant(tenantSlug);
  const n = await getNoteById(id, tenantId);
  return n ? serializeNote(n) : null;
}

export async function searchNotes(
  input: {
    query: string;
    limit?: number;
    types?: string[] | null;
    mode?: "lexical" | "semantic" | "hybrid";
  },
  tenantSlug: string,
) {
  const tenantId = await ensureTenant(tenantSlug);
  const llm = getLLMClient();
  const retriever = getRetriever();
  const limit = input.limit ?? 10;
  const mode = (input.mode ?? "hybrid") as "lexical" | "semantic" | "hybrid";

  const interpreted = await llm.interpretQuery(input.query);
  const effective = interpreted ?? input.query;

  const result = await retriever.search(effective, {
    limit,
    types: input.types ?? null,
    tenantId,
    mode,
  });

  return {
    query: input.query,
    interpretedQuery: interpreted,
    searchMode: result.effectiveMode,
    hits: result.hits.map((h) => ({ note: serializeNote(h.note), score: h.score })),
  };
}

export async function buildContext(
  input: {
    query: string;
    limit?: number;
    types?: string[] | null;
    synthesize?: boolean;
  },
  tenantSlug: string,
) {
  const tenantId = await ensureTenant(tenantSlug);
  const llm = getLLMClient();
  const retriever = getRetriever();
  const limit = input.limit ?? 8;
  const interpreted = await llm.interpretQuery(input.query);
  const effective = interpreted ?? input.query;
  const searchResult = await retriever.search(effective, {
    limit,
    types: input.types ?? null,
    tenantId,
    mode: "hybrid",
  });
  const directHits = searchResult.hits;

  const seedIds = directHits.map((h) => h.note.id);
  const relatedExtra = Math.max(2, Math.floor(limit / 2));
  const relatedIds = await findRelatedNoteIds(seedIds, { limit: relatedExtra }, tenantId);
  const relatedNotes = await getNotesByIds(
    relatedIds.filter((id) => !seedIds.includes(id)),
    tenantId,
  );

  const allNotes: NoteWithEntities[] = [
    ...directHits.map((h) => h.note),
    ...relatedNotes,
  ];
  const bundleMarkdown = notesBundleMarkdown(allNotes);

  const hits = [
    ...directHits.map((h) => ({
      note: serializeNote(h.note),
      score: h.score,
      via: "direct" as const,
    })),
    ...relatedNotes.map((n) => ({
      note: serializeNote(n),
      score: 0,
      via: "related" as const,
    })),
  ];

  let synthesisNote: ReturnType<typeof serializeNote> | null = null;
  if (input.synthesize) {
    const syn = await llm.synthesize(input.query, bundleMarkdown);
    if (syn) {
      const inserted = await db.transaction(async (tx) =>
        insertNote(tx, {
          tenantId,
          type: "synthesis",
          title: syn.title,
          body: syn.body,
          summary: syn.summary,
          tags: ["synthesis"],
          metadata: {
            query: input.query,
            sourceNoteIds: allNotes.map((n) => n.id),
          },
        }),
      );
      const full: NoteWithEntities = {
        id: inserted.id,
        type: inserted.type,
        title: inserted.title,
        body: inserted.body,
        summary: inserted.summary,
        tags: inserted.tags ?? [],
        sourceItemId: inserted.sourceItemId,
        createdAt: inserted.createdAt,
        entities: [],
      };
      const synPath = await writeNoteMarkdown(full, tenantSlug, tenantId);
      if (synPath) await setNoteMarkdownPath(full.id, tenantId, synPath);
      await embedNoteAfterIngest(full.id, tenantId, {
        title: full.title,
        body: full.body,
        summary: full.summary,
      });
      synthesisNote = serializeNote(full);
    }
  }

  return {
    query: input.query,
    interpretedQuery: interpreted,
    hits,
    bundleMarkdown,
    synthesisNote,
  };
}
