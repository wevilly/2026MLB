import app from "./app";
import { logger } from "./lib/logger";
import { closePool } from "@workspace/db";

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

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Deliberate restarts terminate database connections; finish in-flight
// requests, drain the pool, then exit, so an intentional deploy never
// surfaces as a crash-with-stack in the logs.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutdown requested; draining");
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
