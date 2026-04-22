import type { Request, Response, NextFunction, RequestHandler } from "express";
import { logger } from "../lib/logger";

const HEADER = "authorization";
const PREFIX = "Bearer ";

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Build the key→tenant map from environment configuration.
 *
 * Priority:
 *   1. MEMORY_API_KEYS — a JSON object mapping API key strings to tenant slugs.
 *      e.g. MEMORY_API_KEYS='{"key-alpha":"tenant-a","key-beta":"tenant-b"}'
 *   2. MEMORY_API_KEY  — single key, mapped to the "default" tenant (backward compat).
 *
 * Both variables may be set simultaneously; entries from MEMORY_API_KEYS take
 * precedence, and the single MEMORY_API_KEY is added with slug "default" unless
 * that key is already listed in MEMORY_API_KEYS.
 */
function buildKeyMap(): Map<string, string> {
  const map = new Map<string, string>();

  const multiKeysRaw = process.env["MEMORY_API_KEYS"];
  if (multiKeysRaw && multiKeysRaw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(multiKeysRaw);
    } catch {
      logger.fatal(
        "MEMORY_API_KEYS is set but is not valid JSON. Refusing to start.",
      );
      process.exit(1);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.fatal(
        "MEMORY_API_KEYS must be a JSON object mapping API keys to tenant slugs. Refusing to start.",
      );
      process.exit(1);
    }
    for (const [key, slug] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof slug !== "string" || slug.trim() === "") {
        logger.fatal(
          { key },
          "MEMORY_API_KEYS: every value must be a non-empty tenant slug string. Refusing to start.",
        );
        process.exit(1);
      }
      map.set(key.trim(), slug.trim());
    }
  }

  const singleKey = process.env["MEMORY_API_KEY"];
  if (singleKey && singleKey.trim() !== "") {
    const trimmed = singleKey.trim();
    if (!map.has(trimmed)) {
      map.set(trimmed, "default");
    }
  }

  if (map.size === 0) {
    logger.fatal(
      "Neither MEMORY_API_KEYS nor MEMORY_API_KEY environment variable is set. Refusing to start.",
    );
    process.exit(1);
  }

  return map;
}

const KEY_MAP = buildKeyMap();

/** Resolve a bearer token to a tenant slug, or null if unrecognized. */
function resolveTenant(token: string): string | null {
  for (const [key, slug] of KEY_MAP) {
    if (timingSafeEquals(token, key)) {
      return slug;
    }
  }
  return null;
}

export function requireApiKey(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header(HEADER) ?? "";
    if (!header.startsWith(PREFIX)) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const token = header.slice(PREFIX.length).trim();
    if (!token) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    const slug = resolveTenant(token);
    if (slug === null) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    res.locals["tenantSlug"] = slug;
    next();
  };
}
