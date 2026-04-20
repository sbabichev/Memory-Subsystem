# Archivist ↔ Memory Subsystem — Quickstart

For the full contract, see `ARCHIVIST_MEMORY_INTEGRATION.md`.

## Auth

Every `/api/*` route except `/api/healthz` requires:

```
Authorization: Bearer <MEMORY_API_KEY>
```

Missing/wrong key → `401 {"error": "..."}`. The server refuses to start without `MEMORY_API_KEY` set.

## The 4 endpoints

### 1. `POST /api/ingest/text` — save new info

When to use: the user has given you something to remember (a fact, decision, observation, source).

```bash
curl -X POST "$BASE/api/ingest/text" \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Decided to use Postgres advisory locks for the broker.", "source": "chat", "author": "alex" }'
```

Returns `{ rawItemId, notes: Note[] }`. `notes` is typically 1–3 entries; defensively handle the empty case. Persist `notes[i].id` if you want to fetch later.

### 2. `POST /api/search` — look up a known concept

When to use: the user wants a ranked list of matches for a short query / noun phrase.

```bash
curl -X POST "$BASE/api/search" \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "advisory locks", "limit": 5 }'
```

Returns `{ query, interpretedQuery, hits: [{ note, score }] }`. Empty `hits` is a normal `200`, not an error.

### 3. `POST /api/context/build` — assemble context for a question

When to use: the user asked an open question and you want to feed the result into a downstream LLM. Returns direct hits + related notes (via `note_links` and shared entities) + a ready-to-prompt `bundleMarkdown`.

```bash
curl -X POST "$BASE/api/context/build" \
  -H "Authorization: Bearer $MEMORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "what did we decide about broker locking?", "limit": 8, "synthesize": false }'
```

Returns `{ query, interpretedQuery, hits: [{ note, score, via: "direct"|"related" }], bundleMarkdown, synthesisNote }`. Pass `bundleMarkdown` straight into the downstream prompt. If `hits` is empty, do **not** feed the empty bundle to an LLM.

### 4. `GET /api/notes/:id` — fetch a known note

When to use: you already have a uuid from a prior ingest/search and want the full canonical note.

```bash
curl "$BASE/api/notes/1d2e3f40-aaaa-bbbb-cccc-1234567890ab" \
  -H "Authorization: Bearer $MEMORY_API_KEY"
```

Returns a `Note`. `404` means the row is gone; do not retry.

(Plus `GET /api/healthz` — public, returns `{"status":"ok"}`. Use for liveness only.)

## Top 5 limitations to plan around

1. **Lexical search only.** Postgres FTS + `ILIKE` fallback — no semantic / vector similarity. Query tokens that don't appear lexically will miss.
2. **No multi-tenant isolation.** One `MEMORY_API_KEY` grants access to the entire store; everything is shared.
3. **No update or delete endpoints.** Notes are append-only over HTTP. Corrections must be ingested as new notes.
4. **LLM features are flag-gated.** Query rewriting (`interpretedQuery`) and synthesis (`synthesisNote`) only happen when their server-side env flags are enabled — otherwise both are `null` regardless of request.
5. **No rate limiting, no streaming, no pagination.** `limit` is hard-capped at 50, and a runaway caller can saturate the LLM/DB.
