import {
  classifyNotes,
  extractEntities,
  interpretQuery,
  synthesize,
} from "./llm";
import {
  db,
  ftsSearch,
  getNoteById,
  insertNote,
  insertRawItem,
  linkNoteEntities,
  upsertEntities,
  type NoteWithEntities,
} from "./repository";
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
  // Run LLM calls outside the transaction so the DB connection is not held
  // open across (potentially slow) network calls.
  const classified = await classifyNotes(input.text, {
    source: input.source,
    author: input.author,
  });
  const perNoteEntities = await Promise.all(
    classified.map((n) => extractEntities(n.body)),
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
    await writeNoteMarkdown(n);
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
  const limit = input.limit ?? 10;
  const interpreted = await interpretQuery(input.query);
  const effective = interpreted ?? input.query;
  const hits = await ftsSearch(effective, { limit, types: input.types ?? null });
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
  const limit = input.limit ?? 8;
  const interpreted = await interpretQuery(input.query);
  const effective = interpreted ?? input.query;
  const hits = await ftsSearch(effective, { limit, types: input.types ?? null });
  const fullNotes = hits.map((h) => h.note);
  const bundleMarkdown = notesBundleMarkdown(fullNotes);

  let synthesisNote: ReturnType<typeof serializeNote> | null = null;
  if (input.synthesize) {
    const syn = await synthesize(input.query, bundleMarkdown);
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
            sourceNoteIds: fullNotes.map((n) => n.id),
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
      await writeNoteMarkdown(full);
      synthesisNote = serializeNote(full);
    }
  }

  return {
    query: input.query,
    interpretedQuery: interpreted,
    hits: hits.map((h) => ({ note: serializeNote(h.note), score: h.score })),
    bundleMarkdown,
    synthesisNote,
  };
}
