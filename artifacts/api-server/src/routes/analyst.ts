/**
 * The analyst API surface.
 *
 * Every route lives in a domain module under routes/analyst/ and is mounted
 * here at the SAME absolute path it always had, so no URL changed. Task 5.2
 * split the previous 2,405-line, 70-route file, which was past the read limit
 * of standard tooling and was therefore the largest unreviewed surface in the
 * application.
 *
 * MOUNT ORDER IS LOAD BEARING. Express matches in registration order across
 * mounted routers, so the order below preserves the relative order the routes
 * had in the original file. In particular the parameterised
 * POST /analyst/settlements/:gamePk must not shadow its literal siblings
 * /analyst/settlements/automate and /analyst/settlements/ingest; those three
 * live in the settlement module and keep their original relative order there.
 *
 * routes/analyst/ROUTE-INVENTORY.txt pins the URL surface as it stood before
 * the split, and tests/analyst-routes.test.ts diffs the registered routes
 * against it.
 */
import { Router, type IRouter } from "express";
import researchRouter from "./analyst/research";
import orchestrationRouter from "./analyst/orchestration";
import settlementRouter from "./analyst/settlement";
import refreshRouter from "./analyst/refresh";
import bullpenRouter from "./analyst/bullpen";
import featurestoreRouter from "./analyst/feature-store";
import modelsRouter from "./analyst/models";
import marketboardRouter from "./analyst/market-board";
import bettorRouter from "./analyst/bettor";
import aiRouter from "./analyst/ai";

const router: IRouter = Router();

router.use(researchRouter);
router.use(orchestrationRouter);
router.use(settlementRouter);
router.use(refreshRouter);
router.use(bullpenRouter);
router.use(featurestoreRouter);
router.use(modelsRouter);
router.use(marketboardRouter);
router.use(bettorRouter);
router.use(aiRouter);

export default router;
