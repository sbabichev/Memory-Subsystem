# Archivist ↔ Memory Subsystem Integration Contract

This document is the integration contract between the **Archivist Core** broker and the **Memory Subsystem** (this repo's `artifacts/api-server`). It is grounded in the actual code under `artifacts/api-server/src` as of this writing. Anything not directly verifiable in code is explicitly marked **inferred** or **unknown**.

---

## 1. Overview

The Memory Subsystem is an HTTP service that:

- Accepts raw text from a caller, classifies it into 1–3 structured **notes** using an LLM, extracts named entities, persists everything in Postgres, and (best-effort) writes a markdown export to disk.
- Lets callers fetch a note by id, run a keyword search over notes, and assemble a **context bundle** (markdown blob ready to feed to a downstream agent) by combining direct keyword hits with related notes (via explicit `note_links` and shared entities).

It does **not**:

- Expose update or delete endpoints. The only writes happen as a side effect of `POST /api/ingest/text` and `POST /api/context/build` (when `synthesize=true` produces a `synthesis` note).
- Stream. All responses are single JSON payloads.

**Role in the larger architecture:** Archivist Core is the broker / router. It decides, per user turn, whether to *save* something into memory, *look something up*, or *assemble context* for a downstream reasoning step, then calls one of the four memory endpoints below. The Memory Subsystem owns persistence, classification, and retrieval; Archivist owns intent routing and conversation state.

---

## 2. Authentication and Tenant Isolation

- All `/api/*` routes **except** `GET /api/healthz` require an API key. See `src/routes/index.ts`:
  ```ts
  router.use(healthRouter);                 // public
  router.use(requireApiKey(), memoryRouter); // protected
  ```
- Header format (see `src/middlewares/apiKey.ts`):
  ```
  Authorization: Bearer <API_KEY>
  ```
- The middleware resolves the bearer token to a **tenant slug**. Every read and write is then automatically scoped to that tenant — cross-tenant access is impossible by construction (enforced at the repository layer via `tenant_id` FK on all tables).
- Comparison is constant-time (length check + XOR loop) to avoid trivial timing leaks.

### Key → Tenant configuration

Two mutually compatible environment variables control the mapping:

| Variable | Format | Behavior |
| -------- | ------ | -------- |
| `MEMORY_API_KEYS` | JSON object `{"<key>":"<tenant-slug>",...}` | Multi-tenant: each key maps to a distinct tenant. |
| `MEMORY_API_KEY`  | plain string | Single-tenant backward-compat: the key maps to the `"default"` tenant. |

Both may be set simultaneously. If a key appears in `MEMORY_API_KEYS`, that mapping takes precedence; `MEMORY_API_KEY` is then used as a fallback for the `"default"` tenant only if it is not already listed. If **neither** variable is set the server **refuses to start** (fail-closed).

**Single-key setup (existing deployments — no change required):**
```sh
MEMORY_API_KEY=my-secret-key
```
All data is stored under the `"default"` tenant.

**Multi-key setup:**
```sh
MEMORY_API_KEYS='{"key-for-alice":"alice","key-for-bob":"bob"}'
```
Alice and Bob each see only their own notes; there is no shared store.

### Tenant provisioning

Tenant records are created on demand: the first request from an unknown slug automatically inserts a row in the `tenants` table. No admin step is required when adding a new key to `MEMORY_API_KEYS`.

### Productization note

This isolation primitive is designed for single-database multi-tenant deployments (e.g. multiple Archivist instances pointing at a shared Memory Subsystem). For paid product use, a **separate database per customer** is still the recommended approach — the `tenant_id` isolation makes a future migration straightforward but does not replace DB-level separation.

### Failure modes (HTTP 401)

- Missing `Authorization` header, or it does not start with `Bearer ` → `{"error":"Missing or invalid Authorization header"}`
- Token present but does not match any configured key → `{"error":"Invalid API key"}`

| Endpoint                  | Auth required |
| ------------------------- | ------------- |
| `GET  /api/healthz`       | No            |
| `POST /api/ingest/text`   | Yes           |
| `GET  /api/notes/:id`     | Yes           |
| `POST /api/search`        | Yes           |
| `POST /api/context/build` | Yes           |

---

## 3. Endpoints

The base URL is whatever host:port the API server is published at; all paths are prefixed with `/api` (see `src/app.ts`: `app.use("/api", router)`).

All schemas below are taken verbatim from `lib/api-zod/src/generated/api.ts`, which is the generated zod source of truth used by `src/routes/memory.ts`. On a `ZodError` the server returns `400 {"error":"Invalid request"}`. Any other thrown error → `500 {"error":"Internal server error"}` (details are logged server-side, never returned). Note: the request schemas are *not* `.strict()`, so unknown extra fields are silently stripped rather than rejected — do not rely on the server flagging typos in request bodies.

### 3.1 `POST /api/ingest/text`

**Purpose.** Accept a raw text item, classify it into 1–3 notes via LLM, extract entities, persist, and return the inserted notes.

**Request body**
| Field    | Type             | Required | Notes                                                     |
| -------- | ---------------- | -------- | --------------------------------------------------------- |
| `text`   | string (min 1)   | yes      | The raw text to ingest.                                   |
| `source` | string \| null   | no       | Free-form label, e.g. `"chat"`, `"email"`.                |
| `author` | string \| null   | no       | Free-form author label.                                   |

**Response body** (`IngestTextResponse`)
```jsonc
{
  "rawItemId": "uuid",
  "notes": [
    {
      "id": "uuid",
      "type": "raw_source" | "note" | "insight" | "decision" | "synthesis" | "entity",
      "title": "string",
      "body": "string",
      "summary": "string | null",
      "tags": ["string", "..."],
      "sourceItemId": "uuid | null",
      "createdAt": "ISO-8601 datetime",
      "entities": [
        { "id": "uuid", "type": "person|project|concept|...", "name": "string" }
      ]
    }
  ]
}
```

**Example request**
```bash
curl -X POST "$BASE/api/ingest/text" \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Decided to migrate the broker to Postgres advisory locks instead of Redis.",
    "source": "chat",
    "author": "alex"
  }'
```

**Example response**
```json
{
  "rawItemId": "8f2c7c0a-2a1c-4c6a-9a3d-18cf8b5d3c11",
  "notes": [
    {
      "id": "1d2e3f40-aaaa-bbbb-cccc-1234567890ab",
      "type": "decision",
      "title": "Migrate broker to Postgres advisory locks",
      "body": "We will replace Redis-based locking in the broker with Postgres advisory locks to reduce moving parts.",
      "summary": "Switch broker locking from Redis to Postgres advisory locks.",
      "tags": ["broker", "postgres", "locking"],
      "sourceItemId": "8f2c7c0a-2a1c-4c6a-9a3d-18cf8b5d3c11",
      "createdAt": "2026-04-20T12:34:56.000Z",
      "entities": [
        { "id": "e1...", "type": "concept", "name": "Postgres advisory locks" },
        { "id": "e2...", "type": "project", "name": "broker" }
      ]
    }
  ]
}
```

**Common failure cases**
- `400` — body fails schema validation (e.g. missing/empty `text`).
- `401` — missing or wrong API key.
- `500` — DB error, classifier produced unrecoverable output, etc. (Internals not leaked.)

Notes:
- `notes` is **typically 1–3 entries**. The LLM is prompted to produce 1–3 notes; if Gemini is not configured (`isGeminiConfigured()` false) or the call fails / returns unparsable output, a stub LLM falls back to a single `note` whose body is the input text and whose title is the first non-empty line truncated to 80 chars (see `src/memory/llm.ts` `StubLLMClient`). The Gemini path is *not* hard-capped to 3 entries server-side, and post-validation filtering (entries missing `title`/`body`) could in principle leave the array empty — callers should defensively handle a `notes: []` response rather than assume non-empty.
- Entity extraction is best-effort; an empty `entities` array is normal.
- Markdown export to disk (`MEMORY_MD_DIR`, default `.data/notes`) is best-effort and runs after the DB transaction. A failure there only logs a warning and does not affect the response.

### 3.2 `GET /api/notes/:id`

**Purpose.** Fetch a single note (with attached entities) by its uuid.

**Path params**
| Field | Type   | Notes |
| ----- | ------ | ----- |
| `id`  | string | The note id. Schema is `z.coerce.string()`; in practice the DB stores uuids. |

**Response body** — same shape as one element of `IngestTextResponse.notes` (a `Note`).

**Example**
```bash
curl "$BASE/api/notes/1d2e3f40-aaaa-bbbb-cccc-1234567890ab" \
  -H "Authorization: Bearer $MEMORY_API_KEY"
```

**Failure cases**
- `404 {"error":"Note not found"}` if no row matches the id.
- `400` if the param fails schema validation.
- `401` / `500` as above.

### 3.3 `POST /api/search`

**Purpose.** Lexical search over notes; returns ranked hits.

**Request body** (`SearchNotesBody`)
| Field   | Type                       | Required | Default | Notes                                                                 |
| ------- | -------------------------- | -------- | ------- | --------------------------------------------------------------------- |
| `query` | string (min 1)             | yes      | —       | Free-text query.                                                      |
| `limit` | number (1–50)              | no       | `10`    | Max hits returned.                                                    |
| `types` | array of note `type` enum  | no       | null    | Restrict to a subset of note types.                                   |

**Response body** (`SearchNotesResponse`)
```jsonc
{
  "query": "string (echo of input)",
  "interpretedQuery": "string | null",   // LLM-rewritten, only when MEMORY_LLM_INTERPRET_QUERY=true
  "hits": [
    { "note": { /* Note */ }, "score": 0.0 }
  ]
}
```

**Example request**
```bash
curl -X POST "$BASE/api/search" \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "broker locking", "limit": 5, "types": ["decision","insight"] }'
```

**Example response**
```json
{
  "query": "broker locking",
  "interpretedQuery": null,
  "hits": [
    {
      "note": { "id": "1d2e3f40-...", "type": "decision", "title": "Migrate broker to Postgres advisory locks", "...": "..." },
      "score": 0.187
    }
  ]
}
```

**Failure cases**
- `400` — schema validation (e.g. empty query, `limit` > 50, unknown `type`).
- `401` / `500` as above.
- A *successful empty result* is `200` with `"hits": []` — **not** a 404.

### 3.4 `POST /api/context/build`

**Purpose.** Produce a context bundle for a downstream agent: direct keyword hits + related notes (via `note_links` and shared entities) + a concatenated markdown blob, optionally plus an LLM-synthesized note.

**Request body** (`BuildContextBody`)
| Field         | Type                       | Required | Default | Notes                                                                                                              |
| ------------- | -------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `query`       | string (min 1)             | yes      | —       | What we want context about.                                                                                        |
| `limit`       | number (1–50)              | no       | `8`     | Max *direct* hits. Related-notes budget is `max(2, floor(limit/2))`.                                               |
| `types`       | array of note `type` enum  | no       | null    | Restrict direct hits to these types. (Related notes are not type-filtered.)                                        |
| `synthesize`  | boolean                    | no       | `false` | If true *and* `MEMORY_LLM_SYNTHESIZE=true` server-side, produce a `synthesis` note from the bundle and persist it. |

**Response body** (`BuildContextResponse`)
```jsonc
{
  "query": "string",
  "interpretedQuery": "string | null",
  "hits": [
    {
      "note": { /* Note */ },
      "score": 0.0,
      "via": "direct" | "related"   // related notes have score=0
    }
  ],
  "bundleMarkdown": "string",       // concatenated markdown of all selected notes
  "synthesisNote": { /* Note */ } | null
}
```

**Example request**
```bash
curl -X POST "$BASE/api/context/build" \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "what did we decide about broker locking?", "limit": 6, "synthesize": false }'
```

**Example response (truncated)**
```json
{
  "query": "what did we decide about broker locking?",
  "interpretedQuery": null,
  "hits": [
    { "note": { "id": "1d2e3f40-...", "type": "decision", "title": "Migrate broker to Postgres advisory locks" }, "score": 0.187, "via": "direct" },
    { "note": { "id": "9a...", "type": "note", "title": "Redis lock failure post-mortem" }, "score": 0, "via": "related" }
  ],
  "bundleMarkdown": "---\nid: 1d2e3f40-...\ntype: decision\n...\n---\n\n# Migrate broker to Postgres advisory locks\n\n...",
  "synthesisNote": null
}
```

**Failure cases**
- `400` — schema validation.
- `401` / `500` as above.
- A *zero-result query* still returns `200` with empty `hits` and `bundleMarkdown: ""`. Archivist must handle this explicitly.

### 3.5 `GET /api/healthz`

**Purpose.** Liveness probe. Public.

**Response**
```json
{ "status": "ok" }
```

No failure cases other than the server being unreachable.

---

## 4. Runtime Semantics

### 4.1 Ingest (`POST /api/ingest/text`)

Sequence in `src/memory/services.ts` `ingestText`:

1. **LLM classification (required step, but with fallback).** `llm.classifyNotes(text, {source, author})` is called *outside* the DB transaction. If Gemini is configured and the call succeeds, you get 1–3 structured notes. If Gemini is not configured or the call fails / produces unparsable output, the stub LLM returns a single `note` containing the verbatim input.
2. **LLM entity extraction (best-effort).** For each classified note, `llm.extractEntities(note.body)`. Failures return `[]`.
3. **DB transaction.** Insert one `raw_items` row, then for each note: insert `notes` row, upsert `entities` (dedup by `(type, normalized_name)`), link via `note_entities`.
4. **Markdown export (best-effort, post-transaction).** Each note is written to a markdown file in `MEMORY_MD_DIR` (default `.data/notes`); the resulting relative path is stored in `notes.markdownPath`. Disk failures only log a warning.

### 4.2 Search (`POST /api/search`)

`src/memory/services.ts` `searchNotes`:

1. **Optional query interpretation.** `llm.interpretQuery(query)` runs only if `MEMORY_LLM_INTERPRET_QUERY=true`; otherwise it returns `null`. If a rewrite is produced it is used as the effective query *and* echoed back in `interpretedQuery`.
2. **Retrieval.** `KeywordRetriever.search` → `ftsSearch`:
   - Query is split on whitespace and joined with ` OR `, unless it contains a `"` (then passed through to `websearch_to_tsquery` as-is).
   - Postgres FTS via `websearch_to_tsquery('english', ...)` against `notes.search_vector`, ranked by `ts_rank`.
   - **Fallback:** if FTS returns zero rows, an `ILIKE '%query%'` match on `title` or `body` is run, ordered by `createdAt desc`, with all hits assigned `score: 0.01`.
   - Optional `types` filter is applied as `notes.type IN (...)` in both branches.
3. Limit is `input.limit ?? 10` (zod also defaults to 10 and caps at 50).

"Search" today therefore means: **lexical keyword match (FTS with OR-broadening) with an ILIKE substring fallback** — not semantic similarity.

### 4.3 Build Context (`POST /api/context/build`)

`src/memory/services.ts` `buildContext`:

1. Optional query interpretation (same flag as search).
2. **Direct retrieval.** Same `KeywordRetriever.search` as `/api/search`, with `limit` (default 8).
3. **Expansion via `findRelatedNoteIds`** (`src/memory/repository.ts`), budget `max(2, floor(limit/2))`:
   - Notes connected to seed notes via the explicit `note_links` table (either direction).
   - Notes that share at least one entity with the seed set, ordered by number of shared entities desc.
   - Seed notes themselves are excluded.
4. **Bundle markdown** is `notesBundleMarkdown([...directNotes, ...relatedNotes])` from `src/memory/markdownStore.ts`: each note rendered as YAML-frontmatter + heading + summary + body, joined with `\n\n---\n\n`.
5. **Optional synthesis.** Only if `synthesize=true` *and* `MEMORY_LLM_SYNTHESIZE=true`. The LLM returns `{title, body, summary}`, which is inserted as a new `synthesis` note (tagged `["synthesis"]`, with `metadata.query` and `metadata.sourceNoteIds`), exported to markdown, and returned in `synthesisNote`. If either flag is false or the LLM fails, `synthesisNote: null`.

"Related notes" thus means: **co-linked via `note_links`, or sharing one or more named entities with a direct hit** — not semantic similarity, and not transitive (one hop only). Inferred: there is no diversification or recency boost beyond the share-count ordering.

---

## 5. Key Domain Objects

These shapes are normative for what callers will see on the wire. Source: `lib/api-zod/src/generated/api.ts` plus the serialization in `src/memory/services.ts` (`serializeNote`).

### `RawItem` (server-internal; not returned in full)

Only `rawItemId` (uuid) is exposed in `IngestTextResponse`. Inferred fields stored server-side: `text`, `source`, `author`, `createdAt`. Not directly fetchable via any endpoint today.

### `Note`

```ts
type NoteType =
  | "raw_source"
  | "note"
  | "insight"
  | "decision"
  | "synthesis"
  | "entity";

type Note = {
  id: string;                  // uuid
  type: NoteType;
  title: string;
  body: string;                // full self-contained content
  summary: string | null;
  tags: string[];              // lowercase kebab-case, 0-5 typical
  sourceItemId: string | null; // raw_items.id this note came from, if any
  createdAt: string;           // ISO-8601 (zod coerces to Date on parse)
  entities: Entity[];
};
```

### `Entity`

```ts
type Entity = {
  id: string;       // uuid
  type: string;     // e.g. "person","project","organization","place","concept","product","event"
  name: string;     // original casing preserved; dedup key is (type, normalized lowercase)
};
```

### `NoteLink` (server-internal)

Backs the `via:"related"` expansion. Not exposed on the wire today; inferred shape: `{ fromNoteId, toNoteId }` in a `note_links` table. Callers cannot create or read links directly.

### `SearchHit`

```ts
type SearchHit = { note: Note; score: number };
```

`score` is `ts_rank` (positive float, ordering only, not calibrated) for FTS hits, or `0.01` for ILIKE-fallback hits.

### `ContextHit`

```ts
type ContextHit = SearchHit & { via: "direct" | "related" };
```

Related hits always have `score: 0`.

### Context bundle

`bundleMarkdown` is a single string: each selected note rendered with YAML frontmatter (`id`, `type`, `title`, `created`, `tags`, `entities`) followed by `# title`, optional `> summary`, and the body, then notes separated by `\n\n---\n\n`. It is intended to be passed verbatim into a downstream LLM prompt.

---

## 6. Integration Guidance for Archivist Core

### When to call which endpoint

- **`POST /api/ingest/text`** — when the user has provided new information that should be remembered: facts, decisions, observations, source material, or anything they explicitly said "remember this" / "save this" about. One ingest call per logical chunk; the Memory Subsystem will split it into 1–3 notes itself, so do not pre-chunk small inputs.
- **`POST /api/search`** — when the user is *looking up* a known concept, name, or short phrase and you want a ranked list to choose from or display. Use this when you want raw hits, not a synthesized blob.
- **`POST /api/context/build`** — when the user is asking a *question* and you intend to feed the result into a downstream LLM. The bundle is markdown-ready and includes related notes you would not have gotten from `/search`. Default to `synthesize: false`; only set `synthesize: true` if you actually want a stored summary note.
- **`GET /api/notes/:id`** — when you already have an id (e.g. you stored it from a previous ingest, or a hit was clicked) and you want the full canonical note.
- **`GET /api/healthz`** — startup / periodic liveness only; do not gate every user turn on it.

### Deterministic routing

Archivist Core should classify intent *before* calling memory, not after. Suggested deterministic rules:

1. If the user turn contains an explicit *save* signal ("remember", "note that", "save this"), call **ingest**. Do not also search.
2. If the turn is a short noun-phrase lookup ("what is X", "who is Y", "the X project"), call **search** with `limit: 5–10`. If `hits` is empty, fall through to **context/build** with the same query before telling the user "nothing found".
3. If the turn is an open question that needs reasoning ("summarize what we decided about X", "what should I do about Y given prior notes"), call **context/build** directly and pass `bundleMarkdown` to your reasoning LLM.
4. Never call **ingest** speculatively on every user turn — it is a write path with LLM cost.

### No-result handling

- Both `/search` and `/context/build` return `200` with empty `hits` on no match. There is no distinguishing error code. Treat empty `hits` as "we have no memory of this", not as a failure.
- For `/context/build`, an empty `hits` array implies `bundleMarkdown: ""`. Do not pass an empty bundle to a downstream LLM as if it were context.

### Note id handling

- Note ids are stable uuids. Safe to persist client-side and reuse later in `GET /api/notes/:id`.
- There is no update or delete endpoint, so an id you stored will either resolve (`200`) or, if the row is gone (e.g. db wipe in dev), `404`. Treat `404` as "no longer present", not "permission denied".

### Safe assumptions

- The four memory endpoints are JSON-in, JSON-out, never streaming.
- Schemas in `lib/api-zod` are the source of truth; the server validates with the same zod schemas.
- Errors never leak server internals; every non-2xx response has an `{"error": "<message>"}` body.
- `hits` arrays are already ordered by relevance (FTS rank, then ILIKE fallback for search; direct-then-related for context).

### Unsafe assumptions (do **not** make these)

- Do not assume `score` values are comparable across queries or calibrated to a 0–1 range.
- Do not assume `interpretedQuery` will be present — it is only set when the server-side flag is enabled.
- Do not assume `synthesize: true` will produce a synthesis — the server-side flag may be off, in which case `synthesisNote` is `null` regardless.
- Do not assume idempotency on ingest. The same text posted twice produces two `raw_items` and two sets of notes.
- Do not assume `types` filtering applies to related notes in `/context/build` — it only filters direct hits.
- Do not assume markdown export succeeded; do not depend on `markdownPath` being non-null (it is not exposed on the wire anyway).

---

## 7. Known Limitations

1. **Semantic recall now available (hybrid is default).** Retrieval uses Reciprocal Rank Fusion (RRF) over Postgres FTS + Voyage AI vector search (`voyage-4-large`, 1024 dims). The `POST /api/search` endpoint accepts an optional `mode` field (`"lexical"` | `"semantic"` | `"hybrid"`, default `"hybrid"`). `POST /api/context/build` always uses hybrid internally. Notes get embeddings at ingest time; a backfill script covers existing notes. **Caveat:** if `VOYAGE_API_KEY` is not set, hybrid silently falls back to lexical-only and notes are stored with `embedding = NULL`.
2. **No update / delete endpoints.** Notes are append-only over HTTP. Corrections require ingesting a corrective note.
3. **No advanced ranking / diversification.** `ts_rank` ordering only; ILIKE fallback hits all share `score: 0.01`. Related-note expansion is one-hop and ranked by share count.
4. **LLM behavior is gated by env flags.** `interpretQuery` and `synthesize` are off unless `MEMORY_LLM_INTERPRET_QUERY=true` / `MEMORY_LLM_SYNTHESIZE=true`. If Gemini is not configured at all, classification falls back to a near-passthrough stub and entity extraction returns `[]`.
5. **`types` filter is direct-only in `/context/build`.** Related notes ignore the filter.
6. **No streaming, no pagination, no cursors.** Hard cap on `limit` (50). To page, you must re-query with different terms.
7. **No rate limiting today** (inferred from middleware list — only `requireApiKey` is mounted before `memoryRouter`). A runaway caller can saturate the LLM and DB.
8. **Markdown export is best-effort and local to the server's filesystem.** Not durable storage; not exposed via HTTP.
9. **No webhook / push notifications.** Archivist must poll if it cares about background changes (which today it should not, since there are none).

---

## 8. Five Example Interaction Patterns

### 8.1 "Save an idea"

User: *"Remember that we want to use Postgres advisory locks for the broker."*

```http
POST /api/ingest/text
Authorization: Bearer $MEMORY_API_KEY
Content-Type: application/json

{ "text": "We want to use Postgres advisory locks for the broker.", "source": "chat", "author": "alex" }
```
Use `response.notes[0].id` as the durable handle. Confirm to user with the `title` the LLM produced.

### 8.2 "Find a concept"

User: *"What do we have on advisory locks?"*

```http
POST /api/search
{ "query": "advisory locks", "limit": 5 }
```
Render `hits[].note.title` (and optionally `summary`) as a list. If `hits` is empty, fall through to pattern 8.3.

### 8.3 "Ask for a context bundle"

User: *"Summarize what we decided about broker locking."*

```http
POST /api/context/build
{ "query": "what did we decide about broker locking?", "limit": 8, "synthesize": false }
```
Pass `bundleMarkdown` straight into the downstream reasoning LLM as system / context.

### 8.4 "Fetch a known note by id"

You stored `noteId = "1d2e3f40-..."` from an earlier turn.

```http
GET /api/notes/1d2e3f40-aaaa-bbbb-cccc-1234567890ab
Authorization: Bearer $MEMORY_API_KEY
```
On `404`, tell the user the note is no longer available; do not retry.

### 8.5 "Handle no results"

User: *"What do we know about Project Hyperion?"*

```http
POST /api/search
{ "query": "Project Hyperion", "limit": 5 }
→ 200 { "hits": [] }

POST /api/context/build
{ "query": "Project Hyperion" }
→ 200 { "hits": [], "bundleMarkdown": "", "synthesisNote": null }
```
Reply with: *"I have no memory of Project Hyperion."* Do not fabricate from an empty bundle.

---

## 9. Compact OpenAPI-like Summary

```yaml
servers:
  - url: "{BASE}/api"

securitySchemes:
  bearerKey:
    type: http
    scheme: bearer
    description: Bearer <MEMORY_API_KEY>

errors:
  400: { error: "Invalid request" }              # zod validation failure
  401: { error: "Missing or invalid Authorization header" } # or "Invalid API key"
  404: { error: "Note not found" }               # GET /notes/:id only
  500: { error: "Internal server error" }        # details logged server-side

paths:
  /healthz:
    get:
      auth: none
      response: { status: "ok" }

  /ingest/text:
    post:
      auth: bearerKey
      body:
        text:   string (required, min 1)
        source: string | null
        author: string | null
      response:
        rawItemId: string
        notes:     Note[]   # 1..3, never empty on 200

  /notes/{id}:
    get:
      auth: bearerKey
      params: { id: string }
      response: Note
      notFound: 404

  /search:
    post:
      auth: bearerKey
      body:
        query: string (required, min 1)
        limit: number (1..50, default 10)
        types: NoteType[] | null
      response:
        query:            string
        interpretedQuery: string | null
        hits: [{ note: Note, score: number }]

  /context/build:
    post:
      auth: bearerKey
      body:
        query:      string (required, min 1)
        limit:      number (1..50, default 8)
        types:      NoteType[] | null   # direct hits only
        synthesize: boolean (default false)
      response:
        query:            string
        interpretedQuery: string | null
        hits: [{ note: Note, score: number, via: "direct" | "related" }]
        bundleMarkdown:   string
        synthesisNote:    Note | null

components:
  NoteType: [raw_source, note, insight, decision, synthesis, entity]
  Note:
    id:           string (uuid)
    type:         NoteType
    title:        string
    body:         string
    summary:      string | null
    tags:         string[]
    sourceItemId: string (uuid) | null
    createdAt:    string (ISO-8601)
    entities:     Entity[]
  Entity:
    id:   string (uuid)
    type: string  # person|project|organization|place|concept|product|event
    name: string
```

---

## 10. Routing Cheat Sheet for Archivist

| User intent                                         | Endpoint                | Why                                                                                                       | Fallback behavior                                                                                                  |
| --------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Save new info ("remember this", new fact/decision)  | `POST /api/ingest/text` | Only write path; runs LLM classification + entity extraction so 1 call captures structure.                | On `5xx`, retry once; on persistent failure surface a clear "couldn't save" to the user — do not silently drop.    |
| Look up a known concept / short noun-phrase         | `POST /api/search`      | Returns ranked lexical hits with scores; cheap and deterministic.                                         | If `hits` is empty, fall through to `POST /api/context/build` with the same `query` before declaring "no results". |
| Assemble context for an open question / agent prompt | `POST /api/context/build` | Combines direct hits, related notes (links + shared entities), and a ready-to-prompt `bundleMarkdown`.    | If `hits` is empty *and* `bundleMarkdown == ""`, do not feed an empty bundle to the LLM — answer "no memory" instead. Fall back to `POST /api/search` only if you want to display raw hits to the user. |
| Fetch a specific note by id                         | `GET /api/notes/:id`    | Canonical, full note (with entities) by stable uuid.                                                      | On `404`, treat as "note no longer present"; do not retry; do not fabricate. Optionally call `/search` with the original title if you have it cached.                                                |
| Liveness / "is memory up?"                          | `GET /api/healthz`      | Public, no auth, cheap.                                                                                   | On non-200 or timeout, mark Memory Subsystem unavailable and skip memory-routed turns until it recovers.            |
