import { ftsSearch, semanticSearch, rrfFuse, type SearchHitRow } from "./repository";
import { embedText } from "./voyage-client";
import { logger } from "../lib/logger";

export type SearchMode = "lexical" | "semantic" | "hybrid";

export type RetrieverSearchOptions = {
  limit: number;
  types?: string[] | null;
  tenantId: string;
  mode?: SearchMode;
};

export type RetrieverSearchResult = {
  hits: SearchHitRow[];
  effectiveMode: SearchMode;
};

export interface Retriever {
  readonly name: string;
  search(query: string, opts: RetrieverSearchOptions): Promise<RetrieverSearchResult>;
}

const FTS_POOL = 50;
const SEMANTIC_POOL = 50;

export class HybridRetriever implements Retriever {
  readonly name = "hybrid";

  async search(query: string, opts: RetrieverSearchOptions): Promise<RetrieverSearchResult> {
    const mode: SearchMode = opts.mode ?? "hybrid";
    const { limit, types, tenantId } = opts;

    if (mode === "lexical") {
      const t0 = Date.now();
      const hits = await ftsSearch(query, { limit, types, tenantId });
      logger.info(
        { mode, ftsLatencyMs: Date.now() - t0, semanticLatencyMs: 0, rrfLatencyMs: 0, hits: hits.length },
        "retriever: lexical search",
      );
      return { hits, effectiveMode: "lexical" };
    }

    if (mode === "semantic") {
      const t0Embed = Date.now();
      const embedded = await embedText(query, "query");
      const t1 = Date.now();
      const hits = await semanticSearch(embedded.embedding, { limit, types, tenantId });
      logger.info(
        {
          mode,
          embedLatencyMs: t1 - t0Embed,
          ftsLatencyMs: 0,
          semanticLatencyMs: Date.now() - t1,
          rrfLatencyMs: 0,
          hits: hits.length,
        },
        "retriever: semantic search",
      );
      return { hits, effectiveMode: "semantic" };
    }

    // hybrid: embed query first, then run FTS + semantic in parallel
    const t0Embed = Date.now();
    let queryEmbedding: number[] | null = null;
    try {
      const embedded = await embedText(query, "query");
      queryEmbedding = embedded.embedding;
    } catch (err) {
      logger.warn({ err }, "retriever: failed to embed query, falling back to lexical only");
    }
    const embedLatencyMs = Date.now() - t0Embed;

    if (!queryEmbedding) {
      // Voyage unavailable — fall back to lexical; report effective mode as lexical
      const t0Fts = Date.now();
      const hits = await ftsSearch(query, { limit, types, tenantId });
      logger.info(
        { mode, effectiveMode: "lexical", embedLatencyMs, ftsLatencyMs: Date.now() - t0Fts, semanticLatencyMs: 0, rrfLatencyMs: 0, hits: hits.length },
        "retriever: hybrid fell back to lexical",
      );
      return { hits, effectiveMode: "lexical" };
    }

    // FTS + semantic run in parallel; track individual latencies via settled promises
    let ftsLatencyMs = 0;
    let semanticLatencyMs = 0;
    const t0Fts = Date.now();
    const t0Sem = Date.now();
    const [ftsHits, semanticHits] = await Promise.all([
      ftsSearch(query, { limit: FTS_POOL, types, tenantId }).then((r) => {
        ftsLatencyMs = Date.now() - t0Fts;
        return r;
      }),
      semanticSearch(queryEmbedding, { limit: SEMANTIC_POOL, types, tenantId }).then((r) => {
        semanticLatencyMs = Date.now() - t0Sem;
        return r;
      }),
    ]);
    const t0Rrf = Date.now();
    const fused = rrfFuse(ftsHits, semanticHits, limit);
    const rrfLatencyMs = Date.now() - t0Rrf;

    // Drop hits whose RRF score is below 30% of the top scorer.
    // Prevents low-signal notes from leaking into results when the corpus is small.
    const topScore = fused.length > 0 ? fused[0].score : 0;
    const minScore = topScore * 0.30;
    const filtered = fused.filter((h) => h.score >= minScore);

    logger.info(
      {
        mode,
        embedLatencyMs,
        ftsLatencyMs,
        semanticLatencyMs,
        rrfLatencyMs,
        ftsHits: ftsHits.length,
        semanticHits: semanticHits.length,
        fusedHits: fused.length,
        filteredHits: filtered.length,
        minScore,
      },
      "retriever: hybrid search",
    );

    return { hits: filtered, effectiveMode: "hybrid" };
  }
}

export class KeywordRetriever implements Retriever {
  readonly name = "keyword";
  async search(query: string, opts: RetrieverSearchOptions): Promise<RetrieverSearchResult> {
    const hits = await ftsSearch(query, opts);
    return { hits, effectiveMode: "lexical" };
  }
}

let singleton: Retriever | null = null;

export function getRetriever(): Retriever {
  if (singleton) return singleton;
  const kind = process.env.MEMORY_RETRIEVER ?? "hybrid";
  switch (kind) {
    case "keyword":
      singleton = new KeywordRetriever();
      break;
    case "hybrid":
    default:
      singleton = new HybridRetriever();
  }
  return singleton;
}
