import type { RequestHandler } from "express";

const expectedKey = process.env["MEMORY_API_KEY"];

if (!expectedKey || expectedKey.trim() === "") {
  throw new Error(
    "MEMORY_API_KEY environment variable is required but was not provided.",
  );
}

const EXPECTED = expectedKey.trim();

function extractKey(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export const requireApiKey: RequestHandler = (req, res, next) => {
  const fromAuth = extractKey(
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : undefined,
  );
  const rawApiKey = req.headers["x-api-key"];
  const fromHeader =
    typeof rawApiKey === "string"
      ? rawApiKey.trim() || null
      : Array.isArray(rawApiKey) && typeof rawApiKey[0] === "string"
        ? rawApiKey[0].trim() || null
        : null;

  const provided = fromAuth ?? fromHeader;

  if (!provided) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  if (provided !== EXPECTED) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
};
