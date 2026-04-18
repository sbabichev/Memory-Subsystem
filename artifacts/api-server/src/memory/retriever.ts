import { ftsSearch, type SearchHitRow } from "./repository";

export type RetrieverSearchOptions = {
  limit: number;
  types?: string[] | null;
};

export interface Retriever {
  readonly name: string;
  search(query: string, opts: RetrieverSearchOptions): Promise<SearchHitRow[]>;
}

export class KeywordRetriever implements Retriever {
  readonly name = "keyword";
  async search(
    query: string,
    opts: RetrieverSearchOptions,
  ): Promise<SearchHitRow[]> {
    return ftsSearch(query, opts);
  }
}

let singleton: Retriever | null = null;

export function getRetriever(): Retriever {
  if (singleton) return singleton;
  const kind = process.env.MEMORY_RETRIEVER ?? "keyword";
  switch (kind) {
    case "keyword":
    default:
      singleton = new KeywordRetriever();
  }
  return singleton;
}
