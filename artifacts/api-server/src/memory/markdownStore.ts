import { promises as fs } from "node:fs";
import path from "node:path";
import type { NoteWithEntities } from "./repository";
import { logger } from "../lib/logger";

const MD_BASE_DIR = process.env.MEMORY_MD_DIR ?? path.resolve(process.cwd(), ".data/notes");

/**
 * Produce a collision-proof directory name for a tenant by appending a short
 * prefix of the UUID to the sanitized slug.  This prevents distinct slugs
 * that differ only in special characters (e.g. "foo.bar" vs "foo!bar") from
 * sharing the same export directory.
 */
function tenantDir(tenantSlug: string, tenantId: string): string {
  const safePart = tenantSlug.replace(/[^a-z0-9-_]/gi, "_").replace(/__+/g, "_").replace(/^_|_$/g, "") || "tenant";
  const idPrefix = tenantId.replace(/-/g, "").slice(0, 8);
  return path.join(MD_BASE_DIR, `${safePart}-${idPrefix}`);
}

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
  tenantSlug: string,
  tenantId: string,
): Promise<string | null> {
  try {
    const dir = tenantDir(tenantSlug, tenantId);
    await fs.mkdir(dir, { recursive: true });
    const filename = safeFilename(note);
    const fullPath = path.join(dir, filename);
    await fs.writeFile(fullPath, noteToMarkdown(note), "utf8");
    return path.join(path.relative(process.cwd(), dir), filename);
  } catch (err) {
    logger.warn({ err, noteId: note.id }, "Failed to write markdown export");
    return null;
  }
}

export function notesBundleMarkdown(notes: NoteWithEntities[]): string {
  return notes.map((n) => noteToMarkdown(n)).join("\n\n---\n\n");
}
