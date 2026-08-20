import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analystRouter from "./analyst";

const router: IRouter = Router();

router.use(healthRouter);
router.use(analystRouter);

export default router;
