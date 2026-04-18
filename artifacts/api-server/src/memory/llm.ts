import { ai } from "@workspace/integrations-gemini-ai";
import { logger } from "../lib/logger";

const MODEL = process.env.MEMORY_LLM_MODEL ?? "gemini-2.5-flash";

export const llmFlags = {
  interpretQuery: process.env.MEMORY_LLM_INTERPRET_QUERY === "true",
  synthesize: process.env.MEMORY_LLM_SYNTHESIZE === "true",
};

export type ClassifiedNote = {
  type: "raw_source" | "note" | "insight" | "decision";
  title: string;
  body: string;
  summary?: string;
  tags: string[];
};

export type ExtractedEntity = {
  type: string;
  name: string;
};

function tryParseJson<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate.trim()) as T;
  } catch {
    const start = candidate.indexOf("{");
    const startArr = candidate.indexOf("[");
    const idx =
      start === -1
        ? startArr
        : startArr === -1
          ? start
          : Math.min(start, startArr);
    if (idx === -1) return null;
    const end = Math.max(
      candidate.lastIndexOf("}"),
      candidate.lastIndexOf("]"),
    );
    if (end === -1 || end <= idx) return null;
    try {
      return JSON.parse(candidate.slice(idx, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

async function generateText(prompt: string): Promise<string> {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });
  return res.text ?? "";
}

const ALLOWED_TYPES = new Set(["raw_source", "note", "insight", "decision"]);

export async function classifyNotes(
  text: string,
  hint?: { source?: string | null; author?: string | null },
): Promise<ClassifiedNote[]> {
  const prompt = `You are a memory classifier. Read the input text and produce 1 to 3 structured notes that capture its meaningful content. Each note must have:
- "type": one of "note" (general fact/observation), "insight" (a derived takeaway), "decision" (a choice or commitment), or "raw_source" (when the text is a verbatim source worth preserving as-is).
- "title": a short, specific title (<= 80 chars).
- "body": the full self-contained content of the note in plain text. Do NOT shorten — the body must let a reader understand the note without seeing the original input.
- "summary": one-sentence summary (optional but encouraged).
- "tags": 1-5 lowercase, kebab-case topical tags.

Return ONLY a JSON array of objects, no prose.

Source: ${hint?.source ?? "unknown"}
Author: ${hint?.author ?? "unknown"}

INPUT:
"""
${text}
"""`;

  try {
    const raw = await generateText(prompt);
    const parsed = tryParseJson<ClassifiedNote[]>(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("LLM returned no notes");
    }
    return parsed
      .filter((n) => n && typeof n.title === "string" && typeof n.body === "string")
      .map((n) => ({
        type: ALLOWED_TYPES.has(n.type) ? n.type : "note",
        title: n.title.slice(0, 200),
        body: n.body,
        summary: typeof n.summary === "string" ? n.summary : undefined,
        tags: Array.isArray(n.tags)
          ? n.tags.filter((t) => typeof t === "string").slice(0, 5)
          : [],
      }));
  } catch (err) {
    logger.warn({ err }, "classifyNotes LLM failed, falling back to single note");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
    return [
      {
        type: "note",
        title: firstLine.trim().slice(0, 80) || "Untitled note",
        body: text,
        tags: [],
      },
    ];
  }
}

export async function extractEntities(text: string): Promise<ExtractedEntity[]> {
  const prompt = `Extract named entities from the text. Return ONLY a JSON array of objects with "type" and "name". Allowed types: person, project, organization, place, concept, product, event. Deduplicate. Return [] if none.

INPUT:
"""
${text}
"""`;

  try {
    const raw = await generateText(prompt);
    const parsed = tryParseJson<ExtractedEntity[]>(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e) =>
          e &&
          typeof e.type === "string" &&
          typeof e.name === "string" &&
          e.name.trim().length > 0,
      )
      .map((e) => ({
        type: e.type.toLowerCase().trim(),
        name: e.name.trim(),
      }));
  } catch (err) {
    logger.warn({ err }, "extractEntities LLM failed");
    return [];
  }
}

export async function interpretQuery(query: string): Promise<string | null> {
  if (!llmFlags.interpretQuery) return null;
  try {
    const raw = await generateText(
      `Rewrite the following user query to maximize keyword recall against a Postgres full-text search over personal notes. Expand abbreviations, add likely synonyms, and keep it short. Return ONLY the rewritten query as plain text.\n\nQUERY: ${query}`,
    );
    const text = raw.trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.warn({ err }, "interpretQuery LLM failed");
    return null;
  }
}

export async function synthesize(
  query: string,
  bundleMarkdown: string,
): Promise<{ title: string; body: string; summary: string } | null> {
  if (!llmFlags.synthesize) return null;
  try {
    const raw = await generateText(
      `You are synthesizing notes for a downstream agent. Given the user's query and a bundle of relevant notes (markdown), produce a focused synthesis. Return ONLY a JSON object with keys "title" (short), "summary" (one sentence), and "body" (markdown, can include bullet points and citations of note titles).\n\nQUERY: ${query}\n\nNOTES:\n${bundleMarkdown}`,
    );
    const parsed = tryParseJson<{ title: string; body: string; summary: string }>(
      raw,
    );
    if (!parsed || !parsed.title || !parsed.body) return null;
    return {
      title: parsed.title.slice(0, 200),
      body: parsed.body,
      summary: parsed.summary ?? "",
    };
  } catch (err) {
    logger.warn({ err }, "synthesize LLM failed");
    return null;
  }
}
