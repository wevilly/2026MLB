/**
 * Schema migrations that drizzle-kit push cannot express safely on its own.
 *
 * drizzle-kit push diffs the declared schema against the live database and
 * emits DDL. It cannot remove a value from a PostgreSQL enum, and it cannot
 * carry a data backfill across a type change. Anything of that shape is written
 * here as an explicit, idempotent statement and runs BEFORE push, so that push
 * then sees a database that already matches the declared schema.
 *
 * Safe to run multiple times. Every statement is guarded.
 *
 * Migrations applied:
 *   M1  confidence_basis: split MODEL_REJECTED into ARTIFACT_INVALID,
 *       MARKET_MISMATCH, INSUFFICIENT_FEATURES and MODEL_DECLINED. Existing
 *       rows are backfilled to RESEARCH_ONLY, which is what all of them are.
 *       (Remediation task 2.3.)
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const statements = [
  // ── M1. confidence_basis enum split ───────────────────────────────────────
  //
  // Guarded on the presence of MODEL_REJECTED, so a database already migrated
  // is left untouched. The USING clause is the backfill: every MODEL_REJECTED
  // row becomes RESEARCH_ONLY. There is no lossless mapping, because the old
  // value did not record which of the four conditions produced it, and every
  // row currently carrying it was produced with no ACTIVE model at all.
  `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'confidence_basis'
         AND e.enumlabel = 'MODEL_REJECTED'
    ) THEN
      ALTER TYPE confidence_basis RENAME TO confidence_basis_pre_task_2_3;

      CREATE TYPE confidence_basis AS ENUM (
        'RESEARCH_ONLY',
        'MODEL_CONFIRMED',
        'MODEL_DECLINED',
        'ARTIFACT_INVALID',
        'MARKET_MISMATCH',
        'INSUFFICIENT_FEATURES'
      );

      ALTER TABLE daily_market_board
        ALTER COLUMN confidence_basis DROP DEFAULT;

      ALTER TABLE daily_market_board
        ALTER COLUMN confidence_basis TYPE confidence_basis
        USING (
          CASE confidence_basis::text
            WHEN 'MODEL_REJECTED' THEN 'RESEARCH_ONLY'
            ELSE confidence_basis::text
          END
        )::confidence_basis;

      ALTER TABLE daily_market_board
        ALTER COLUMN confidence_basis SET DEFAULT 'RESEARCH_ONLY';

      DROP TYPE confidence_basis_pre_task_2_3;
    END IF;
  END
  $$
  `,
];

let ok = 0;
let failed = 0;

for (const sql of statements) {
  const label = sql.trim().split('\n')[0].slice(0, 80);
  try {
    await pool.query(sql);
    console.log(`  ✔ ${label}`);
    ok++;
  } catch (err) {
    console.error(`  ✖ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

await pool.end();

console.log(`\npre-push-migrations: ${ok} OK, ${failed} failed.`);
if (failed > 0) process.exit(1);
