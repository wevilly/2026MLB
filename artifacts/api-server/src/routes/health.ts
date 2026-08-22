import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const freshness = await pool.query<{ stale: number }>(
      `SELECT count(*)::int AS stale FROM ingest_runs
       WHERE status = 'FAILED' AND started_at > now() - interval '24 hours'`,
    );
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json({ ...data, dependencies: { database: "ok", recentFailedIngests: freshness.rows[0]?.stale ?? 0 }, requestId: req.id });
  } catch (error) {
    req.log.error({ err: error }, "health check dependency failure");
    res.status(503).json({ status: "degraded", dependencies: { database: "unavailable" }, requestId: req.id });
  }
});

export default router;
