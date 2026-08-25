import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { createHmac, timingSafeEqual } from "node:crypto";
import router from "./routes";
import { logger } from "./lib/logger";
import { startOrchestrationScheduler } from "./services/orchestration";
import { invalidateCache } from "./services/cache";
import { AnalystRequestValidationError } from "./routes/analyst/shared";

const app: Express = express();
const isProduction = process.env.NODE_ENV === "production";
const configuredOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
let generatedRequestId = 0;

app.use(
  pinoHttp({
    logger,
    genReqId(req) {
      const provided = req.headers["x-request-id"];
      return typeof provided === "string" && /^[a-zA-Z0-9._-]{1,120}$/.test(provided)
        ? provided
        : String(++generatedRequestId);
    },
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
  res.setHeader("X-Request-ID", String(req.id));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!isProduction) return callback(null, true);
    return callback(null, !origin || configuredOrigins.has(origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const isRoutineOperation = /^\/api\/analyst\/(?:orchestration|refresh\/|market-board\/refresh)/.test(req.path);
  const isUnlock = req.path === "/api/analyst/operations/operator-session" || req.path === "/api/analyst/ai/operator-session";
  const requireOperatorApproval = isProduction || process.env.REQUIRE_OPERATOR_APPROVAL === "true";
  if (!requireOperatorApproval || !isWrite || isUnlock) return next();
  const secret = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
  const requiredCapability = isRoutineOperation ? "OPERATIONS" : "AI_REVIEW";
  const cookieName = requiredCapability === "OPERATIONS" ? "operations_operator_approval" : "ai_operator_approval";
  const rawCookie = req.headers.cookie?.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(`${cookieName}=`))?.slice(`${cookieName}=`.length);
  if (!secret || !rawCookie || !rawCookie.includes(".")) {
    res.status(403).json({ error: `A valid ${requiredCapability === "OPERATIONS" ? "Operations" : "AI review"} approval session is required for this action.`, requestId: req.id });
    return;
  }
  const [payload, signature] = rawCookie.split(".");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("signature mismatch");
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { expiresAt?: unknown; capability?: unknown };
    if (session.capability !== requiredCapability || typeof session.expiresAt !== "number" || session.expiresAt < Date.now()) throw new Error("expired");
    next();
  } catch {
    res.status(403).json({ error: "The required approval session is expired or invalid.", requestId: req.id });
  }
});
app.use((req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 400) invalidateCache("");
    });
  }
  next();
});

app.use("/api", router);
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof AnalystRequestValidationError) {
    req.log.warn({ code: error.code, requestId: req.id }, "invalid analyst request");
    res.status(400).json({ error: error.message, code: error.code, requestId: String(req.id) });
    return;
  }
  req.log.error({ err: error, requestId: req.id }, "unhandled request error");
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR", requestId: String(req.id) });
});

startOrchestrationScheduler();

export default app;
