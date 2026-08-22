/**
 * Phase 4A – DB-level immutability enforcement for the feature store.
 *
 * Applies (idempotently via CREATE OR REPLACE / IF NOT EXISTS):
 *   1. Trigger function + triggers preventing UPDATE/DELETE on
 *      pregame_feature_snapshots and historical_outcomes.
 *   2. CHECK constraint tying correction_of / correction_reason nullability.
 *   3. Partial unique index ensuring one original snapshot per
 *      (player_id, game_pk, market, feature_hash) triplet.
 *
 * Safe to run multiple times — all statements are idempotent.
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const statements = [
  // ── 1. Trigger function: raise on any UPDATE or DELETE ──────────────────
  `
  CREATE OR REPLACE FUNCTION prevent_pregame_feature_snapshot_mutation()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    -- Allow the operation when the session-scoped bypass is set.
    -- This is only used by acceptance-test cleanup and must never be set
    -- in production application code.
    IF current_setting('app.bypass_immutability', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION
        'pregame_feature_snapshots is immutable. '
        'To correct a snapshot create a new row with correction_of = OLD.snapshot_id.';
    ELSIF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'pregame_feature_snapshots rows must never be deleted. '
        'Immutability is a core data-integrity guarantee of Phase 4A.';
    END IF;
    RETURN NULL;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION prevent_historical_outcome_mutation()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF current_setting('app.bypass_immutability', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION
        'historical_outcomes is append-only. '
        'Write a new row instead of updating an existing one.';
    ELSIF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'historical_outcomes rows must never be deleted. '
        'Append-only semantics are a core data-integrity guarantee of Phase 4A.';
    END IF;
    RETURN NULL;
  END;
  $$
  `,

  // ── 2. Triggers (dropped-then-created so the function change takes effect) ─
  `DROP TRIGGER IF EXISTS pregame_feature_snapshots_immutable
   ON pregame_feature_snapshots`,

  `
  CREATE TRIGGER pregame_feature_snapshots_immutable
  BEFORE UPDATE OR DELETE ON pregame_feature_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_pregame_feature_snapshot_mutation()
  `,

  `DROP TRIGGER IF EXISTS historical_outcomes_append_only
   ON historical_outcomes`,

  `
  CREATE TRIGGER historical_outcomes_append_only
  BEFORE UPDATE OR DELETE ON historical_outcomes
  FOR EACH ROW EXECUTE FUNCTION prevent_historical_outcome_mutation()
  `,

  // ── 3. CHECK constraint: correction_reason required when correction_of set ─
  // Add only if it doesn't already exist (idempotent via DO block).
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'pregame_feature_snapshots'
        AND constraint_name = 'correction_consistency'
    ) THEN
      ALTER TABLE pregame_feature_snapshots
        ADD CONSTRAINT correction_consistency
        CHECK ((correction_of IS NULL) OR (correction_reason IS NOT NULL));
    END IF;
  END;
  $$
  `,

  // ── 4. Partial unique index for hash idempotency ────────────────────────
  `
  CREATE UNIQUE INDEX IF NOT EXISTS pfs_original_unique_hash_idx
  ON pregame_feature_snapshots (player_id, game_pk, market, feature_hash)
  WHERE correction_of IS NULL
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

console.log(`\napply-immutability: ${ok} OK, ${failed} failed.`);
if (failed > 0) process.exit(1);
