/**
 * Migration script: pgvector extension + HNSW cosine index on notes.embedding
 *
 * Run this ONCE before or after `drizzle-kit push` to ensure:
 *   1. The `vector` extension (pgvector) is enabled in the database.
 *   2. The `embedding` column exists on `notes` (added by drizzle-kit push).
 *   3. The HNSW cosine-distance index is created for fast ANN search.
 *
 * Every step is idempotent — safe to run on an already-migrated database.
 *
 * Usage:
 *   pnpm --filter @workspace/db run setup-pgvector
 */

import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    // 1. Enable pgvector extension (idempotent)
    console.log("Enabling pgvector extension...");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    console.log("  ✓ pgvector extension enabled");

    // 2. Verify embedding column exists (should be added by drizzle-kit push)
    const { rows: colRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'notes' AND column_name = 'embedding'
       ) AS exists`,
    );
    if (!colRows[0].exists) {
      console.error(
        "  ✗ notes.embedding column not found. Run `pnpm --filter @workspace/db run push-force` first.",
      );
      process.exit(1);
    }
    console.log("  ✓ notes.embedding column exists");

    // 3. Create HNSW cosine index (idempotent)
    const { rows: idxRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE tablename = 'notes' AND indexname = 'notes_embedding_hnsw_idx'
       ) AS exists`,
    );
    if (!idxRows[0].exists) {
      console.log("Creating HNSW cosine index on notes.embedding...");
      await client.query(`
        CREATE INDEX notes_embedding_hnsw_idx
          ON notes
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64)
      `);
      console.log("  ✓ HNSW index created");
    } else {
      console.log("  ✓ HNSW index already exists, skipping");
    }

    console.log("\nsetup-pgvector complete.");
  } catch (err) {
    console.error("setup-pgvector failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
