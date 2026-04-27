import pg from "pg";

const { Pool } = pg;

const REQUIRED_TABLES = ["tenants", "raw_items", "notes", "entities", "note_entities", "note_links"];

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
