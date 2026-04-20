# Memory Subsystem v1

A modular memory subsystem for an AI-oriented architecture. Ingests text, classifies it into structured notes with extracted entities, persists them in Postgres, and exposes a small HTTP API for an external "Archivist" broker agent.

## Architecture

- **Modular monolith** inside the existing pnpm monorepo.
- **Postgres** (Replit-managed) is the runtime source of truth.
- **Markdown export** at `./.data/notes/` is a human-readable mirror, not the source of truth.
- **Pluggable retrieval**: v1 ships with a Postgres FTS retriever; the repository layer is structured so a future `pgvector` retriever can be swapped in.
- **LLM**: Gemini via the Replit AI Integrations proxy (`@workspace/integrations-gemini-ai`).
  - Always-on: `classifyNotes`, `extractEntities`.
  - Gated by env flags (default OFF): `MEMORY_LLM_INTERPRET_QUERY`, `MEMORY_LLM_SYNTHESIZE`.
  - Model: `MEMORY_LLM_MODEL` (default `gemini-2.5-flash`).

## Components

- `lib/db/src/schema/memory.ts` — Drizzle schema: `raw_items`, `notes` (with generated tsvector + GIN index), `entities`, `note_entities`, `note_links`.
- `lib/integrations-gemini-ai/` — Gemini client wrapper.
- `lib/api-spec/openapi.yaml` — OpenAPI 3.1 contract; codegen produces Zod schemas (`@workspace/api-zod`) and React Query hooks (`@workspace/api-client-react`).
- `artifacts/api-server/src/memory/` — `llm.ts`, `repository.ts`, `markdownStore.ts`, `services.ts`.
- `artifacts/api-server/src/routes/memory.ts` — Express routes for the 4 endpoints.
- `artifacts/api-server/src/middlewares/auth.ts` — `requireApiKey` middleware: requires `Authorization: Bearer <key>` or `X-API-Key: <key>` matching `MEMORY_API_KEY` for all memory routes (health stays open).
- `artifacts/inspector/` — minimal React test panel (no design polish, JSON in / JSON out). Reads `VITE_MEMORY_API_KEY` and registers an auth-token getter so all calls send the bearer header automatically.

## Endpoints

- `POST /api/ingest/text` — Ingest a text item, classify into notes, extract entities, persist, mirror to markdown.
- `GET /api/notes/:id` — Fetch a single note (with its entities).
- `POST /api/search` — Keyword/FTS search across notes; OR-based recall, optional type filter.
- `POST /api/context/build` — Build a markdown bundle for a downstream agent; optional LLM synthesis (gated).

## Workflows

- `artifacts/api-server: API Server` — Express server (port 8080, mounted at `/api`).
- `artifacts/inspector: web` — Vite dev server for the inspector UI (mounted at `/`).

## Useful commands

- `pnpm --filter @workspace/api-spec run codegen` — regenerate Zod + React hooks from OpenAPI.
- `pnpm --filter @workspace/db run push` — sync Drizzle schema to Postgres.
- `pnpm --filter @workspace/api-server run typecheck`.

## Future work (out of scope for v1)

- `pgvector`-backed retriever (drop-in via the same `ftsSearch`-style API).
- `Retriever.related()` for note-to-note links.
- Authentication / multi-tenant scoping.
