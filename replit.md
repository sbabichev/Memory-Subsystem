# Memory Subsystem v2

A modular memory subsystem for an AI-oriented architecture. Ingests text, classifies it into structured notes with extracted entities, persists them in Postgres, and exposes a small HTTP API for an external "Archivist" broker agent.

## Architecture

- **Modular monolith** inside the existing pnpm monorepo.
- **Postgres** (Replit-managed) with **pgvector** extension is the runtime source of truth.
- **Markdown export** at `./.data/notes/` is a human-readable mirror, not the source of truth.
- **Hybrid retrieval**: default mode uses Reciprocal Rank Fusion (RRF k=60) over Postgres FTS + Voyage AI semantic embeddings (`voyage-4-large`, 1024 dims). Fallback to lexical-only if `VOYAGE_API_KEY` is absent.
- **LLM**: Gemini via the Replit AI Integrations proxy (`@workspace/integrations-gemini-ai`).
  - Always-on: `classifyNotes`, `extractEntities`.
  - Gated by env flags (default OFF): `MEMORY_LLM_INTERPRET_QUERY`, `MEMORY_LLM_SYNTHESIZE`.
  - Model: `MEMORY_LLM_MODEL` (default `gemini-2.5-flash`).
- **Embeddings**: Voyage AI (`VOYAGE_API_KEY` required). Each note is embedded at ingest time with `document` input type; queries use `query` input type.

## Components

- `lib/db/src/schema/memory.ts` — Drizzle schema: `raw_items`, `notes` (tsvector GIN index + `vector(1024)` HNSW cosine index), `entities`, `note_entities`, `note_links`.
- `lib/integrations-gemini-ai/` — Gemini client wrapper.
- `lib/api-spec/openapi.yaml` — OpenAPI 3.1 contract; codegen produces Zod schemas (`@workspace/api-zod`) and React Query hooks (`@workspace/api-client-react`).
- `artifacts/api-server/src/memory/` — `llm.ts`, `repository.ts`, `retriever.ts`, `markdownStore.ts`, `services.ts`, `voyage-client.ts`.
- `artifacts/api-server/src/scripts/backfill-embeddings.ts` — idempotent backfill for existing notes with `embedding IS NULL`.
- `artifacts/api-server/src/routes/memory.ts` — Express routes for the 4 endpoints.
- `artifacts/api-server/src/middlewares/auth.ts` — `requireApiKey` middleware.
- `artifacts/inspector/` — minimal React test panel.

## Endpoints

- `POST /api/ingest/text` — Ingest a text item, classify into notes, extract entities, persist, embed (Voyage AI), mirror to markdown.
- `GET /api/notes/:id` — Fetch a single note (with its entities).
- `POST /api/search` — Search across notes. Optional `mode: "lexical" | "semantic" | "hybrid"` (default `"hybrid"`). Response includes `searchMode` field.
- `POST /api/context/build` — Build a markdown bundle for a downstream agent using hybrid retrieval internally; optional LLM synthesis (gated).

## Environment Variables

- `VOYAGE_API_KEY` — (secret) Required for semantic/hybrid search and embed-on-ingest. If absent, ingest succeeds with `embedding = NULL` and search falls back to lexical.
- `MEMORY_API_KEY` / `MEMORY_API_KEYS` — Auth keys for the API (see auth docs).
- `MEMORY_RETRIEVER` — Override retriever: `"hybrid"` (default) or `"keyword"`.
- `MEMORY_LLM_INTERPRET_QUERY` — Enable LLM query rewrite (default OFF).
- `MEMORY_LLM_SYNTHESIZE` — Enable synthesis note generation (default OFF).

## Workflows

- `artifacts/api-server: API Server` — Express server (port 8080, mounted at `/api`).
- `artifacts/inspector: web` — Vite dev server for the inspector UI (mounted at `/`).

## Database setup

Run the following command to set up (or recover) the schema on any environment:

```
pnpm --filter @workspace/db run setup
```

This single command is fully idempotent and runs the canonical steps in order:
1. Enable `vector` (pgvector) extension
2. `drizzle-kit push --force` — create / reconcile all tables
3. `setup-pgvector` — create the HNSW cosine index on `notes.embedding`
4. `migrate-tenants` — backfill `tenant_id` on pre-existing rows, add FK constraints and indexes

**Startup guard**: if required tables are missing when the server starts, it exits immediately with a `FATAL` log listing the missing tables — no more silent 500s per request. Run `setup` to fix, then restart.

`GET /api/healthz` also performs a read-only schema check and returns HTTP 503 with a `reason` field if any required table is absent.

## Useful commands

- `pnpm --filter @workspace/api-spec run codegen` — regenerate Zod + React hooks from OpenAPI.
- `pnpm --filter @workspace/db run setup` — one-shot idempotent database setup (extension + tables + indexes). Safe to re-run.
- `pnpm --filter @workspace/db run push` — sync Drizzle schema to Postgres (dev convenience).
- `pnpm --filter @workspace/api-server run typecheck`.
- `pnpm --filter @workspace/api-server run test:unit` — unit tests (RRF fusion, Voyage client mock, embed failure isolation).
- `pnpm --filter @workspace/api-server run test:isolation` — tenant isolation integration tests (including semantic search isolation).
- `pnpm --filter @workspace/api-server run backfill:embeddings` — embed all notes with `embedding IS NULL` (idempotent, rate-limit safe).
