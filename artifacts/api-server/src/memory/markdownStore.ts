import { promises as fs } from "node:fs";
import path from "node:path";
import type { NoteWithEntities } from "./repository";
import { logger } from "../lib/logger";

const MD_DIR = process.env.MEMORY_MD_DIR ?? path.resolve(process.cwd(), ".data/notes");

function safeFilename(note: NoteWithEntities): string {
  const slug = note.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${note.id}-${slug || "note"}.md`;
}

export function noteToMarkdown(note: NoteWithEntities): string {
  const fm = [
    "---",
    `id: ${note.id}`,
    `type: ${note.type}`,
    `title: ${JSON.stringify(note.title)}`,
    `created: ${note.createdAt.toISOString()}`,
    `tags: [${(note.tags ?? []).map((t) => JSON.stringify(t)).join(", ")}]`,
    `entities: [${note.entities.map((e) => JSON.stringify(`${e.type}:${e.name}`)).join(", ")}]`,
    "---",
    "",
    `# ${note.title}`,
    "",
  ];
  if (note.summary) {
    fm.push(`> ${note.summary}`, "");
  }
  fm.push(note.body);
  return fm.join("\n");
}

export async function writeNoteMarkdown(
  note: NoteWithEntities,
): Promise<string | null> {
  try {
    await fs.mkdir(MD_DIR, { recursive: true });
    const filename = safeFilename(note);
    await fs.writeFile(path.join(MD_DIR, filename), noteToMarkdown(note), "utf8");
    return path.join(path.relative(process.cwd(), MD_DIR), filename);
  } catch (err) {
    logger.warn({ err, noteId: note.id }, "Failed to write markdown export");
    return null;
  }
}

export function notesBundleMarkdown(notes: NoteWithEntities[]): string {
  return notes.map((n) => noteToMarkdown(n)).join("\n\n---\n\n");
}
