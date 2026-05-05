import app from "./app";
import { logger } from "./lib/logger";
import { checkSchema, ensureEmbeddingColumn } from "@workspace/db";
import { backfillEmbeddings } from "./memory/services";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function startServer() {
  logger.info("Checking database schema...");

  const schemaResult = await checkSchema();

  if (!schemaResult.ok) {
    logger.fatal(
      { missingTables: schemaResult.missing },
      [
        "Database schema is incomplete — required tables are missing.",
        `Missing: ${schemaResult.missing.join(", ")}.`,
        "Run `pnpm --filter @workspace/db run setup` to apply the schema, then restart.",
      ].join(" "),
    );
    process.exit(1);
  }

  logger.info("Database schema OK.");

  await ensureEmbeddingColumn();
  logger.info("Embedding column ready.");

  await new Promise<void>((resolve, reject) => {
    app.listen(port, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  logger.info({ port }, "Server listening");

  // async backfill — does not block startup
  backfillEmbeddings().catch((err) =>
    logger.error({ err }, "backfill-embeddings: unexpected error"),
  );
}

startServer().catch((err) => {
  logger.fatal({ err }, "Error starting server");
  process.exit(1);
});
