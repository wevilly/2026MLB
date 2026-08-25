import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

// A killed idle client ("terminating connection due to administrator command"
// during a deploy or managed-Postgres scale-down) emits 'error' on the pool.
// Without a listener that event is an uncaught exception and the whole process
// dies; with it, the pool discards the dead client and creates a fresh one on
// the next checkout.
pool.on("error", (error) => {
  console.error(
    `postgres pool: idle client error (client dropped, pool recovers): ${error.message}`,
  );
});

/** Drains the pool for graceful shutdown. */
export async function closePool(): Promise<void> {
  await pool.end();
}

export const db = drizzle(pool, { schema });

export * from "./schema";
