/**
 * Tenant isolation integration test.
 *
 * Verifies that tenant B cannot access tenant A's notes via:
 *   1. GET /api/notes/:id  (getNoteById)
 *   2. POST /api/search    (ftsSearch / searchNotes)
 *   3. POST /api/context/build related-note expansion (findRelatedNoteIds / getNotesByIds)
 *   4. Cross-tenant note_links edge (regression: explicit link B→A must not expose A to B)
 *
 * Run with: pnpm --filter @workspace/api-server run test:isolation
 */

import assert from "node:assert/strict";
import { db, tenants, notes, rawItems, entities, noteEntities, noteLinks } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  ensureTenant,
  insertRawItem,
  insertNote,
  linkNoteEntities,
  upsertEntities,
  getNoteById,
  ftsSearch,
  getNotesByIds,
  findRelatedNoteIds,
} from "../repository.js";

const RUN_ID = Date.now().toString(36);
const SLUG_A = `test-tenant-a-${RUN_ID}`;
const SLUG_B = `test-tenant-b-${RUN_ID}`;

let tenantAId = "";
let tenantBId = "";
let noteAId = "";
let noteBId = "";

async function setup() {
  tenantAId = await ensureTenant(SLUG_A);
  tenantBId = await ensureTenant(SLUG_B);

  // Ingest one note into tenant A with a distinctive keyword.
  await db.transaction(async (tx) => {
    await insertRawItem(tx, {
      tenantId: tenantAId,
      text: "Secret project Zanzibar Alpha only",
    });
    const nA = await insertNote(tx, {
      tenantId: tenantAId,
      type: "note",
      title: "Zanzibar Alpha Secret",
      body: "This note belongs exclusively to tenant alpha and mentions zanzibar.",
      tags: ["secret", "alpha"],
    });
    noteAId = nA.id;
    const entsA = await upsertEntities(tx, tenantAId, [
      { type: "concept", name: "zanzibar" },
    ]);
    await linkNoteEntities(tx, nA.id, entsA.map((e) => e.id));
  });

  // Ingest one note into tenant B.
  await db.transaction(async (tx) => {
    await insertRawItem(tx, {
      tenantId: tenantBId,
      text: "Tenant B own content",
    });
    const nB = await insertNote(tx, {
      tenantId: tenantBId,
      type: "note",
      title: "Tenant B Note",
      body: "This note belongs to tenant beta.",
      tags: ["beta"],
    });
    noteBId = nB.id;
  });
}

async function testGetById() {
  // Tenant A can fetch its own note.
  const noteA = await getNoteById(noteAId, tenantAId);
  assert.ok(noteA, "Tenant A should be able to fetch its own note");
  assert.equal(noteA.id, noteAId);

  // Tenant B cannot fetch tenant A's note by id.
  const crossFetch = await getNoteById(noteAId, tenantBId);
  assert.equal(crossFetch, null, "Tenant B must NOT be able to fetch Tenant A's note by id");

  console.log("  ✓ getNoteById isolation");
}

async function testFtsSearch() {
  // Tenant A can find its note via FTS.
  const hitsA = await ftsSearch("zanzibar", { limit: 10, tenantId: tenantAId });
  const foundById = hitsA.some((h) => h.note.id === noteAId);
  assert.ok(foundById, "Tenant A should find its own note via FTS");

  // Tenant B gets no results for the same query.
  const hitsB = await ftsSearch("zanzibar", { limit: 10, tenantId: tenantBId });
  const leaked = hitsB.some((h) => h.note.id === noteAId);
  assert.equal(leaked, false, "Tenant B must NOT see Tenant A's note via FTS search");

  console.log("  ✓ ftsSearch isolation");
}

async function testRelatedExpansion() {
  // Simulate what buildContext does: seed = tenant B's notes, expand related.
  const related = await findRelatedNoteIds([noteBId], { limit: 20 }, tenantBId);
  const leaked = related.includes(noteAId);
  assert.equal(leaked, false, "findRelatedNoteIds must NOT return Tenant A's note when called as Tenant B");

  // Also verify getNotesByIds with a cross-tenant id returns nothing.
  const crossGet = await getNotesByIds([noteAId], tenantBId);
  assert.equal(crossGet.length, 0, "getNotesByIds must NOT return Tenant A's note when called as Tenant B");

  console.log("  ✓ related-note expansion isolation");
}

async function testCrossTenantNoteEntitiesRegression() {
  // Regression: inject a cross-tenant note_entities edge (B's note → A's entity).
  // This simulates a corrupt/malicious DB state.
  // The entity from tenant A must NOT appear on tenant B's note after attachEntities.
  const entsA = await db
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.tenantId, tenantAId));

  if (entsA.length > 0) {
    const crossEntityId = entsA[0].id;
    await db.insert(noteEntities).values({ noteId: noteBId, entityId: crossEntityId }).onConflictDoNothing();

    try {
      const noteB = await getNoteById(noteBId, tenantBId);
      assert.ok(noteB, "Tenant B should still fetch its own note");
      const leaked = noteB.entities.some((e) => e.id === crossEntityId);
      assert.equal(
        leaked,
        false,
        "Tenant A's entity must NOT appear on Tenant B's note even with a cross-tenant note_entities edge",
      );
    } finally {
      await db.delete(noteEntities).where(
        and(
          eq(noteEntities.noteId, noteBId),
          eq(noteEntities.entityId, crossEntityId),
        ),
      );
    }
    console.log("  ✓ cross-tenant note_entities edge regression");
  } else {
    console.log("  ~ cross-tenant note_entities regression skipped (no entities for tenant A)");
  }
}

async function testCrossTenantNoteLinksRegression() {
  // Regression: explicitly insert a cross-tenant note_links edge (B → A).
  // This simulates a corrupted or maliciously crafted DB state.
  // findRelatedNoteIds seeded with B's note must not return A's note.
  await db.insert(noteLinks).values({
    fromNoteId: noteBId,
    toNoteId: noteAId,
    relation: "related",
  });

  try {
    const related = await findRelatedNoteIds([noteBId], { limit: 20 }, tenantBId);
    const leaked = related.includes(noteAId);
    assert.equal(
      leaked,
      false,
      "findRelatedNoteIds must NOT return Tenant A's note even when a cross-tenant note_links edge exists",
    );
  } finally {
    // Clean up the cross-tenant link.
    await db.delete(noteLinks).where(
      eq(noteLinks.fromNoteId, noteBId),
    );
  }

  console.log("  ✓ cross-tenant note_links edge regression");
}

async function cleanup() {
  const noteIds = [noteAId, noteBId].filter(Boolean);
  if (noteIds.length > 0) {
    await db.delete(notes).where(inArray(notes.id, noteIds));
  }
  await db.delete(rawItems).where(inArray(rawItems.tenantId, [tenantAId, tenantBId]));
  await db.delete(entities).where(inArray(entities.tenantId, [tenantAId, tenantBId]));
  await db.delete(tenants).where(inArray(tenants.id, [tenantAId, tenantBId]));
}

async function main() {
  console.log("Running tenant isolation tests...");
  try {
    await setup();
    await testGetById();
    await testFtsSearch();
    await testRelatedExpansion();
    await testCrossTenantNoteEntitiesRegression();
    await testCrossTenantNoteLinksRegression();
    console.log("\nAll tenant isolation tests passed.");
  } finally {
    await cleanup();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\nTest failed:", err);
  process.exit(1);
});
