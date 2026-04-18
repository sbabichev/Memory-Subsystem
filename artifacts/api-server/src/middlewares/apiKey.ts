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

export function requireApiKey(): RequestHandler {
  const expected = process.env.MEMORY_API_KEY;
  if (!expected) {
    // Fail-closed: never start serving protected routes without a configured key.
    logger.fatal(
      "MEMORY_API_KEY is not set. Refusing to start the memory API without an API key configured.",
    );
    throw new Error(
      "MEMORY_API_KEY environment variable is required to start the memory API.",
    );
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header(HEADER) ?? "";
    if (!header.startsWith(PREFIX)) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const token = header.slice(PREFIX.length).trim();
    if (!token || !timingSafeEquals(token, expected!)) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    next();
  };
}
