import { getLLMClient, type LLMClient, type NoteRelationCandidate } from "./llm";
import {
  db,
  ensureTenant,
  getNoteById,
  getNotesByIds,
  findRelatedNoteIds,
  findNotesWithSharedEntities,
  findOverlappingEntities,
  insertNote,
  insertNoteLinks,
  insertRawItem,
  linkNoteEntities,
  queryEntityRelations,
  setNoteMarkdownPath,
  setNoteEmbedding,
  upsertEntities,
  upsertEntityRelations,
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

/**
 * Minimum number of shared entities required to consider a cross-batch pair
 * as a link candidate.
 */
const CROSS_BATCH_MIN_SHARED_ENTITIES = 2;

/**
 * Maximum number of cross-batch candidate existing notes to consider per
 * ingest batch (across all new notes combined).
 */
const CROSS_BATCH_TOP_K = 10;

/**
 * Build and persist typed note↔note links for a set of newly ingested notes.
 *
 * This function is intentionally extracted so that future note-update flows
 * can call it without duplicating logic. To reuse: call
 * `buildAndPersistNoteLinks(tenantId, updatedNote, llm)` after updating a
 * note's body/entities, passing the updated note in the `newNotes` array.
 *
 * @param tenantId - the tenant that owns all notes
 * @param newNotes - notes just created (already have entity data)
 * @param llm     - LLM client (injected so callers can override)
 */
async function buildAndPersistNoteLinks(
  tenantId: string,
  newNotes: NoteWithEntities[],
  llm: LLMClient,
): Promise<void> {
  if (newNotes.length === 0) return;

  try {
    const newNoteIds = newNotes.map((n) => n.id);

    const newNoteIdsSet = new Set(newNoteIds);

    const existingCandidateIdsSet = new Set<string>();
    for (const n of newNotes) {
      const entityIds = n.entities.map((e) => e.id);
      if (entityIds.length === 0) continue;
      const perNoteCandidates = await findNotesWithSharedEntities(
        tenantId,
        entityIds,
        {
          minShared: CROSS_BATCH_MIN_SHARED_ENTITIES,
          topK: CROSS_BATCH_TOP_K,
          excludeIds: newNoteIds,
        },
      );
      for (const id of perNoteCandidates) existingCandidateIdsSet.add(id);
    }

    let existingCandidates: NoteWithEntities[] = [];
    const existingCandidateIds = Array.from(existingCandidateIdsSet);
    if (existingCandidateIds.length > 0) {
      existingCandidates = await getNotesByIds(existingCandidateIds, tenantId);
    }

    const allCandidates: NoteRelationCandidate[] = [
      ...newNotes.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        summary: n.summary,
        entities: n.entities,
      })),
      ...existingCandidates.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        summary: n.summary,
        entities: n.entities,
      })),
    ];

    if (allCandidates.length < 2) return;

    const relations = await llm.extractNoteRelations(allCandidates);
    if (relations.length === 0) return;

    const relationsInvolvingNewNote = relations.filter(
      (r) => newNoteIdsSet.has(r.fromId) || newNoteIdsSet.has(r.toId),
    );
    if (relationsInvolvingNewNote.length === 0) return;

    await db.transaction(async (tx) => {
      await insertNoteLinks(
        tx,
        tenantId,
        relationsInvolvingNewNote.map((r) => ({
          fromId: r.fromId,
          toId: r.toId,
          relation: r.relation,
        })),
      );
    });

    logger.info(
      { tenantId, count: relations.length },
      "buildAndPersistNoteLinks: inserted note links",
    );
  } catch (err) {
    logger.warn({ err, tenantId }, "buildAndPersistNoteLinks: failed, skipping links");
  }
}

/**
 * Maximum number of overlapping existing entities to pull in per note when
 * extracting cross-note entity relations during ingest.
 */
const CROSS_NOTE_ENTITY_OVERLAP_LIMIT = 20;

/**
 * Extract typed entity↔entity relations from a note and persist them.
 *
 * The `ents` list may include entities from outside the note (e.g. existing
 * tenant entities whose names overlap with the note's entities). The LLM is
 * instructed not to invent relationships, so entities not referenced in
 * `note.body` simply produce no edges. This is how we discover cross-note
 * entity relations: a name mentioned in the new note may resolve to an entity
 * created by an earlier note, and a relation between them is then persisted.
 *
 * This function is intentionally extracted so that future note-update flows
 * can call it without duplicating logic. To reuse: call
 * `buildAndPersistEntityRelations(tx, tenantId, note, entities, llm)` after
 * updating a note's body/entities.
 *
 * @param tx       - drizzle transaction or db instance
 * @param tenantId - the tenant that owns the note and entities
 * @param note     - the note (needs id and body)
 * @param ents     - candidate entities to consider (note's own + optional
 *                   overlapping existing entities); all must belong to
 *                   `tenantId` (verified again by `upsertEntityRelations`)
 * @param llm      - LLM client (injected so callers can override)
 */
export async function buildAndPersistEntityRelations(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  tenantId: string,
  note: { id: string; body: string },
  ents: { id: string; type: string; name: string }[],
  llm: LLMClient,
): Promise<void> {
  const dedupedEnts = Array.from(
    new Map(ents.map((e) => [e.id, e])).values(),
  );
  if (dedupedEnts.length < 2) return;
  try {
    const extracted = await llm.extractEntityRelations({
      noteText: note.body,
      entities: dedupedEnts,
    });
    if (extracted.length === 0) return;
    await upsertEntityRelations(tx, tenantId, extracted, note.id);
    logger.info(
      { tenantId, noteId: note.id, count: extracted.length, candidateCount: dedupedEnts.length },
      "buildAndPersistEntityRelations: upserted entity relations",
    );
  } catch (err) {
    logger.warn({ err, tenantId, noteId: note.id }, "buildAndPersistEntityRelations: failed, skipping");
  }
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

  await buildAndPersistNoteLinks(tenantId, persisted.notes, llm);

  const newNoteEntityIds = new Set(
    persisted.notes.flatMap((n) => n.entities.map((e) => e.id)),
  );
  for (const n of persisted.notes) {
    const ownEntityIds = n.entities.map((e) => e.id);
    let overlapping: { id: string; type: string; name: string }[] = [];
    try {
      overlapping = await findOverlappingEntities(
        tenantId,
        n.entities.map((e) => ({ type: e.type, name: e.name })),
        // Exclude both this note's own entities (already in the list) and
        // any entities created by sibling notes in this same ingest batch
        // (they have no prior cross-note context to contribute).
        Array.from(new Set([...ownEntityIds, ...newNoteEntityIds])),
        { limit: CROSS_NOTE_ENTITY_OVERLAP_LIMIT },
      );
    } catch (err) {
      logger.warn(
        { err, tenantId, noteId: n.id },
        "findOverlappingEntities: failed, falling back to within-note entities only",
      );
    }
    const combinedEntities = [...n.entities, ...overlapping];
    await buildAndPersistEntityRelations(db, tenantId, n, combinedEntities, llm);
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

export async function queryGraphEntities(
  input: {
    entity?: string | null;
    entityType?: string | null;
    relation?: string | null;
    direction?: "outgoing" | "incoming" | "both";
    limit?: number;
  },
  tenantSlug: string,
) {
  const tenantId = await ensureTenant(tenantSlug);
  const limit = input.limit ?? 50;
  const hits = await queryEntityRelations(tenantId, {
    entityName: input.entity ?? null,
    entityType: input.entityType ?? null,
    relation: input.relation ?? null,
    direction: input.direction ?? "both",
    limit,
  });
  return {
    query: {
      entity: input.entity ?? null,
      entityType: input.entityType ?? null,
      relation: input.relation ?? null,
      direction: (input.direction ?? "both") as "outgoing" | "incoming" | "both",
    },
    relations: hits.map((h) => ({
      relation: h.relation,
      from: h.from,
      to: h.to,
      sourceNoteId: h.sourceNoteId,
      confidence: h.confidence,
      createdAt: h.createdAt,
    })),
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
  const relatedHits = await findRelatedNoteIds(seedIds, { limit: relatedExtra }, tenantId);
  const relatedHitsFiltered = relatedHits.filter((h) => !seedIds.includes(h.id));
  const relatedNotes = await getNotesByIds(
    relatedHitsFiltered.map((h) => h.id),
    tenantId,
  );
  const relatedMetaMap = new Map(relatedHitsFiltered.map((h) => [h.id, h]));

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
    ...relatedNotes.map((n) => {
      const meta = relatedMetaMap.get(n.id);
      return {
        note: serializeNote(n),
        score: 0,
        via: "related" as const,
        relation: meta?.relation,
        viaNoteId: meta?.viaNoteId ?? undefined,
        viaEntity: meta?.viaEntity ?? undefined,
      };
    }),
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
