/**
 * Backfill embeddings for all notes where embedding IS NULL.
 * Usage: pnpm --filter @workspace/api-server run backfill:embeddings
 *
 * Idempotent — safe to re-run. Uses keyset pagination (cursor on createdAt + id)
 * so it correctly handles the shrinking-result-set problem: as rows are updated
 * to non-null they naturally fall out of the WHERE clause and don't cause skips.
 * Processes notes in batches of 100, logs progress every 10 batches, sleeps 1s
 * between batches, backs off 4× on Voyage 429/5xx.
 */
import { db, notes } from "@workspace/db";
import { and, asc, gt, isNull, or, eq, sql } from "drizzle-orm";
import { embedBatch } from "../memory/voyage-client.js";
import { logger } from "../lib/logger.js";

const BATCH_SIZE = 100;
const LOG_EVERY = 10;
const RATE_LIMIT_SLEEP_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY environment variable is not set");
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notes)
    .where(isNull(notes.embedding));
  const total = Number(countRow.count);

  logger.info({ total }, "backfill: starting embedding backfill");
  console.log(`Found ${total} notes with missing embeddings.`);

  let processed = 0;
  let batchNum = 0;
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;

  while (true) {
    let whereClause;
    if (cursorCreatedAt === null || cursorId === null) {
      whereClause = isNull(notes.embedding);
    } else {
      whereClause = and(
        isNull(notes.embedding),
        or(
          gt(notes.createdAt, cursorCreatedAt),
          and(
            eq(notes.createdAt, cursorCreatedAt),
            gt(notes.id, cursorId),
          ),
        ),
      );
    }

    const rows = await db
      .select({
        id: notes.id,
        tenantId: notes.tenantId,
        title: notes.title,
        body: notes.body,
        summary: notes.summary,
        createdAt: notes.createdAt,
      })
      .from(notes)
      .where(whereClause)
      .orderBy(asc(notes.createdAt), asc(notes.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    const texts = rows.map((r) =>
      [r.title, r.summary ?? "", r.body].filter(Boolean).join("\n"),
    );

    let embedResults: (number[] | null)[];
    try {
      const batchResult = await embedBatch(texts, "document");
      embedResults = batchResult.embeddings;
    } catch (err) {
      logger.warn({ err, batchNum }, "backfill: batch embed failed, backing off and retrying from same cursor");
      await sleep(RATE_LIMIT_SLEEP_MS * 4);
      continue;
    }

    for (let i = 0; i < rows.length; i++) {
      const embedding = embedResults[i];
      if (!embedding) {
        logger.warn({ noteId: rows[i].id }, "backfill: no embedding returned for note");
        cursorCreatedAt = rows[i].createdAt;
        cursorId = rows[i].id;
        continue;
      }
      const vectorLiteral = `[${embedding.join(",")}]`;
      await db.execute(
        sql`UPDATE notes SET embedding = ${sql.raw(`'${vectorLiteral}'::vector`)} WHERE id = ${rows[i].id}`,
      );
    }

    processed += rows.length;
    batchNum++;
    cursorCreatedAt = rows[rows.length - 1].createdAt;
    cursorId = rows[rows.length - 1].id;

    if (batchNum % LOG_EVERY === 0) {
      logger.info({ processed, total, batchNum }, "backfill: progress");
      console.log(`Progress: ${processed}/${total} (batch ${batchNum})`);
    }

    await sleep(RATE_LIMIT_SLEEP_MS);
  }

  logger.info({ processed, total }, "backfill: complete");
  console.log(`Done. Embedded ${processed}/${total} notes.`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
