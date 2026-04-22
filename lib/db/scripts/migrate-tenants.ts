/**
 * Migration script: per-tenant isolation
 *
 * This script must be run BEFORE `drizzle-kit push` adds the NOT NULL
 * constraint on tenant_id, because it:
 *   1. Creates the `tenants` table if it doesn't exist.
 *   2. Inserts the "default" tenant.
 *   3. Adds nullable `tenant_id` columns to existing tables (raw_items, notes, entities).
 *   4. Backfills all existing rows with the default tenant id.
 *   5. Makes `tenant_id` NOT NULL on each table.
 *   6. Drops and recreates the entities unique index to include tenant_id.
 *   7. Adds supporting indexes on tenant_id.
 *   8. Adds FK constraints from tenant_id to tenants.id.
 *
 * Running this script on an already-migrated database is safe — every step
 * is idempotent.
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
    await client.query("BEGIN");

    // 1. Create tenants table if it doesn't exist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug       text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // 2. Insert the default tenant (idempotent via ON CONFLICT DO NOTHING).
    const { rows: tenantRows } = await client.query<{ id: string }>(`
      INSERT INTO tenants (slug)
      VALUES ('default')
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `);

    // Fetch the default tenant id whether or not we just inserted it.
    let defaultTenantId: string;
    if (tenantRows.length > 0) {
      defaultTenantId = tenantRows[0].id;
    } else {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM tenants WHERE slug = 'default'",
      );
      defaultTenantId = rows[0].id;
    }
    console.log(`Default tenant id: ${defaultTenantId}`);

    // Helper: check whether a column already exists.
    async function columnExists(table: string, column: string): Promise<boolean> {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = $1 AND column_name = $2
         ) AS exists`,
        [table, column],
      );
      return rows[0].exists;
    }

    // Helper: add nullable tenant_id, backfill, make NOT NULL, add FK + index.
    async function addTenantId(table: string) {
      const exists = await columnExists(table, "tenant_id");
      if (!exists) {
        console.log(`Adding tenant_id to ${table}...`);
        await client.query(
          `ALTER TABLE ${table} ADD COLUMN tenant_id uuid`,
        );
      }

      // Backfill any NULL rows (idempotent).
      await client.query(
        `UPDATE ${table} SET tenant_id = $1 WHERE tenant_id IS NULL`,
        [defaultTenantId],
      );

      // Make NOT NULL if not already.
      const { rows: colRows } = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      if (colRows[0]?.is_nullable === "YES") {
        console.log(`Setting tenant_id NOT NULL on ${table}...`);
        await client.query(
          `ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`,
        );
      }

      // Add FK constraint if it doesn't exist.
      const fkName = `${table}_tenant_id_fkey`;
      const { rows: fkRows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.table_constraints
           WHERE constraint_name = $1 AND table_name = $2
         ) AS exists`,
        [fkName, table],
      );
      if (!fkRows[0].exists) {
        console.log(`Adding FK constraint on ${table}.tenant_id...`);
        await client.query(
          `ALTER TABLE ${table}
           ADD CONSTRAINT ${fkName}
           FOREIGN KEY (tenant_id) REFERENCES tenants(id)`,
        );
      }

      // Add supporting index if it doesn't exist.
      const idxName = `${table}_tenant_idx`;
      const { rows: idxRows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE tablename = $1 AND indexname = $2
         ) AS exists`,
        [table, idxName],
      );
      if (!idxRows[0].exists) {
        console.log(`Creating index ${idxName}...`);
        await client.query(
          `CREATE INDEX ${idxName} ON ${table} (tenant_id)`,
        );
      }
    }

    // 3-7. Add tenant_id to each table.
    await addTenantId("raw_items");
    await addTenantId("notes");
    await addTenantId("entities");

    // 8. Update the entities unique index to be per-tenant.
    //    Drop the old (type, normalized_name) index and recreate as
    //    (tenant_id, type, normalized_name).
    const { rows: oldIdxRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE tablename = 'entities' AND indexname = 'entities_type_name_idx'
       ) AS exists`,
    );
    if (oldIdxRows[0].exists) {
      // Check whether the existing index already covers tenant_id.
      const { rows: colsRows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'entities' AND indexname = 'entities_type_name_idx'`,
      );
      const alreadyHasTenant = colsRows[0]?.indexdef?.includes("tenant_id");
      if (!alreadyHasTenant) {
        console.log("Recreating entities_type_name_idx to include tenant_id...");
        await client.query(`DROP INDEX entities_type_name_idx`);
        await client.query(
          `CREATE UNIQUE INDEX entities_type_name_idx
           ON entities (tenant_id, type, normalized_name)`,
        );
      }
    } else {
      // Index doesn't exist at all; create it.
      console.log("Creating entities_type_name_idx...");
      await client.query(
        `CREATE UNIQUE INDEX entities_type_name_idx
         ON entities (tenant_id, type, normalized_name)`,
      );
    }

    await client.query("COMMIT");
    console.log("Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed, rolled back:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
