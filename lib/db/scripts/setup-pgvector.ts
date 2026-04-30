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

    // 2. Create embedding column if it doesn't exist.
    //    The column uses the vector type which requires pgvector (step 1 above).
    //    It is intentionally excluded from the drizzle schema so that Replit's
    //    deploy migration validator (which runs before CREATE EXTENSION) never
    //    tries to create it.
    const { rows: colRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'notes' AND column_name = 'embedding'
       ) AS exists`,
    );
    if (!colRows[0].exists) {
      console.log("  Adding notes.embedding vector(1024) column...");
      await client.query(`ALTER TABLE notes ADD COLUMN embedding vector(1024)`);
      console.log("  ✓ notes.embedding column created");
    } else {
      console.log("  ✓ notes.embedding column exists");
    }

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
