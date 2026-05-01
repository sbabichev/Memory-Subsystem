import pg from "pg";

const { Pool } = pg;

const REQUIRED_TABLES = ["tenants", "raw_items", "notes", "entities", "note_entities", "note_links", "entity_relations"];

export type SchemaCheckResult =
  | { ok: true }
  | { ok: false; missing: string[] };

// Module-level pool so health-check probes don't create a new pool on each call.
// Uses a separate pool from the Drizzle ORM pool to avoid circular imports.
let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL not set");
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

/**
 * Ensure the notes.embedding vector column and its HNSW index exist.
 * Runs only when NODE_ENV=production (dev intentionally skips pgvector objects).
 * Idempotent — safe to call on every startup.
 */
export async function ensureEmbeddingColumn(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  const client = await getPool().connect();
  try {
    const { rows: extRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`,
    );
    if (!extRows[0].exists) return; // pgvector not installed, skip

    const { rows: colRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'notes' AND column_name = 'embedding'
       ) AS exists`,
    );
    if (!colRows[0].exists) {
      await client.query(`ALTER TABLE notes ADD COLUMN embedding vector(1024)`);
    }

    const { rows: idxRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE tablename = 'notes' AND indexname = 'notes_embedding_hnsw_idx'
       ) AS exists`,
    );
    if (!idxRows[0].exists) {
      await client.query(`
        CREATE INDEX notes_embedding_hnsw_idx
          ON notes USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64)
      `);
    }
  } finally {
    client.release();
  }
}

/**
 * Lightweight read-only schema check: verifies that all required tables are
 * present in the public schema.  No DDL side effects.
 *
 * Returns immediately — does not block or attempt to fix anything.
 * Safe to call at startup or from a health-check route.
 */
export async function checkSchema(): Promise<SchemaCheckResult> {
  if (!process.env.DATABASE_URL) {
    return { ok: false, missing: ["(DATABASE_URL not set)"] };
  }

  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `, [REQUIRED_TABLES]);

    const found = new Set(rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !found.has(t));

    if (missing.length > 0) {
      return { ok: false, missing };
    }

    return { ok: true };
  } finally {
    client.release();
  }
}
