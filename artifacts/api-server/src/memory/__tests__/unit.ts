/**
 * Unit tests for:
 * 1. RRF fusion (rrfFuse)
 * 2. Voyage client (mocked HTTP, retry behavior, batching)
 * 3. Ingest-still-succeeds-when-Voyage-fails
 *
 * Run with: pnpm --filter @workspace/api-server run test:unit
 */

import assert from "node:assert/strict";
import { rrfFuse, type SearchHitRow } from "../repository.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHit(id: string, score = 1): SearchHitRow {
  return {
    note: {
      id,
      type: "note",
      title: `Note ${id}`,
      body: `Body ${id}`,
      summary: null,
      tags: [],
      sourceItemId: null,
      createdAt: new Date(),
      entities: [],
    },
    score,
  };
}

// ---------------------------------------------------------------------------
// 1. RRF fusion tests
// ---------------------------------------------------------------------------

function testRrfFuse() {
  console.log("  Testing rrfFuse...");

  // Empty inputs
  const empty = rrfFuse([], [], 10);
  assert.equal(empty.length, 0, "empty inputs → empty output");

  // Single list passthrough
  const ftsOnly = [makeHit("a"), makeHit("b"), makeHit("c")];
  const result1 = rrfFuse(ftsOnly, [], 10);
  assert.equal(result1.length, 3, "single-list passthrough returns all hits");
  assert.equal(result1[0].note.id, "a", "top FTS hit should still be first");

  // Duplicate note present in both lists gets boosted
  const fts = [makeHit("x"), makeHit("y")];
  const sem = [makeHit("x"), makeHit("z")];
  const fused = rrfFuse(fts, sem, 10);
  assert.equal(fused[0].note.id, "x", "note appearing in both lists should be ranked first");
  assert.equal(fused.length, 3, "unique notes: x, y, z");

  // Limit is respected
  const many = Array.from({ length: 10 }, (_, i) => makeHit(`note-${i}`));
  const limited = rrfFuse(many, [], 3);
  assert.equal(limited.length, 3, "limit is respected");

  // RRF score is higher when note appears in both lists
  const aFts = [makeHit("shared"), makeHit("fts-only")];
  const aSem = [makeHit("shared"), makeHit("sem-only")];
  const fr = rrfFuse(aFts, aSem, 10);
  const sharedEntry = fr.find((h) => h.note.id === "shared")!;
  const ftsOnlyEntry = fr.find((h) => h.note.id === "fts-only")!;
  assert.ok(sharedEntry.score > ftsOnlyEntry.score, "shared hit has higher RRF score than single-list hit");

  // Order: verify rank-based (position 0 vs 1)
  const fts2 = [makeHit("rank1"), makeHit("rank2")];
  const sem2 = [makeHit("rank2"), makeHit("rank1")];
  const r2 = rrfFuse(fts2, sem2, 10);
  // Both appear in both — rank1 is pos 0 in fts and pos 1 in sem, rank2 is pos 1 in fts and pos 0 in sem
  // RRF(rank1) = 1/(60+1) + 1/(60+2) = 0.016393 + 0.016129 = 0.032522
  // RRF(rank2) = 1/(60+2) + 1/(60+1) = same → tie; order is insertion order
  assert.ok(r2.length === 2, "both notes present");

  console.log("  ✓ rrfFuse: all assertions passed");
}

// ---------------------------------------------------------------------------
// 2. Voyage client mocked HTTP tests
// ---------------------------------------------------------------------------

async function testVoyageClientMocked() {
  console.log("  Testing voyage-client (mocked HTTP)...");

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.VOYAGE_API_KEY;

  // Ensure key is set
  process.env.VOYAGE_API_KEY = "test-key";

  // Helper: install a mock fetch that returns a fixed response
  function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
    let callCount = 0;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const resp = responses[Math.min(callCount, responses.length - 1)];
      callCount++;
      return new Response(JSON.stringify(resp.body), {
        status: resp.status,
        headers: { "content-type": "application/json", ...(resp.headers ?? {}) },
      });
    };
    return () => { globalThis.fetch = originalFetch; };
  }

  // Test 1: happy path single embed
  {
    const cleanup = mockFetch([{
      status: 200,
      body: {
        data: [{ embedding: Array.from({ length: 1024 }, (_, i) => i / 1024) }],
        usage: { total_tokens: 42 },
      },
    }]);
    const { embedText } = await import("../voyage-client.js");
    const result = await embedText("hello world", "document");
    assert.equal(result.embedding.length, 1024, "embedding has 1024 dims");
    assert.equal(result.totalTokens, 42, "token count preserved");
    cleanup();
  }

  // Test 2: 429 retry then success
  {
    let callCount = 0;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({
        data: [{ embedding: new Array(1024).fill(0.1) }],
        usage: { total_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { embedText } = await import("../voyage-client.js");
    const result = await embedText("retry test", "query");
    assert.equal(result.embedding.length, 1024, "retry succeeds and returns correct embedding");
    assert.equal(callCount, 2, "exactly 2 fetch calls (1 retry)");
    globalThis.fetch = originalFetch;
  }

  // Test 3: batching — two texts → one call if within batch limit
  {
    let callCount = 0;
    let capturedBody: unknown;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount++;
      capturedBody = JSON.parse(init?.body as string ?? "{}");
      return new Response(JSON.stringify({
        data: [
          { embedding: new Array(1024).fill(0.1) },
          { embedding: new Array(1024).fill(0.2) },
        ],
        usage: { total_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { embedBatch } = await import("../voyage-client.js");
    const result = await embedBatch(["text one", "text two"], "document");
    assert.equal(callCount, 1, "two texts sent in one call");
    assert.equal(result.embeddings.length, 2, "two embeddings returned");
    assert.ok(Array.isArray((capturedBody as { input: unknown }).input), "input is array");
    assert.equal((capturedBody as { input: string[] }).input.length, 2, "two inputs in request");
    globalThis.fetch = originalFetch;
  }

  // Test 4: network error → throws after retries
  {
    let callCount = 0;
    globalThis.fetch = async (): Promise<Response> => {
      callCount++;
      throw new Error("network failure");
    };

    const { embedText } = await import("../voyage-client.js");
    await assert.rejects(
      () => embedText("fail test", "document"),
      (err: Error) => {
        assert.ok(err.message.includes("network failure"), "throws network error");
        return true;
      },
    );
    assert.ok(callCount > 1, `retried ${callCount} times on network failure`);
    globalThis.fetch = originalFetch;
  }

  // Restore env
  if (originalKey === undefined) {
    delete process.env.VOYAGE_API_KEY;
  } else {
    process.env.VOYAGE_API_KEY = originalKey;
  }

  console.log("  ✓ voyage-client: all mocked HTTP assertions passed");
}

// ---------------------------------------------------------------------------
// 3. Ingest-still-succeeds-when-Voyage-fails
//    Calls ingestText() with Voyage HTTP always failing; the ingest should
//    succeed (returning notes) and the note should have embedding = NULL in DB.
// ---------------------------------------------------------------------------

async function testIngestSucceedsWhenVoyageFails() {
  console.log("  Testing ingest-still-succeeds when Voyage fails...");

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.VOYAGE_API_KEY;

  // Set a fake key so the client attempts to call Voyage
  process.env.VOYAGE_API_KEY = "fake-key-for-test";

  // Intercept fetch: let non-Voyage calls (Gemini, etc.) through if needed,
  // but always fail Voyage requests
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : (url as Request).url;
    if (href.includes("voyageai.com")) {
      throw new Error("Voyage AI is down (mocked for test)");
    }
    return originalFetch(url, init);
  };

  const { ingestText } = await import("../services.js");
  const { db, notes } = await import("@workspace/db");
  const { eq, sql } = await import("drizzle-orm");

  const RUN_ID = Date.now().toString(36);
  const testSlug = `ingest-failure-test-${RUN_ID}`;

  let result: Awaited<ReturnType<typeof ingestText>> | undefined;
  let ingestError: unknown;
  try {
    result = await ingestText({ text: "Test note for embed-failure isolation smoke test." }, testSlug);
  } catch (err) {
    ingestError = err;
  }

  assert.equal(ingestError, undefined, "ingestText must NOT throw when Voyage fails");
  assert.ok(result, "ingestText must return a result");
  assert.ok(Array.isArray(result.notes) && result.notes.length > 0, "ingest must produce at least one note");

  // Verify embedding IS NULL for the created notes (Voyage failed)
  for (const note of result.notes) {
    const [row] = await db.select({ embedding: sql<string | null>`"embedding"` }).from(notes).where(eq(notes.id, note.id)).limit(1);
    assert.equal(row?.embedding, null, `Note ${note.id} must have embedding = NULL when Voyage fails`);
  }

  // Cleanup (order matters due to FK: notes + entities + rawItems before tenants)
  const { db: dbClean, notes: notesClean, entities: entitiesTable, tenants: tenantsTable, rawItems: rawItemsTable } = await import("@workspace/db");
  const tenantRows = await dbClean.select().from(tenantsTable).where(eq(tenantsTable.slug, testSlug));
  if (tenantRows.length > 0) {
    const tid = tenantRows[0].id;
    await dbClean.delete(notesClean).where(eq(notesClean.tenantId, tid));
    await dbClean.delete(entitiesTable).where(eq(entitiesTable.tenantId, tid));
    await dbClean.delete(rawItemsTable).where(eq(rawItemsTable.tenantId, tid));
    await dbClean.delete(tenantsTable).where(eq(tenantsTable.id, tid));
  }

  // Restore
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) {
    delete process.env.VOYAGE_API_KEY;
  } else {
    process.env.VOYAGE_API_KEY = originalKey;
  }

  console.log("  ✓ ingest-still-succeeds: ingestText completes and notes have embedding=NULL when Voyage is down");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Running unit tests...\n");

  testRrfFuse();
  await testVoyageClientMocked();
  await testIngestSucceedsWhenVoyageFails();

  console.log("\nAll unit tests passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nUnit test failed:", err);
  process.exit(1);
});
