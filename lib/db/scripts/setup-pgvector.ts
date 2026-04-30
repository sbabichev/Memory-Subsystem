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

    // 2 & 3: embedding column + HNSW index — production only.
    //
    // Both require the pgvector extension.  Replit's deploy migration validator
    // compares the dev DB schema to the prod DB schema and generates SQL to
    // reconcile them.  If dev has the embedding column or HNSW index, the
    // validator will try to create those in prod BEFORE the build step can run
    // CREATE EXTENSION, causing "type vector does not exist" / "no default
    // operator class for hnsw" errors.
    //
    // Solution: keep dev free of pgvector-dependent objects.  In production the
    // build step runs with NODE_ENV=production and this script adds them after
    // the extension is already enabled (step 1 above).
    if (process.env.NODE_ENV === "production") {
      // 2. Create embedding column if missing.
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

      // 3. Create HNSW cosine index if missing.
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
    } else {
      console.log("  ✓ embedding column + HNSW index skipped (dev — pgvector objects are production-only)");
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
