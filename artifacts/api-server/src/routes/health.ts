import { Router, type IRouter } from "express";
import { checkSchema } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  try {
    const result = await checkSchema();
    if (!result.ok) {
      res.status(503).json({
        status: "unhealthy",
        reason: `missing tables: ${result.missing.join(", ")}`,
      });
      return;
    }
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({
      status: "unhealthy",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
