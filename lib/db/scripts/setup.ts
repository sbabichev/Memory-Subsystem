/**
 * One-shot database setup: idempotent, safe on databases with existing data.
 *
 * In DEVELOPMENT (NODE_ENV != "production"):
 *   1. Enable pgvector extension
 *   2. drizzle-kit push --force  (dev only — may prompt, no prod data at risk)
 *   3. setup-pgvector             (skips pgvector objects in dev)
 *   4. migrate-tenants            (backfill tenant_id, add FKs)
 *
 * In PRODUCTION (NODE_ENV == "production"):
 *   1. Enable pgvector extension
 *   2. Raw SQL: CREATE TABLE IF NOT EXISTS for tenants + entity_relations
 *      (drizzle-kit push is NOT used in prod: it prompts when existing rows
 *       would require truncation to add NOT NULL columns, causing aborts)
 *   3. setup-pgvector             (adds embedding column + HNSW index)
 *   4. migrate-tenants            (backfill tenant_id on existing rows, add FKs)
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
const isProd = process.env.NODE_ENV === "production";

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

async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function enableVector() {
  console.log("\n[setup] Step 1: Enabling pgvector extension...");
  await withClient(async (client) => {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    console.log("[setup]   ✓ pgvector extension enabled");
  });
}

/**
 * Production-only: create new tables via raw SQL instead of drizzle-kit push.
 * drizzle-kit push prompts interactively when it needs to truncate tables with
 * existing NOT NULL columns — which aborts in a non-TTY build environment.
 * The existing tables (notes, raw_items, entities, note_entities, note_links)
 * already exist in prod; we only need to create tenants and entity_relations.
 * tenant_id columns on existing tables are handled by migrate-tenants.ts.
 */
async function createMissingTablesProd() {
  console.log("\n[setup] Step 2 (prod): Creating missing tables via raw SQL...");
  await withClient(async (client) => {
    // tenants
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug       text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("[setup]   ✓ tenants table ready");

    // entity_relations
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_relations (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        from_entity_id uuid NOT NULL,
        to_entity_id   uuid NOT NULL,
        relation       text NOT NULL,
        source_note_id uuid,
        confidence     real NOT NULL DEFAULT 1,
        created_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Indexes (all idempotent via IF NOT EXISTS or DO-NOTHING pattern)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS entity_relations_unique_idx
        ON entity_relations (tenant_id, from_entity_id, to_entity_id, relation)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS entity_relations_from_idx
        ON entity_relations (tenant_id, from_entity_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS entity_relations_to_idx
        ON entity_relations (tenant_id, to_entity_id)
    `);
    console.log("[setup]   ✓ entity_relations table ready");
  });
}

async function main() {
  // Step 1: pgvector extension (required before any vector operations)
  await enableVector();

  if (isProd) {
    // Step 2 (prod): raw SQL table creation — safe with existing data
    await createMissingTablesProd();
  } else {
    // Step 2 (dev): drizzle-kit push handles full schema reconciliation
    run(
      "Step 2: drizzle-kit push --force",
      "pnpm run push-force",
    );
  }

  // Step 3: embedding column + HNSW index (prod only; skipped in dev)
  run(
    "Step 3: setup-pgvector (embedding + HNSW)",
    "pnpm run setup-pgvector",
  );

  // Step 4: backfill tenant_id on pre-existing rows; add FK constraints / indexes
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
