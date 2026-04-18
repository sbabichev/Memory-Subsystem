import { Router, type IRouter } from "express";
import healthRouter from "./health";
import memoryRouter from "./memory";
import { requireApiKey } from "../middlewares/apiKey";

const router: IRouter = Router();

// /healthz is public so liveness checks don't need a key.
router.use(healthRouter);
router.use(requireApiKey(), memoryRouter);

export default router;
