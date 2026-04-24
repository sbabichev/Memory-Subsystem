import { logger } from "../lib/logger";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-4-large";
const DIMS = 1024;
const MAX_BATCH_ITEMS = 1000;
const MAX_TOKENS_PER_REQUEST = 120_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 500;

export type InputType = "document" | "query";

export interface EmbedResult {
  embedding: number[];
  dims: number;
  latencyMs: number;
  totalTokens: number;
}

export interface BatchEmbedResult {
  embeddings: (number[] | null)[];
  dims: number;
  latencyMs: number;
  totalTokens: number;
}

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY environment variable is not set");
  return key;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function voyageRequest(
  inputs: string[],
  inputType: InputType,
): Promise<{ embeddings: number[][]; usage: { total_tokens: number } }> {
  const apiKey = getApiKey();
  let lastErr: unknown;
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 16000);
    }
    let res: Response;
    try {
      res = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          input: inputs,
          input_type: inputType,
          truncation: true,
        }),
      });
    } catch (err) {
      lastErr = err;
      logger.warn({ err, attempt }, "voyage-client: network error, retrying");
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : backoff;
      lastErr = new Error(`Voyage API returned ${res.status}`);
      logger.warn(
        { status: res.status, attempt, waitMs },
        "voyage-client: rate-limited or server error, retrying",
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage API error ${res.status}: ${body}`);
    }

    const json = await res.json() as {
      data: { embedding: number[] }[];
      usage: { total_tokens: number };
    };
    return {
      embeddings: json.data.map((d) => d.embedding),
      usage: json.usage,
    };
  }

  throw lastErr ?? new Error("Voyage API request failed after retries");
}

export async function embedText(
  text: string,
  inputType: InputType,
): Promise<EmbedResult> {
  const t0 = Date.now();
  const result = await voyageRequest([text], inputType);
  const latencyMs = Date.now() - t0;
  const embedding = result.embeddings[0];
  const dims = embedding.length;
  const totalTokens = result.usage.total_tokens;

  logger.info(
    { model: MODEL, inputType, dims, latencyMs, totalTokens },
    "voyage-client: embedded single text",
  );

  return { embedding, dims, latencyMs, totalTokens };
}

/** Split texts into sub-batches that respect both item count and token limits. */
function splitIntoBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokenEstimate = 0;

  for (const text of texts) {
    const tokenEstimate = Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_ITEMS ||
        currentTokenEstimate + tokenEstimate > MAX_TOKENS_PER_REQUEST)
    ) {
      batches.push(current);
      current = [];
      currentTokenEstimate = 0;
    }
    current.push(text);
    currentTokenEstimate += tokenEstimate;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function embedBatch(
  texts: string[],
  inputType: InputType,
): Promise<BatchEmbedResult> {
  if (texts.length === 0) {
    return { embeddings: [], dims: DIMS, latencyMs: 0, totalTokens: 0 };
  }

  const t0 = Date.now();
  const allEmbeddings: (number[] | null)[] = new Array(texts.length).fill(null);
  let totalTokens = 0;
  let dims = DIMS;
  let globalOffset = 0;

  const batches = splitIntoBatches(texts);
  for (const batchTexts of batches) {
    const result = await voyageRequest(batchTexts, inputType);
    for (let j = 0; j < result.embeddings.length; j++) {
      allEmbeddings[globalOffset + j] = result.embeddings[j];
    }
    totalTokens += result.usage.total_tokens;
    if (result.embeddings[0]) dims = result.embeddings[0].length;
    globalOffset += batchTexts.length;
  }

  const latencyMs = Date.now() - t0;
  logger.info(
    { model: MODEL, inputType, count: texts.length, batches: batches.length, dims, latencyMs, totalTokens },
    "voyage-client: embedded batch",
  );

  return { embeddings: allEmbeddings, dims, latencyMs, totalTokens };
}

export { DIMS as EMBEDDING_DIMS };
