import {
  db,
  rawItems,
  notes,
  entities,
  noteEntities,
  noteLinks,
  entityRelations,
  tenants,
} from "@workspace/db";
import { and, eq, inArray, not, or, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Tx;
export { db };

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Tenant resolution (slug → UUID) with an in-process cache.
// ---------------------------------------------------------------------------

const tenantIdCache = new Map<string, string>();

export async function getTenantIdBySlug(slug: string): Promise<string> {
  const cached = tenantIdCache.get(slug);
  if (cached) return cached;

  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`Tenant with slug "${slug}" not found`);
  }

  tenantIdCache.set(slug, rows[0].id);
  return rows[0].id;
}

/** Ensure a tenant exists (create if absent) and return its id. */
export async function ensureTenant(slug: string): Promise<string> {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (existing.length > 0) {
    tenantIdCache.set(slug, existing[0].id);
    return existing[0].id;
  }
  const [row] = await db
    .insert(tenants)
    .values({ slug })
    .onConflictDoNothing({ target: tenants.slug })
    .returning({ id: tenants.id });
  if (row) {
    tenantIdCache.set(slug, row.id);
    return row.id;
  }
  return getTenantIdBySlug(slug);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function insertRawItem(
  tx: Executor,
  input: {
    tenantId: string;
    text: string;
    source?: string | null;
    author?: string | null;
  },
) {
  const [row] = await tx
    .insert(rawItems)
    .values({
      tenantId: input.tenantId,
      text: input.text,
      source: input.source ?? null,
      author: input.author ?? null,
    })
    .returning();
  return row;
}

export async function insertNote(
  tx: Executor,
  input: {
    tenantId: string;
    type: string;
    title: string;
    body: string;
    summary?: string | null;
    tags: string[];
    sourceItemId?: string | null;
    metadata?: Record<string, unknown>;
    markdownPath?: string | null;
  },
) {
  const [row] = await tx
    .insert(notes)
    .values({
      tenantId: input.tenantId,
      type: input.type,
      title: input.title,
      body: input.body,
      summary: input.summary ?? null,
      tags: input.tags,
      sourceItemId: input.sourceItemId ?? null,
      metadata: input.metadata ?? {},
      markdownPath: input.markdownPath ?? null,
    })
    .returning();
  return row;
}

export async function setNoteEmbedding(
  noteId: string,
  tenantId: string,
  embedding: number[],
): Promise<void> {
  const vectorLiteral = `[${embedding.join(",")}]`;
  await db.execute(
    sql`UPDATE notes SET embedding = ${sql.raw(`'${vectorLiteral}'::vector`)} WHERE id = ${noteId}::uuid AND tenant_id = ${tenantId}::uuid`,
  );
}

export async function getNotesWithoutEmbedding(
  limit = 200,
): Promise<{ id: string; tenantId: string; title: string; body: string; summary: string | null }[]> {
  const rows = await db.execute<{
    id: string;
    tenant_id: string;
    title: string;
    body: string;
    summary: string | null;
  }>(sql`SELECT id, tenant_id, title, body, summary FROM notes WHERE embedding IS NULL LIMIT ${limit}`);
  return rows.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    body: r.body,
    summary: r.summary,
  }));
}

export async function setNoteMarkdownPath(
  noteId: string,
  tenantId: string,
  markdownPath: string,
): Promise<void> {
  await db
    .update(notes)
    .set({ markdownPath })
    .where(and(eq(notes.id, noteId), eq(notes.tenantId, tenantId)));
}

export async function upsertEntities(
  tx: Executor,
  tenantId: string,
  ents: { type: string; name: string }[],
): Promise<{ id: string; type: string; name: string }[]> {
  if (ents.length === 0) return [];
  const seen = new Map<string, { tenantId: string; type: string; name: string; normalizedName: string }>();
  for (const e of ents) {
    const normalized = normalizeName(e.name);
    const key = `${e.type}|${normalized}`;
    if (!seen.has(key)) {
      seen.set(key, { tenantId, type: e.type, name: e.name, normalizedName: normalized });
    }
  }
  const values = Array.from(seen.values());
  await tx
    .insert(entities)
    .values(values)
    .onConflictDoNothing({
      target: [entities.tenantId, entities.type, entities.normalizedName],
    });
  const rows = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        sql`(${entities.type}, ${entities.normalizedName}) IN (${sql.join(
          values.map((v) => sql`(${v.type}, ${v.normalizedName})`),
          sql`, `,
        )})`,
      ),
    );
  return rows.map((r) => ({ id: r.id, type: r.type, name: r.name }));
}

export async function linkNoteEntities(
  tx: Executor,
  noteId: string,
  entityIds: string[],
) {
  if (entityIds.length === 0) return;
  await tx
    .insert(noteEntities)
    .values(entityIds.map((entityId) => ({ noteId, entityId })))
    .onConflictDoNothing();
}

/**
 * Upsert typed entity↔entity relations, verifying both entities belong to `tenantId`.
 * Guards against cross-tenant edges.
 * On conflict (tenantId, fromEntityId, toEntityId, relation): updates confidence to max
 * and replaces sourceNoteId when incoming confidence is higher.
 *
 * NOTE: Reuse this function in future note-update flows via `buildAndPersistEntityRelations`.
 */
/** Allowed relation types for entity_relations — keep in sync with ENTITY_RELATION_TYPES in llm.ts */
const VALID_ENTITY_RELATIONS = new Set([
  "works_at",
  "attended",
  "lives_in",
  "located_in",
  "friend_of",
  "family_of",
  "colleague_of",
  "member_of",
  "created_by",
  "part_of",
  "mentions",
]);

export async function upsertEntityRelations(
  tx: Executor,
  tenantId: string,
  relations: { fromEntityId: string; toEntityId: string; relation: string; confidence: number }[],
  sourceNoteId: string | null,
): Promise<void> {
  if (relations.length === 0) return;

  // Guard 1: filter out any relations with non-whitelisted relation types.
  const typeFiltered = relations.filter((r) => VALID_ENTITY_RELATIONS.has(r.relation));
  if (typeFiltered.length === 0) return;

  const allEntityIds = Array.from(
    new Set(typeFiltered.flatMap((r) => [r.fromEntityId, r.toEntityId])),
  );

  // Guard 2: verify both endpoint entities belong to this tenant.
  const verifiedRows = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(and(inArray(entities.id, allEntityIds), eq(entities.tenantId, tenantId)));
  const verifiedIds = new Set(verifiedRows.map((r) => r.id));

  const safe = typeFiltered.filter(
    (r) => verifiedIds.has(r.fromEntityId) && verifiedIds.has(r.toEntityId),
  );
  if (safe.length === 0) return;

  // Guard 3: if sourceNoteId is provided, verify it belongs to this tenant.
  // If it doesn't (cross-tenant or non-existent), treat it as null.
  let safeSourceNoteId = sourceNoteId;
  if (sourceNoteId !== null) {
    const noteRow = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, sourceNoteId), eq(notes.tenantId, tenantId)))
      .limit(1);
    if (noteRow.length === 0) {
      safeSourceNoteId = null;
    }
  }

  await tx
    .insert(entityRelations)
    .values(
      safe.map((r) => ({
        tenantId,
        fromEntityId: r.fromEntityId,
        toEntityId: r.toEntityId,
        relation: r.relation,
        sourceNoteId: safeSourceNoteId,
        confidence: r.confidence,
      })),
    )
    .onConflictDoUpdate({
      target: [
        entityRelations.tenantId,
        entityRelations.fromEntityId,
        entityRelations.toEntityId,
        entityRelations.relation,
      ],
      set: {
        confidence: sql`GREATEST(${entityRelations.confidence}, EXCLUDED.confidence)`,
        sourceNoteId: sql`CASE WHEN EXCLUDED.confidence > ${entityRelations.confidence} THEN EXCLUDED.source_note_id ELSE ${entityRelations.sourceNoteId} END`,
      },
    });
}

/**
 * Insert typed note↔note links, verifying both endpoints belong to `tenantId`.
 * Guards against cross-tenant edges even if the caller supplies incorrect IDs.
 * Uses onConflictDoNothing on PK (fromNoteId, toNoteId, relation).
 *
 * NOTE: Reuse this function in future note-update flows.
 */
export async function insertNoteLinks(
  tx: Executor,
  tenantId: string,
  links: { fromId: string; toId: string; relation: string }[],
): Promise<void> {
  if (links.length === 0) return;

  const allNoteIds = Array.from(new Set(links.flatMap((l) => [l.fromId, l.toId])));
  const verifiedRows = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(inArray(notes.id, allNoteIds), eq(notes.tenantId, tenantId)));
  const verifiedIds = new Set(verifiedRows.map((r) => r.id));

  const safe = links.filter(
    (l) => verifiedIds.has(l.fromId) && verifiedIds.has(l.toId),
  );
  if (safe.length === 0) return;

  await tx
    .insert(noteLinks)
    .values(
      safe.map((l) => ({
        fromNoteId: l.fromId,
        toNoteId: l.toId,
        relation: l.relation,
      })),
    )
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Reads (all scoped to tenantId)
// ---------------------------------------------------------------------------

export type NoteWithEntities = {
  id: string;
  type: string;
  title: string;
  body: string;
  summary: string | null;
  tags: string[];
  sourceItemId: string | null;
  createdAt: Date;
  entities: { id: string; type: string; name: string }[];
};

async function attachEntities(noteRows: (typeof notes.$inferSelect)[], tenantId: string): Promise<NoteWithEntities[]> {
  if (noteRows.length === 0) return [];
  const ids = noteRows.map((n) => n.id);
  const links = await db
    .select({
      noteId: noteEntities.noteId,
      id: entities.id,
      type: entities.type,
      name: entities.name,
    })
    .from(noteEntities)
    .innerJoin(entities, eq(noteEntities.entityId, entities.id))
    .where(and(inArray(noteEntities.noteId, ids), eq(entities.tenantId, tenantId)));
  const byNote = new Map<string, { id: string; type: string; name: string }[]>();
  for (const l of links) {
    const arr = byNote.get(l.noteId) ?? [];
    arr.push({ id: l.id, type: l.type, name: l.name });
    byNote.set(l.noteId, arr);
  }
  return noteRows.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    summary: n.summary,
    tags: n.tags ?? [],
    sourceItemId: n.sourceItemId,
    createdAt: n.createdAt,
    entities: byNote.get(n.id) ?? [],
  }));
}

export async function getNoteById(id: string, tenantId: string): Promise<NoteWithEntities | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.tenantId, tenantId)))
    .limit(1);
  if (rows.length === 0) return null;
  const [withEnts] = await attachEntities(rows, tenantId);
  return withEnts;
}

export async function getNotesByIds(ids: string[], tenantId: string): Promise<NoteWithEntities[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(notes)
    .where(and(inArray(notes.id, ids), eq(notes.tenantId, tenantId)));
  return attachEntities(rows, tenantId);
}

export type RelatedNoteHit = {
  id: string;
  /** The typed relation from note_links, or "shared_entity" for entity-overlap expansion, or entity relation type for graph expansion */
  relation: string;
  /** The seed note ID that this related note was linked from, or null for entity expansion */
  viaNoteId: string | null;
  /** Set when the note was pulled in via a typed entity↔entity relation (1-hop graph expansion) */
  viaEntity?: { id: string; type: string; name: string; relation: string } | null;
};

export async function findRelatedNoteIds(
  seedNoteIds: string[],
  opts: { limit: number },
  tenantId: string,
): Promise<RelatedNoteHit[]> {
  if (seedNoteIds.length === 0) return [];

  const linked = new Map<string, RelatedNoteHit>();

  const rawLinkRows = await db
    .select({
      from: noteLinks.fromNoteId,
      to: noteLinks.toNoteId,
      relation: noteLinks.relation,
    })
    .from(noteLinks)
    .where(
      or(
        inArray(noteLinks.fromNoteId, seedNoteIds),
        inArray(noteLinks.toNoteId, seedNoteIds),
      ),
    );

  const linkCandidates = new Map<string, { relation: string; viaNoteId: string }>();
  for (const r of rawLinkRows) {
    const isFromSeed = seedNoteIds.includes(r.from);
    const isToSeed = seedNoteIds.includes(r.to);
    if (!isToSeed) {
      linkCandidates.set(r.to, { relation: r.relation, viaNoteId: r.from });
    }
    if (!isFromSeed) {
      linkCandidates.set(r.from, { relation: r.relation, viaNoteId: r.to });
    }
  }

  if (linkCandidates.size > 0) {
    const verified = await db
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          inArray(notes.id, Array.from(linkCandidates.keys())),
          eq(notes.tenantId, tenantId),
        ),
      );
    for (const r of verified) {
      const meta = linkCandidates.get(r.id)!;
      linked.set(r.id, { id: r.id, relation: meta.relation, viaNoteId: meta.viaNoteId });
    }
  }

  const seedEntityRows = await db
    .select({ entityId: noteEntities.entityId })
    .from(noteEntities)
    .innerJoin(entities, eq(noteEntities.entityId, entities.id))
    .where(
      and(
        inArray(noteEntities.noteId, seedNoteIds),
        eq(entities.tenantId, tenantId),
      ),
    );
  const entityIds = Array.from(new Set(seedEntityRows.map((r) => r.entityId)));

  if (entityIds.length > 0) {
    const sharedRows = await db
      .select({
        noteId: noteEntities.noteId,
        cnt: sql<number>`count(*)`.as("cnt"),
      })
      .from(noteEntities)
      .innerJoin(notes, eq(noteEntities.noteId, notes.id))
      .where(
        and(
          inArray(noteEntities.entityId, entityIds),
          eq(notes.tenantId, tenantId),
          sql`${noteEntities.noteId} <> ALL(${sql.raw(
            `ARRAY[${seedNoteIds.map((id) => `'${id}'::uuid`).join(",")}]`,
          )})`,
        ),
      )
      .groupBy(noteEntities.noteId)
      .orderBy(desc(sql`cnt`))
      .limit(opts.limit * 2);
    for (const r of sharedRows) {
      if (!linked.has(r.noteId)) {
        linked.set(r.noteId, { id: r.noteId, relation: "shared_entity", viaNoteId: null });
      }
    }

    // 1-hop entity-graph expansion via entity_relations.
    // Find related entities via typed directed relations (both directions),
    // then find notes that reference those related entities.
    const entityRelationRows = await db
      .select({
        fromEntityId: entityRelations.fromEntityId,
        toEntityId: entityRelations.toEntityId,
        relation: entityRelations.relation,
      })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.tenantId, tenantId),
          or(
            inArray(entityRelations.fromEntityId, entityIds),
            inArray(entityRelations.toEntityId, entityIds),
          ),
        ),
      );

    if (entityRelationRows.length > 0) {
      // Collect the "far" entities (the ones not in seed entity set) along with relation metadata.
      const entityIdSet = new Set(entityIds);
      const relatedEntityMap = new Map<string, { relation: string; seedEntityId: string }>();
      for (const r of entityRelationRows) {
        const isSeedFrom = entityIdSet.has(r.fromEntityId);
        const isSeedTo = entityIdSet.has(r.toEntityId);
        if (isSeedFrom && !entityIdSet.has(r.toEntityId)) {
          if (!relatedEntityMap.has(r.toEntityId)) {
            relatedEntityMap.set(r.toEntityId, { relation: r.relation, seedEntityId: r.fromEntityId });
          }
        }
        if (isSeedTo && !entityIdSet.has(r.fromEntityId)) {
          if (!relatedEntityMap.has(r.fromEntityId)) {
            relatedEntityMap.set(r.fromEntityId, { relation: r.relation, seedEntityId: r.toEntityId });
          }
        }
      }

      const relatedEntityIds = Array.from(relatedEntityMap.keys());
      if (relatedEntityIds.length > 0) {
        // Fetch metadata for the related entities (verify tenant ownership).
        const relatedEntityDetails = await db
          .select({ id: entities.id, type: entities.type, name: entities.name })
          .from(entities)
          .where(and(inArray(entities.id, relatedEntityIds), eq(entities.tenantId, tenantId)));
        const relatedEntityById = new Map(relatedEntityDetails.map((e) => [e.id, e]));

        // Find notes that reference those related entities, scoped to this tenant.
        const graphExpandedNotes = await db
          .select({ noteId: noteEntities.noteId, entityId: noteEntities.entityId })
          .from(noteEntities)
          .innerJoin(notes, eq(noteEntities.noteId, notes.id))
          .where(
            and(
              inArray(noteEntities.entityId, relatedEntityIds),
              eq(notes.tenantId, tenantId),
              sql`${noteEntities.noteId} <> ALL(${sql.raw(
                `ARRAY[${seedNoteIds.map((id) => `'${id}'::uuid`).join(",")}]`,
              )})`,
            ),
          )
          .limit(opts.limit * 2);

        for (const r of graphExpandedNotes) {
          if (!linked.has(r.noteId)) {
            const relMeta = relatedEntityMap.get(r.entityId);
            const entityDetail = relatedEntityById.get(r.entityId);
            if (relMeta && entityDetail) {
              linked.set(r.noteId, {
                id: r.noteId,
                relation: relMeta.relation,
                viaNoteId: null,
                viaEntity: {
                  id: entityDetail.id,
                  type: entityDetail.type,
                  name: entityDetail.name,
                  relation: relMeta.relation,
                },
              });
            }
          }
        }
      }
    }
  }

  return Array.from(linked.values()).slice(0, opts.limit);
}

/**
 * Find existing entities in a tenant whose normalized names overlap with any
 * of the given new entities. Used during ingest to expand the entity universe
 * passed to `extractEntityRelations`, so that cross-note edges (entities that
 * appeared in earlier notes but are also referenced by the current note text)
 * can be discovered.
 *
 * Matching rules per (type, name) pair:
 *   - Same type
 *   - Either: existing.normalizedName contains the new normalized name, or
 *     the new normalized name contains existing.normalizedName (substring,
 *     case-insensitive on the already-normalized lowercase form).
 *
 * Ordering (best matches first, before applying `limit`):
 *   1. Exact normalized-name matches
 *   2. Shortest absolute length difference between existing.normalizedName
 *      and the closest new name (closer alias wins)
 *
 * Names shorter than `minNameLen` (default 3) are skipped to suppress noise
 * from very short tokens like "an" / "of". Cross-tenant entities are excluded
 * by the tenantId filter. Results are capped by `limit`.
 *
 * NOTE: substring matching may produce false positives (e.g. "Bob" overlaps
 * with "Bobcat"). The downstream LLM call is guarded by a "do not invent
 * relationships" prompt and a confidence threshold, so spurious additions are
 * filtered out before persistence. The ordering above ensures the best
 * candidates win when many partial matches compete for the limit.
 */
export async function findOverlappingEntities(
  tenantId: string,
  newEntities: { type: string; name: string }[],
  excludeIds: string[],
  opts?: { limit?: number; minNameLen?: number },
): Promise<{ id: string; type: string; name: string }[]> {
  if (newEntities.length === 0) return [];
  const minNameLen = opts?.minNameLen ?? 3;
  const limit = opts?.limit ?? 20;

  const byType = new Map<string, Set<string>>();
  const allNorms = new Set<string>();
  for (const e of newEntities) {
    const norm = normalizeName(e.name);
    if (norm.length < minNameLen) continue;
    const set = byType.get(e.type) ?? new Set<string>();
    set.add(norm);
    byType.set(e.type, set);
    allNorms.add(norm);
  }
  if (byType.size === 0) return [];

  const orParts: ReturnType<typeof sql>[] = [];
  for (const [type, names] of byType) {
    for (const n of names) {
      orParts.push(
        sql`(${entities.type} = ${type} AND (position(${n} in ${entities.normalizedName}) > 0 OR position(${entities.normalizedName} in ${n}) > 0))`,
      );
    }
  }

  // Score: 0 when normalizedName is an exact match for any new normalized name,
  // 1 otherwise. Used as the primary ORDER BY key so exact matches win.
  const allNormsArr = Array.from(allNorms);
  const exactMatchScore = sql<number>`CASE WHEN ${entities.normalizedName} IN (${sql.join(
    allNormsArr.map((n) => sql`${n}`),
    sql`, `,
  )}) THEN 0 ELSE 1 END`.as("exact_match_score");

  // Tiebreaker: minimum absolute length difference between existing
  // normalizedName and any new normalized name. Smaller is better (closer
  // alias). Computed via LEAST(...) over the candidate name lengths.
  const lengthDiffExpr = sql<number>`LEAST(${sql.join(
    allNormsArr.map(
      (n) => sql`abs(length(${entities.normalizedName}) - ${n.length})`,
    ),
    sql`, `,
  )})`.as("length_diff");

  const whereParts = [eq(entities.tenantId, tenantId)];
  const orCombined = or(...orParts);
  if (orCombined) whereParts.push(orCombined);
  if (excludeIds.length > 0) {
    whereParts.push(not(inArray(entities.id, excludeIds)));
  }
  whereParts.push(sql`length(${entities.normalizedName}) >= ${minNameLen}`);

  const rows = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      _exactMatchScore: exactMatchScore,
      _lengthDiff: lengthDiffExpr,
    })
    .from(entities)
    .where(and(...whereParts))
    .orderBy(sql`exact_match_score`, sql`length_diff`)
    .limit(limit);

  return rows.map((r) => ({ id: r.id, type: r.type, name: r.name }));
}

/**
 * Find existing note IDs in a tenant that share at least `minShared` entities
 * with any of the given entity IDs. Used to build cross-batch candidates for
 * link extraction during ingest.
 */
export async function findNotesWithSharedEntities(
  tenantId: string,
  entityIds: string[],
  opts: { minShared: number; topK: number; excludeIds: string[] },
): Promise<string[]> {
  if (entityIds.length === 0) return [];

  const excludeClause =
    opts.excludeIds.length > 0
      ? sql`${noteEntities.noteId} <> ALL(${sql.raw(
          `ARRAY[${opts.excludeIds.map((id) => `'${id}'::uuid`).join(",")}]`,
        )})`
      : sql`TRUE`;

  const sharedRows = await db
    .select({
      noteId: noteEntities.noteId,
      cnt: sql<number>`count(distinct ${noteEntities.entityId})`.as("cnt"),
    })
    .from(noteEntities)
    .innerJoin(notes, eq(noteEntities.noteId, notes.id))
    .where(
      and(
        inArray(noteEntities.entityId, entityIds),
        eq(notes.tenantId, tenantId),
        excludeClause,
      ),
    )
    .groupBy(noteEntities.noteId)
    .having(sql`count(distinct ${noteEntities.entityId}) >= ${opts.minShared}`)
    .orderBy(desc(sql`cnt`))
    .limit(opts.topK);

  return sharedRows.map((r) => r.noteId);
}

export type SearchHitRow = { note: NoteWithEntities; score: number };

export async function ftsSearch(
  query: string,
  opts: { limit: number; types?: string[] | null; tenantId: string },
): Promise<SearchHitRow[]> {
  const orQuery = query.includes('"')
    ? query
    : query
        .split(/\s+/)
        .filter((t) => t.trim().length > 0)
        .join(" OR ");
  const tsq = sql`websearch_to_tsquery('english', ${orQuery})`;
  const whereParts = [
    sql`${notes.searchVector} @@ ${tsq}`,
    eq(notes.tenantId, opts.tenantId),
  ];
  if (opts.types && opts.types.length > 0) {
    whereParts.push(inArray(notes.type, opts.types));
  }
  const rows = await db
    .select({
      note: notes,
      score: sql<number>`ts_rank(${notes.searchVector}, ${tsq})`.as("score"),
    })
    .from(notes)
    .where(and(...whereParts))
    .orderBy(desc(sql`score`))
    .limit(opts.limit);
  if (rows.length === 0) {
    const ilikeWhere = [
      sql`(${notes.title} ILIKE ${"%" + query + "%"} OR ${notes.body} ILIKE ${"%" + query + "%"})`,
      eq(notes.tenantId, opts.tenantId),
    ];
    if (opts.types && opts.types.length > 0) {
      ilikeWhere.push(inArray(notes.type, opts.types));
    }
    const fallback = await db
      .select()
      .from(notes)
      .where(and(...ilikeWhere))
      .orderBy(desc(notes.createdAt))
      .limit(opts.limit);
    const hydrated = await attachEntities(fallback, opts.tenantId);
    return hydrated.map((n) => ({ note: n, score: 0.01 }));
  }
  const hydrated = await attachEntities(rows.map((r) => r.note), opts.tenantId);
  return hydrated.map((n, i) => ({ note: n, score: Number(rows[i].score) }));
}

export async function semanticSearch(
  queryEmbedding: number[],
  opts: { limit: number; types?: string[] | null; tenantId: string; maxDistance?: number },
): Promise<SearchHitRow[]> {
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;
  const maxDist = opts.maxDistance ?? 0.65;
  const whereParts = [
    eq(notes.tenantId, opts.tenantId),
    sql`"embedding" IS NOT NULL`,
    sql`"embedding" <=> ${sql.raw(`'${vectorLiteral}'::vector`)} < ${maxDist}`,
  ];
  if (opts.types && opts.types.length > 0) {
    whereParts.push(inArray(notes.type, opts.types));
  }

  const rows = await db
    .select({
      note: notes,
      distance: sql<number>`"embedding" <=> ${sql.raw(`'${vectorLiteral}'::vector`)}`.as("distance"),
    })
    .from(notes)
    .where(and(...whereParts))
    .orderBy(sql`distance`)
    .limit(opts.limit);

  const hydrated = await attachEntities(rows.map((r) => r.note), opts.tenantId);
  return hydrated.map((n, i) => ({
    note: n,
    score: 1 - Number(rows[i].distance),
  }));
}

/** Reciprocal Rank Fusion over two hit lists. k=60 per standard. */
export function rrfFuse(
  ftsHits: SearchHitRow[],
  semanticHits: SearchHitRow[],
  limit: number,
  k = 60,
): SearchHitRow[] {
  const scores = new Map<string, { hit: SearchHitRow; score: number }>();

  const addHits = (hits: SearchHitRow[]) => {
    hits.forEach((hit, rank) => {
      const id = hit.note.id;
      const existing = scores.get(id);
      const rrfScore = 1 / (k + rank + 1);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(id, { hit, score: rrfScore });
      }
    });
  };

  addHits(ftsHits);
  addHits(semanticHits);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ note: entry.hit.note, score: entry.score }));
}

// ---------------------------------------------------------------------------
// Entity graph queries
// ---------------------------------------------------------------------------

export type EntityRelationHit = {
  relation: string;
  from: { id: string; type: string; name: string };
  to: { id: string; type: string; name: string };
  sourceNoteId: string | null;
  confidence: number;
  createdAt: Date;
};

/**
 * Query typed entity↔entity relations, scoped to a tenant.
 *
 * Filters:
 *   - `entityName`: matches normalized name on either endpoint (controlled by `direction`).
 *   - `entityType`: filters the matched endpoint(s) by entity type.
 *   - `relation`:   exact match on relation type (must be in VALID_ENTITY_RELATIONS).
 *   - `direction`:  when `entityName` is given:
 *                     "outgoing" → entity is the from-side (e.g. "X works_at ?")
 *                     "incoming" → entity is the to-side   (e.g. "? works_at X")
 *                     "both"     → either side
 *                   When `entityName` is omitted, `direction` is ignored.
 */
export async function queryEntityRelations(
  tenantId: string,
  opts: {
    entityName?: string | null;
    entityType?: string | null;
    relation?: string | null;
    direction?: "outgoing" | "incoming" | "both";
    limit: number;
  },
): Promise<EntityRelationHit[]> {
  if (opts.relation && !VALID_ENTITY_RELATIONS.has(opts.relation)) {
    return [];
  }

  let matchedEntityIds: string[] | null = null;
  if (opts.entityName) {
    const normalized = normalizeName(opts.entityName);
    const whereParts = [
      eq(entities.tenantId, tenantId),
      eq(entities.normalizedName, normalized),
    ];
    if (opts.entityType) {
      whereParts.push(eq(entities.type, opts.entityType));
    }
    const matched = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(...whereParts));
    matchedEntityIds = matched.map((r) => r.id);
    if (matchedEntityIds.length === 0) return [];
  }

  const direction = opts.direction ?? "both";
  const whereParts = [eq(entityRelations.tenantId, tenantId)];

  if (matchedEntityIds) {
    if (direction === "outgoing") {
      whereParts.push(inArray(entityRelations.fromEntityId, matchedEntityIds));
    } else if (direction === "incoming") {
      whereParts.push(inArray(entityRelations.toEntityId, matchedEntityIds));
    } else {
      whereParts.push(
        or(
          inArray(entityRelations.fromEntityId, matchedEntityIds),
          inArray(entityRelations.toEntityId, matchedEntityIds),
        )!,
      );
    }
  }

  if (opts.relation) {
    whereParts.push(eq(entityRelations.relation, opts.relation));
  }

  const fromEntities = alias(entities, "from_entities");
  const toEntities = alias(entities, "to_entities");

  // Defensive tenant scoping on the joined endpoints. The write-side guards
  // in upsertEntityRelations already prevent cross-tenant edges, but
  // requiring both endpoint entities to belong to the caller's tenant on
  // read keeps the endpoint safe even if a future write path or migration
  // ever introduced a stray cross-tenant row.
  const rows = await db
    .select({
      relation: entityRelations.relation,
      sourceNoteId: entityRelations.sourceNoteId,
      confidence: entityRelations.confidence,
      createdAt: entityRelations.createdAt,
      fromId: entityRelations.fromEntityId,
      toId: entityRelations.toEntityId,
      fromType: fromEntities.type,
      fromName: fromEntities.name,
      toType: toEntities.type,
      toName: toEntities.name,
    })
    .from(entityRelations)
    .innerJoin(
      fromEntities,
      and(
        eq(entityRelations.fromEntityId, fromEntities.id),
        eq(fromEntities.tenantId, tenantId),
      )!,
    )
    .innerJoin(
      toEntities,
      and(
        eq(entityRelations.toEntityId, toEntities.id),
        eq(toEntities.tenantId, tenantId),
      )!,
    )
    .where(and(...whereParts))
    .orderBy(desc(entityRelations.confidence), desc(entityRelations.createdAt))
    .limit(opts.limit);

  return rows.map((r) => ({
    relation: r.relation,
    from: { id: r.fromId, type: r.fromType, name: r.fromName },
    to: { id: r.toId, type: r.toType, name: r.toName },
    sourceNoteId: r.sourceNoteId,
    confidence: Number(r.confidence),
    createdAt: r.createdAt,
  }));
}

export async function getNotesWithNullEmbedding(
  limit: number,
  offset: number,
): Promise<{ id: string; tenantId: string; title: string; body: string; summary: string | null }[]> {
  const rows = await db
    .select({
      id: notes.id,
      tenantId: notes.tenantId,
      title: notes.title,
      body: notes.body,
      summary: notes.summary,
    })
    .from(notes)
    .where(sql`"embedding" IS NULL`)
    .orderBy(notes.createdAt)
    .limit(limit)
    .offset(offset);
  return rows;
}
