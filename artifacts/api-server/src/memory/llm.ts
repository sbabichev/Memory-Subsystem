import { getAi, isGeminiConfigured } from "@workspace/integrations-gemini-ai";
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

export const ENTITY_RELATION_TYPES = [
  "works_at",
  "attended",
  "lives_in",
  "located_in",
  "friend_of",
  "family_of",
  "colleague_of",
  "member_of",
  "created_by",
  "part_of",
  "mentions",
] as const;

export type EntityRelationType = (typeof ENTITY_RELATION_TYPES)[number];

export type ExtractedEntityRelation = {
  fromEntityId: string;
  toEntityId: string;
  relation: EntityRelationType;
  confidence: number;
};

export const NOTE_RELATION_TYPES = [
  "mentions_same_person",
  "same_event",
  "follow_up_to",
  "contradicts",
  "references",
] as const;

export type NoteRelationType = (typeof NOTE_RELATION_TYPES)[number];

export type NoteRelationCandidate = {
  id: string;
  title: string;
  body: string;
  summary?: string | null;
  entities: { type: string; name: string }[];
};

export type ExtractedNoteRelation = {
  fromId: string;
  toId: string;
  relation: NoteRelationType;
  confidence: number;
};

export interface LLMClient {
  classifyNotes(
    text: string,
    hint?: { source?: string | null; author?: string | null },
  ): Promise<ClassifiedNote[]>;
  extractEntities(text: string): Promise<ExtractedEntity[]>;
  interpretQuery(query: string): Promise<string | null>;
  synthesize(
    query: string,
    bundleMarkdown: string,
  ): Promise<{ title: string; body: string; summary: string } | null>;
  /**
   * Given a list of note candidates, identify typed relationships between them.
   * Returns only pairs where the LLM is confident a relation exists.
   * Can be reused by future update flows (e.g. when editing a note).
   */
  extractNoteRelations(
    notes: NoteRelationCandidate[],
  ): Promise<ExtractedNoteRelation[]>;
  /**
   * Given note text and its extracted entities (with IDs), identify typed
   * directed relationships between those entities.
   * Whitelist: works_at, attended, lives_in, located_in, friend_of,
   *   family_of, colleague_of, member_of, created_by, part_of, mentions.
   * Returns only pairs where confidence >= 0.5.
   *
   * Extracted so future note-update flows can call `buildAndPersistEntityRelations`
   * without duplicating logic.
   */
  extractEntityRelations(input: {
    noteText: string;
    entities: { id: string; type: string; name: string }[];
  }): Promise<ExtractedEntityRelation[]>;
}

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

const ALLOWED_TYPES = new Set(["raw_source", "note", "insight", "decision"]);

class GeminiLLMClient implements LLMClient {
  private async generate(prompt: string): Promise<string> {
    const res = await getAi().models.generateContent({
      model: MODEL,
      contents: prompt,
    });
    return res.text ?? "";
  }

  async classifyNotes(
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
      const raw = await this.generate(prompt);
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
      logger.warn({ err }, "classifyNotes (gemini) failed, using stub");
      return stubClient.classifyNotes(text, hint);
    }
  }

  async extractEntities(text: string): Promise<ExtractedEntity[]> {
    const prompt = `Extract named entities from the text. Return ONLY a JSON array of objects with "type" and "name". Allowed types: person, project, organization, place, concept, product, event. Deduplicate. Return [] if none.

INPUT:
"""
${text}
"""`;
    try {
      const raw = await this.generate(prompt);
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
      logger.warn({ err }, "extractEntities (gemini) failed");
      return [];
    }
  }

  async interpretQuery(query: string): Promise<string | null> {
    if (!llmFlags.interpretQuery) return null;
    try {
      const raw = await this.generate(
        `Rewrite the following user query to maximize keyword recall against a Postgres full-text search over personal notes. Expand abbreviations, add likely synonyms, and keep it short. Return ONLY the rewritten query as plain text.\n\nQUERY: ${query}`,
      );
      const text = raw.trim();
      return text.length > 0 ? text : null;
    } catch (err) {
      logger.warn({ err }, "interpretQuery (gemini) failed");
      return null;
    }
  }

  async synthesize(
    query: string,
    bundleMarkdown: string,
  ): Promise<{ title: string; body: string; summary: string } | null> {
    if (!llmFlags.synthesize) return null;
    try {
      const raw = await this.generate(
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
      logger.warn({ err }, "synthesize (gemini) failed");
      return null;
    }
  }

  async extractNoteRelations(
    noteCandidates: NoteRelationCandidate[],
  ): Promise<ExtractedNoteRelation[]> {
    if (noteCandidates.length < 2) return [];
    const noteList = noteCandidates
      .map(
        (n) =>
          `ID: ${n.id}\nTitle: ${n.title}\nSummary: ${n.summary ?? ""}\nEntities: ${n.entities.map((e) => `${e.type}:${e.name}`).join(", ")}\nBody (excerpt): ${n.body.slice(0, 300)}`,
      )
      .join("\n\n---\n\n");

    const allowedTypes = NOTE_RELATION_TYPES.join(", ");
    const prompt = `You are analyzing a set of notes to find meaningful typed relationships between them.

Allowed relation types: ${allowedTypes}
- mentions_same_person: both notes refer to the same individual
- same_event: both notes describe or stem from the same event/meeting
- follow_up_to: one note is a follow-up, update, or continuation of another
- contradicts: the notes express conflicting information
- references: one note explicitly mentions or cites content from another

For each pair of notes that has a clear, confident relationship, output a JSON object with:
- "fromId": id of the source note
- "toId": id of the target note
- "relation": one of the allowed types
- "confidence": a number 0.0–1.0

Return ONLY a JSON array. Return [] if no confident relationships exist. Do not invent relationships.

NOTES:
${noteList}`;

    try {
      const raw = await this.generate(prompt);
      const parsed = tryParseJson<ExtractedNoteRelation[]>(raw);
      if (!Array.isArray(parsed)) return [];
      const validRelations = new Set<string>(NOTE_RELATION_TYPES);
      return parsed.filter(
        (r) =>
          r &&
          typeof r.fromId === "string" &&
          typeof r.toId === "string" &&
          typeof r.relation === "string" &&
          validRelations.has(r.relation) &&
          r.fromId !== r.toId &&
          typeof r.confidence === "number" &&
          r.confidence >= 0.5,
      );
    } catch (err) {
      logger.warn({ err }, "extractNoteRelations (gemini) failed");
      return [];
    }
  }

  async extractEntityRelations(input: {
    noteText: string;
    entities: { id: string; type: string; name: string }[];
  }): Promise<ExtractedEntityRelation[]> {
    if (input.entities.length < 2) return [];

    const allowedRelations = ENTITY_RELATION_TYPES.join(", ");
    const entityList = input.entities
      .map((e) => `ID: ${e.id}  type: ${e.type}  name: ${e.name}`)
      .join("\n");

    const prompt = `You are extracting typed directed relationships between named entities found in a text.

Entities:
${entityList}

Allowed relation types: ${allowedRelations}
- works_at: person works at an organization
- attended: person attended an event or educational institution
- lives_in: person lives in a place
- located_in: entity is physically located in a place
- friend_of: personal friendship between two people
- family_of: family relationship between two people
- colleague_of: two people work together
- member_of: person is a member of a group/organization
- created_by: product/project was created by a person or organization
- part_of: entity is a component/part of another
- mentions: entity explicitly mentions another

For each clear, confident relationship between the listed entities, output a JSON object with:
- "fromEntityId": id of the source entity
- "toEntityId": id of the target entity
- "relation": one of the allowed types
- "confidence": a number 0.0–1.0

Return ONLY a JSON array. Return [] if no confident relationships exist. Do NOT invent relationships.

TEXT:
"""
${input.noteText.slice(0, 1500)}
"""`;

    try {
      const raw = await this.generate(prompt);
      const parsed = tryParseJson<ExtractedEntityRelation[]>(raw);
      if (!Array.isArray(parsed)) return [];
      const validEntityIds = new Set(input.entities.map((e) => e.id));
      const validRelations = new Set<string>(ENTITY_RELATION_TYPES);
      return parsed.filter(
        (r) =>
          r &&
          typeof r.fromEntityId === "string" &&
          typeof r.toEntityId === "string" &&
          validEntityIds.has(r.fromEntityId) &&
          validEntityIds.has(r.toEntityId) &&
          r.fromEntityId !== r.toEntityId &&
          typeof r.relation === "string" &&
          validRelations.has(r.relation) &&
          typeof r.confidence === "number" &&
          r.confidence >= 0.5,
      );
    } catch (err) {
      logger.warn({ err }, "extractEntityRelations (gemini) failed");
      return [];
    }
  }
}

class StubLLMClient implements LLMClient {
  async classifyNotes(
    text: string,
    _hint?: { source?: string | null; author?: string | null },
  ): Promise<ClassifiedNote[]> {
    const firstLine =
      text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? text;
    return [
      {
        type: "note",
        title: (firstLine || "Untitled note").slice(0, 80),
        body: text,
        summary: undefined,
        tags: [],
      },
    ];
  }
  async extractEntities(_text: string): Promise<ExtractedEntity[]> {
    return [];
  }
  async interpretQuery(_query: string): Promise<string | null> {
    return null;
  }
  async synthesize(
    _query: string,
    _bundleMarkdown: string,
  ): Promise<{ title: string; body: string; summary: string } | null> {
    return null;
  }
  async extractNoteRelations(
    _notes: NoteRelationCandidate[],
  ): Promise<ExtractedNoteRelation[]> {
    return [];
  }
  async extractEntityRelations(_input: {
    noteText: string;
    entities: { id: string; type: string; name: string }[];
  }): Promise<ExtractedEntityRelation[]> {
    return [];
  }
}

const stubClient = new StubLLMClient();

export function getLLMClient(): LLMClient {
  if (!isGeminiConfigured()) {
    return stubClient;
  }
  return new GeminiLLMClient();
}
