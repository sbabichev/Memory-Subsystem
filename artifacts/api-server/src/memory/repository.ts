import {
  db,
  rawItems,
  notes,
  entities,
  noteEntities,
  noteLinks,
} from "@workspace/db";
import { and, eq, inArray, ne, or, sql, desc } from "drizzle-orm";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Tx;
export { db };

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function insertRawItem(
  tx: Executor,
  input: {
    text: string;
    source?: string | null;
    author?: string | null;
  },
) {
  const [row] = await tx
    .insert(rawItems)
    .values({
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
    type: string;
    title: string;
    body: string;
    summary?: string | null;
    tags: string[];
    sourceItemId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const [row] = await tx
    .insert(notes)
    .values({
      type: input.type,
      title: input.title,
      body: input.body,
      summary: input.summary ?? null,
      tags: input.tags,
      sourceItemId: input.sourceItemId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  return row;
}

export async function upsertEntities(
  tx: Executor,
  ents: { type: string; name: string }[],
): Promise<{ id: string; type: string; name: string }[]> {
  if (ents.length === 0) return [];
  // Deduplicate within the call so a single ON CONFLICT row is produced per pair.
  const seen = new Map<string, { type: string; name: string; normalizedName: string }>();
  for (const e of ents) {
    const normalized = normalizeName(e.name);
    const key = `${e.type}|${normalized}`;
    if (!seen.has(key)) {
      seen.set(key, { type: e.type, name: e.name, normalizedName: normalized });
    }
  }
  const values = Array.from(seen.values());
  await tx
    .insert(entities)
    .values(values)
    .onConflictDoNothing({
      target: [entities.type, entities.normalizedName],
    });
  const rows = await tx
    .select()
    .from(entities)
    .where(
      sql`(${entities.type}, ${entities.normalizedName}) IN (${sql.join(
        values.map((v) => sql`(${v.type}, ${v.normalizedName})`),
        sql`, `,
      )})`,
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

async function attachEntities(noteRows: (typeof notes.$inferSelect)[]): Promise<NoteWithEntities[]> {
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
    .where(inArray(noteEntities.noteId, ids));
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

export async function getNoteById(id: string): Promise<NoteWithEntities | null> {
  const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (rows.length === 0) return null;
  const [withEnts] = await attachEntities(rows);
  return withEnts;
}

export async function getNotesByIds(ids: string[]): Promise<NoteWithEntities[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  return attachEntities(rows);
}

export async function findRelatedNoteIds(
  seedNoteIds: string[],
  opts: { limit: number },
): Promise<string[]> {
  if (seedNoteIds.length === 0) return [];

  // 1. Notes connected via explicit note_links (either direction).
  const linkRows = await db
    .select({
      from: noteLinks.fromNoteId,
      to: noteLinks.toNoteId,
    })
    .from(noteLinks)
    .where(
      or(
        inArray(noteLinks.fromNoteId, seedNoteIds),
        inArray(noteLinks.toNoteId, seedNoteIds),
      ),
    );
  const linked = new Set<string>();
  for (const r of linkRows) {
    if (!seedNoteIds.includes(r.from)) linked.add(r.from);
    if (!seedNoteIds.includes(r.to)) linked.add(r.to);
  }

  // 2. Notes that share at least one entity with the seed set.
  const seedEntityRows = await db
    .select({ entityId: noteEntities.entityId })
    .from(noteEntities)
    .where(inArray(noteEntities.noteId, seedNoteIds));
  const entityIds = Array.from(new Set(seedEntityRows.map((r) => r.entityId)));

  if (entityIds.length > 0) {
    const sharedRows = await db
      .select({
        noteId: noteEntities.noteId,
        cnt: sql<number>`count(*)`.as("cnt"),
      })
      .from(noteEntities)
      .where(
        and(
          inArray(noteEntities.entityId, entityIds),
          sql`${noteEntities.noteId} <> ALL(${sql.raw(
            `ARRAY[${seedNoteIds.map((id) => `'${id}'::uuid`).join(",")}]`,
          )})`,
        ),
      )
      .groupBy(noteEntities.noteId)
      .orderBy(desc(sql`cnt`))
      .limit(opts.limit * 2);
    for (const r of sharedRows) {
      linked.add(r.noteId);
    }
  }

  return Array.from(linked).slice(0, opts.limit);
}

export type SearchHitRow = { note: NoteWithEntities; score: number };

export async function ftsSearch(
  query: string,
  opts: { limit: number; types?: string[] | null },
): Promise<SearchHitRow[]> {
  // Transform "foo bar baz" into `foo OR bar OR baz` for broader recall while
  // still allowing the user to pass quoted phrases (preserved by websearch_to_tsquery).
  const orQuery = query.includes('"')
    ? query
    : query
        .split(/\s+/)
        .filter((t) => t.trim().length > 0)
        .join(" OR ");
  const tsq = sql`websearch_to_tsquery('english', ${orQuery})`;
  const whereParts = [sql`${notes.searchVector} @@ ${tsq}`];
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
    // fallback: ILIKE on title/body for substring matches not covered by FTS
    const ilikeWhere = [sql`(${notes.title} ILIKE ${"%" + query + "%"} OR ${notes.body} ILIKE ${"%" + query + "%"})`];
    if (opts.types && opts.types.length > 0) {
      ilikeWhere.push(inArray(notes.type, opts.types));
    }
    const fallback = await db
      .select()
      .from(notes)
      .where(and(...ilikeWhere))
      .orderBy(desc(notes.createdAt))
      .limit(opts.limit);
    const hydrated = await attachEntities(fallback);
    return hydrated.map((n) => ({ note: n, score: 0.01 }));
  }
  const hydrated = await attachEntities(rows.map((r) => r.note));
  return hydrated.map((n, i) => ({ note: n, score: Number(rows[i].score) }));
}
