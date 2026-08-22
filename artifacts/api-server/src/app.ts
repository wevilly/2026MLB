import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import router from "./routes";
import { logger } from "./lib/logger";
import { startOrchestrationScheduler } from "./services/orchestration";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req, res, next) => {
  const requestId = typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].length <= 120
    ? req.headers["x-request-id"]
    : randomUUID();
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const isUnlock = req.path === "/api/analyst/ai/operator-session";
  if (process.env.NODE_ENV !== "production" || !isWrite || isUnlock) return next();
  const secret = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
  const rawCookie = req.headers.cookie?.split(";").map((value) => value.trim())
    .find((value) => value.startsWith("ai_operator_approval="))?.slice("ai_operator_approval=".length);
  if (!secret || !rawCookie || !rawCookie.includes(".")) {
    res.status(403).json({ error: "A valid operator approval session is required for write actions.", requestId: req.id });
    return;
  }
  const [payload, signature] = rawCookie.split(".");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("signature mismatch");
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { expiresAt?: unknown };
    if (typeof session.expiresAt !== "number" || session.expiresAt < Date.now()) throw new Error("expired");
    next();
  } catch {
    res.status(403).json({ error: "The operator approval session is expired or invalid.", requestId: req.id });
  }
});

app.use("/api", router);
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  req.log.error({ err: error, requestId: req.id }, "unhandled request error");
  res.status(500).json({ error: "Internal server error", requestId: req.id, detail: process.env.NODE_ENV === "production" ? undefined : message });
});

startOrchestrationScheduler();

export default app;
