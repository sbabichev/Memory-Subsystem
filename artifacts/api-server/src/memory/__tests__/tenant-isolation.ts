/**
 * Tenant isolation integration test.
 *
 * Verifies that tenant B cannot access tenant A's notes via:
 *   1. GET /api/notes/:id  (getNoteById)
 *   2. POST /api/search    (ftsSearch / searchNotes)
 *   3. POST /api/context/build related-note expansion (findRelatedNoteIds / getNotesByIds)
 *   4. Cross-tenant note_links edge (regression: explicit link B→A must not expose A to B)
 *   5. Cross-tenant entity_relations edge (regression: upsertEntityRelations and graph expansion)
 *
 * Run with: pnpm --filter @workspace/api-server run test:isolation
 */

import assert from "node:assert/strict";
import { db, tenants, notes, rawItems, entities, noteEntities, noteLinks, entityRelations } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  ensureTenant,
  insertRawItem,
  insertNote,
  insertNoteLinks,
  linkNoteEntities,
  upsertEntities,
  upsertEntityRelations,
  getNoteById,
  ftsSearch,
  semanticSearch,
  getNotesByIds,
  findRelatedNoteIds,
  findOverlappingEntities,
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
  const leaked = related.some((h) => h.id === noteAId);
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

async function testSemanticSearchIsolation() {
  // Inject a real embedding vector into tenant A's note.
  // Then verify semantic search scoped to tenant B does NOT return it.
  const fakeEmbedding = new Array(1024).fill(0.5);
  const vectorLiteral = `[${fakeEmbedding.join(",")}]`;
  await db.execute(
    sql`UPDATE notes SET embedding = ${sql.raw(`'${vectorLiteral}'::vector`)} WHERE id = ${sql.raw(`'${noteAId}'::uuid`)}`,
  );

  // Query with the same embedding (cosine distance = 0, closest possible match)
  const hitsB = await semanticSearch(fakeEmbedding, { limit: 10, tenantId: tenantBId });
  const leaked = hitsB.some((h) => h.note.id === noteAId);
  assert.equal(leaked, false, "semanticSearch must NOT return Tenant A's note when scoped to Tenant B");

  // Tenant A can find its own note via semantic search
  const hitsA = await semanticSearch(fakeEmbedding, { limit: 10, tenantId: tenantAId });
  const foundOwn = hitsA.some((h) => h.note.id === noteAId);
  assert.ok(foundOwn, "Tenant A should find its own note via semantic search");

  console.log("  ✓ semanticSearch isolation");
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
    const leaked = related.some((h) => h.id === noteAId);
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

async function testEntityRelationsCrossTenantIsolation() {
  // Create entities in tenant A and tenant B.
  let entAId = "";
  let entBId = "";

  await db.transaction(async (tx) => {
    const entsA = await upsertEntities(tx, tenantAId, [
      { type: "organization", name: "AcmeCorp" },
    ]);
    entAId = entsA[0].id;
    const entsB = await upsertEntities(tx, tenantBId, [
      { type: "person", name: "Bob Beta" },
    ]);
    entBId = entsB[0].id;
  });

  // Attempt to upsert an entity relation in tenant B that crosses to tenant A's entity.
  // upsertEntityRelations should reject it since entAId belongs to tenant A.
  await db.transaction(async (tx) => {
    await upsertEntityRelations(
      tx,
      tenantBId,
      [{ fromEntityId: entBId, toEntityId: entAId, relation: "works_at", confidence: 0.9 }],
      noteBId,
    );
  });

  // Verify no cross-tenant edge was persisted.
  const crossEdges = await db
    .select()
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.fromEntityId, entBId),
        eq(entityRelations.toEntityId, entAId),
      ),
    );
  assert.equal(
    crossEdges.length,
    0,
    "upsertEntityRelations must NOT persist an edge where toEntityId belongs to a different tenant",
  );
  console.log("  ✓ upsertEntityRelations cross-tenant edge rejection");

  // Now create a valid entity relation within tenant A and verify it doesn't
  // appear when doing graph expansion for tenant B.
  let entA2Id = "";
  let noteA2Id = "";
  await db.transaction(async (tx) => {
    const entsA2 = await upsertEntities(tx, tenantAId, [
      { type: "person", name: "Alice Alpha" },
    ]);
    entA2Id = entsA2[0].id;
    // Create a second note in tenant A mentioning Alice Alpha.
    const nA2 = await insertNote(tx, {
      tenantId: tenantAId,
      type: "note",
      title: "Alice Alpha at AcmeCorp",
      body: "Alice Alpha works at AcmeCorp.",
      tags: [],
    });
    noteA2Id = nA2.id;
    await linkNoteEntities(tx, nA2.id, [entA2Id, entAId]);
    // Create a valid entity relation inside tenant A.
    await upsertEntityRelations(
      tx,
      tenantAId,
      [{ fromEntityId: entA2Id, toEntityId: entAId, relation: "works_at", confidence: 0.95 }],
      nA2.id,
    );
  });

  // Graph expansion for tenant B seeded with noteBId must NOT return noteA2Id.
  const related = await findRelatedNoteIds([noteBId], { limit: 20 }, tenantBId);
  const leaked = related.some((h) => h.id === noteA2Id || h.id === noteAId);
  assert.equal(
    leaked,
    false,
    "findRelatedNoteIds (entity-graph expansion) must NOT return Tenant A notes when called as Tenant B",
  );
  console.log("  ✓ entity-graph expansion cross-tenant isolation");

  // Cleanup extra notes/entities created in this test.
  if (noteA2Id) {
    await db.delete(notes).where(eq(notes.id, noteA2Id));
  }
}

async function testInsertNoteLinksRejectsCrossTenantEdge() {
  // Regression: insertNoteLinks must not persist edges where one endpoint
  // belongs to a different tenant, even if the LLM hallucinates such a pair.
  // We call insertNoteLinks as tenant B, passing a link from B's note → A's note.
  await db.transaction(async (tx) => {
    await insertNoteLinks(tx, tenantBId, [
      { fromId: noteBId, toId: noteAId, relation: "references" },
    ]);
  });

  // Verify the cross-tenant edge was NOT inserted.
  const rows = await db
    .select()
    .from(noteLinks)
    .where(
      and(
        eq(noteLinks.fromNoteId, noteBId),
        eq(noteLinks.toNoteId, noteAId),
      ),
    );
  assert.equal(
    rows.length,
    0,
    "insertNoteLinks must NOT persist a cross-tenant edge (B→A) when called as tenant B",
  );

  console.log("  ✓ insertNoteLinks cross-tenant edge rejection");
}

async function testFindOverlappingEntitiesIsolationAndOverlap() {
  // Seed: tenant A has "Alice Smith" (person) and "Replit" (organization).
  //       tenant B has "Alice Cooper" (person) and "Bobcat" (person).
  // Query (as tenant A) with new entities { person: "Alice", organization: "Replit Inc." }
  // Expectations:
  //   - Returns Alice Smith (substring overlap "alice" ⊂ "alice smith")
  //   - Returns Replit (substring overlap "replit" ⊂ "replit inc.")
  //   - Does NOT return Alice Cooper (belongs to tenant B)
  //   - Does NOT return Bobcat (belongs to tenant B)
  //   - Excludes IDs passed in excludeIds
  let aliceSmithId = "";
  let replitId = "";
  let aliceCooperId = "";
  await db.transaction(async (tx) => {
    const ents = await upsertEntities(tx, tenantAId, [
      { type: "person", name: "Alice Smith" },
      { type: "organization", name: "Replit" },
    ]);
    aliceSmithId = ents.find((e) => e.name === "Alice Smith")!.id;
    replitId = ents.find((e) => e.name === "Replit")!.id;
  });
  await db.transaction(async (tx) => {
    const ents = await upsertEntities(tx, tenantBId, [
      { type: "person", name: "Alice Cooper" },
      { type: "person", name: "Bobcat" },
    ]);
    aliceCooperId = ents.find((e) => e.name === "Alice Cooper")!.id;
  });

  const overlapping = await findOverlappingEntities(
    tenantAId,
    [
      { type: "person", name: "Alice" },
      { type: "organization", name: "Replit Inc." },
    ],
    [],
  );
  const overlappingIds = new Set(overlapping.map((e) => e.id));

  assert.ok(
    overlappingIds.has(aliceSmithId),
    "findOverlappingEntities must return Alice Smith via substring overlap on 'alice'",
  );
  assert.ok(
    overlappingIds.has(replitId),
    "findOverlappingEntities must return Replit via substring overlap on 'replit'",
  );
  assert.equal(
    overlappingIds.has(aliceCooperId),
    false,
    "findOverlappingEntities must NOT return tenant B's Alice Cooper when called as tenant A",
  );

  // excludeIds should drop Alice Smith from the result.
  const withExclude = await findOverlappingEntities(
    tenantAId,
    [{ type: "person", name: "Alice" }],
    [aliceSmithId],
  );
  assert.equal(
    withExclude.some((e) => e.id === aliceSmithId),
    false,
    "findOverlappingEntities must honor excludeIds",
  );

  // Type mismatch: querying for organization "Alice" should NOT return person Alice Smith.
  const typeMismatch = await findOverlappingEntities(
    tenantAId,
    [{ type: "organization", name: "Alice" }],
    [],
  );
  assert.equal(
    typeMismatch.some((e) => e.id === aliceSmithId),
    false,
    "findOverlappingEntities must not cross entity types",
  );

  // Names below minNameLen (default 3) are skipped.
  const tooShort = await findOverlappingEntities(
    tenantAId,
    [{ type: "person", name: "Al" }],
    [],
  );
  assert.equal(
    tooShort.length,
    0,
    "findOverlappingEntities must skip names shorter than minNameLen",
  );

  // Ordering: exact match wins, then closest length.
  // Seed two extra person entities so we can verify the ORDER BY picks
  // the exact match first and the closest-length variant second.
  let aliceExactId = "";
  let aliceLongId = "";
  await db.transaction(async (tx) => {
    const ents = await upsertEntities(tx, tenantAId, [
      { type: "person", name: "Alice" },
      { type: "person", name: "Alice Smith Junior The Third" },
    ]);
    aliceExactId = ents.find((e) => e.name === "Alice")!.id;
    aliceLongId = ents.find((e) => e.name === "Alice Smith Junior The Third")!.id;
  });

  const ordered = await findOverlappingEntities(
    tenantAId,
    [{ type: "person", name: "Alice" }],
    [],
    { limit: 10 },
  );
  // Expected order: Alice (exact, score 0), then by length-diff: Alice Smith
  // (closest), Alice Smith Junior The Third (farthest).
  const orderedIds = ordered.map((e) => e.id);
  assert.equal(
    orderedIds[0],
    aliceExactId,
    "findOverlappingEntities must rank exact match first",
  );
  const exactIdx = orderedIds.indexOf(aliceExactId);
  const smithIdx = orderedIds.indexOf(aliceSmithId);
  const longIdx = orderedIds.indexOf(aliceLongId);
  assert.ok(
    exactIdx < smithIdx && smithIdx < longIdx,
    `expected order Alice < Alice Smith < Alice Smith Junior The Third, got [${orderedIds.join(", ")}]`,
  );

  console.log("  ✓ findOverlappingEntities tenant isolation, overlap, type, exclude, min-length, ordering");
}

async function cleanup() {
  // Clean up entity_relations for both tenants first (FK refs entities).
  await db.delete(entityRelations).where(inArray(entityRelations.tenantId, [tenantAId, tenantBId]));
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
    await testSemanticSearchIsolation();
    await testCrossTenantNoteLinksRegression();
    await testInsertNoteLinksRejectsCrossTenantEdge();
    await testEntityRelationsCrossTenantIsolation();
    await testFindOverlappingEntitiesIsolationAndOverlap();
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
