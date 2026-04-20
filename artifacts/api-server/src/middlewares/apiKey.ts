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

const expectedKey = process.env["MEMORY_API_KEY"];

if (!expectedKey || expectedKey.trim() === "") {
  logger.fatal(
    "MEMORY_API_KEY environment variable is required but was not set. Refusing to start.",
  );
  process.exit(1);
}

const EXPECTED = expectedKey.trim();

export function requireApiKey(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header(HEADER) ?? "";
    if (!header.startsWith(PREFIX)) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const token = header.slice(PREFIX.length).trim();
    if (!token || !timingSafeEquals(token, EXPECTED)) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    next();
  };
}
