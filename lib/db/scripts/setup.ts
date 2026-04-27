/**
 * One-shot database setup: idempotent, runs in the correct order.
 *
 * Steps:
 *   1. Enable the `vector` (pgvector) extension — must come before push so
 *      the `vector(1024)` column type is available.
 *   2. `drizzle-kit push --force` — create / reconcile all tables.
 *   3. `pnpm run setup-pgvector` — verify embedding column and create the
 *      HNSW cosine index.
 *   4. `pnpm run migrate` — create tenants table, backfill tenant_id on
 *      pre-existing rows, add FK constraints and indexes.
 *
 * Every step is idempotent — safe to re-run on any environment, including
 * one that is already fully migrated.
 *
 * Usage:
 *   pnpm --filter @workspace/db run setup
 */

import pg from "pg";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbRoot = path.resolve(__dirname, "..");

function run(label: string, command: string) {
  console.log(`\n[setup] ${label}`);
  try {
    execSync(command, {
      cwd: dbRoot,
      stdio: "inherit",
      env: { ...process.env },
    });
  } catch {
    console.error(`[setup] ${label} failed — aborting.`);
    process.exit(1);
  }
}

async function enableVector() {
  console.log("\n[setup] Step 1: Enabling pgvector extension...");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      console.log("[setup]   ✓ pgvector extension enabled");
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  // 1. Enable extension first so drizzle-kit push can handle vector columns.
  await enableVector();

  // 2. Push schema (create / reconcile tables and columns).
  run(
    "Step 2: drizzle-kit push --force",
    "pnpm run push-force",
  );

  // 3. Create the HNSW cosine index (idempotent).
  run(
    "Step 3: setup-pgvector (HNSW index)",
    "pnpm run setup-pgvector",
  );

  // 4. Backfill tenant_id on pre-existing rows; add FK constraints / indexes.
  run(
    "Step 4: migrate-tenants",
    "pnpm run migrate",
  );

  console.log("\n[setup] ✓ Database setup complete.");
}

main().catch((err) => {
  console.error("[setup] Unexpected error:", err);
  process.exit(1);
});
