import {
  db,
  rawItems,
  notes,
  entities,
  noteEntities,
  noteLinks,
  tenants,
} from "@workspace/db";
import { and, eq, inArray, or, sql, desc, isNull } from "drizzle-orm";

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
  await db
    .update(notes)
    .set({ embedding: sql.raw(`'${vectorLiteral}'::vector`) as unknown as number[] })
    .where(and(eq(notes.id, noteId), eq(notes.tenantId, tenantId)));
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
  /** The typed relation from note_links, or "shared_entity" for entity-overlap expansion */
  relation: string;
  /** The seed note ID that this related note was linked from, or null for entity expansion */
  viaNoteId: string | null;
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
  }

  return Array.from(linked.values()).slice(0, opts.limit);
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
  opts: { limit: number; types?: string[] | null; tenantId: string },
): Promise<SearchHitRow[]> {
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;
  const whereParts = [
    eq(notes.tenantId, opts.tenantId),
    sql`${notes.embedding} IS NOT NULL`,
  ];
  if (opts.types && opts.types.length > 0) {
    whereParts.push(inArray(notes.type, opts.types));
  }

  const rows = await db
    .select({
      note: notes,
      distance: sql<number>`${notes.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)}`.as("distance"),
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
    .where(isNull(notes.embedding))
    .orderBy(notes.createdAt)
    .limit(limit)
    .offset(offset);
  return rows;
}
