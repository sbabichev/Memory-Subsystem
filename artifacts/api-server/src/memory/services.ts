import { getLLMClient } from "./llm";
import {
  db,
  getNoteById,
  getNotesByIds,
  findRelatedNoteIds,
  insertNote,
  insertRawItem,
  linkNoteEntities,
  setNoteMarkdownPath,
  upsertEntities,
  type NoteWithEntities,
} from "./repository";
import { getRetriever } from "./retriever";
import { notesBundleMarkdown, writeNoteMarkdown } from "./markdownStore";

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

export async function ingestText(input: {
  text: string;
  source?: string | null;
  author?: string | null;
}) {
  const llm = getLLMClient();

  // Run LLM calls outside the transaction so the DB connection is not held
  // open across (potentially slow) network calls.
  const classified = await llm.classifyNotes(input.text, {
    source: input.source,
    author: input.author,
  });
  const perNoteEntities = await Promise.all(
    classified.map((n) => llm.extractEntities(n.body)),
  );

  const persisted = await db.transaction(async (tx) => {
    const raw = await insertRawItem(tx, input);
    const created: NoteWithEntities[] = [];
    for (let i = 0; i < classified.length; i++) {
      const n = classified[i];
      const inserted = await insertNote(tx, {
        type: n.type,
        title: n.title,
        body: n.body,
        summary: n.summary ?? null,
        tags: n.tags,
        sourceItemId: raw.id,
      });
      const upserted = await upsertEntities(tx, perNoteEntities[i]);
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

  // Markdown export is best-effort and outside the transaction.
  for (const n of persisted.notes) {
    const mdPath = await writeNoteMarkdown(n);
    if (mdPath) {
      await setNoteMarkdownPath(n.id, mdPath);
    }
  }

  return {
    rawItemId: persisted.rawId,
    notes: persisted.notes.map(serializeNote),
  };
}

export async function fetchNote(id: string) {
  const n = await getNoteById(id);
  return n ? serializeNote(n) : null;
}

export async function searchNotes(input: {
  query: string;
  limit?: number;
  types?: string[] | null;
}) {
  const llm = getLLMClient();
  const retriever = getRetriever();
  const limit = input.limit ?? 10;
  const interpreted = await llm.interpretQuery(input.query);
  const effective = interpreted ?? input.query;
  const hits = await retriever.search(effective, {
    limit,
    types: input.types ?? null,
  });
  return {
    query: input.query,
    interpretedQuery: interpreted,
    hits: hits.map((h) => ({ note: serializeNote(h.note), score: h.score })),
  };
}

export async function buildContext(input: {
  query: string;
  limit?: number;
  types?: string[] | null;
  synthesize?: boolean;
}) {
  const llm = getLLMClient();
  const retriever = getRetriever();
  const limit = input.limit ?? 8;
  const interpreted = await llm.interpretQuery(input.query);
  const effective = interpreted ?? input.query;
  const directHits = await retriever.search(effective, {
    limit,
    types: input.types ?? null,
  });

  // Expand: pull related notes via explicit note_links and shared entities.
  const seedIds = directHits.map((h) => h.note.id);
  const relatedExtra = Math.max(2, Math.floor(limit / 2));
  const relatedIds = await findRelatedNoteIds(seedIds, { limit: relatedExtra });
  const relatedNotes = await getNotesByIds(
    relatedIds.filter((id) => !seedIds.includes(id)),
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
      const synPath = await writeNoteMarkdown(full);
      if (synPath) await setNoteMarkdownPath(full.id, synPath);
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
