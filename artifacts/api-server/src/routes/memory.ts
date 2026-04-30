import { Router, type IRouter, type Response } from "express";
import {
  IngestTextBody,
  GetNoteParams,
  SearchNotesBody,
  BuildContextBody,
  QueryGraphEntitiesQueryParams,
} from "@workspace/api-zod";
import { ZodError } from "zod";
import {
  buildContext,
  fetchNote,
  ingestText,
  queryGraphEntities,
  searchNotes,
} from "../memory/services";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function handleError(res: Response, err: unknown) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  logger.error({ err }, "Memory route failed");
  res.status(500).json({ error: "Internal server error" });
}

function getTenantSlug(res: Response): string {
  return res.locals["tenantSlug"] as string;
}

router.post("/ingest/text", async (req, res) => {
  try {
    const body = IngestTextBody.parse(req.body);
    const out = await ingestText(body, getTenantSlug(res));
    res.json(out);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/notes/:id", async (req, res) => {
  try {
    const params = GetNoteParams.parse(req.params);
    const note = await fetchNote(params.id, getTenantSlug(res));
    if (!note) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    res.json(note);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/search", async (req, res) => {
  try {
    const body = SearchNotesBody.parse(req.body);
    const out = await searchNotes(body, getTenantSlug(res));
    res.json(out);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/graph/entities", async (req, res) => {
  try {
    const params = QueryGraphEntitiesQueryParams.parse(req.query);
    const out = await queryGraphEntities(params, getTenantSlug(res));
    res.json(out);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/context/build", async (req, res) => {
  try {
    const body = BuildContextBody.parse(req.body);
    const out = await buildContext(body, getTenantSlug(res));
    res.json(out);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
