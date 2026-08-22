/**
 * Phase 4A – DB-level immutability enforcement for the feature store.
 *
 * Applies (idempotently via CREATE OR REPLACE / IF NOT EXISTS):
 *   1. Trigger function + triggers preventing UPDATE/DELETE on
 *      pregame_feature_snapshots, historical_outcomes, and market_postmortems.
 *   2. CHECK constraints tying correction fields and official settlement state.
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

  `
  CREATE OR REPLACE FUNCTION prevent_market_postmortem_mutation()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF current_setting('app.bypass_immutability', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'market_postmortems is immutable. '
      'Postmortems are append-only records of a settled outcome.';
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION prevent_ai_settlement_write()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF upper(current_setting('app.writer_context', true)) = 'AI' THEN
      RAISE EXCEPTION
        'AI writers cannot write settlement or postmortem tables.';
    END IF;
    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION validate_official_settlement_insert()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE
    original historical_outcomes%ROWTYPE;
  BEGIN
    IF NEW.source_id <> 'MLB_OFFICIAL' THEN
      RAISE EXCEPTION 'Settlement outcomes must use the MLB_OFFICIAL source.';
    END IF;

    IF (NEW.correction_of IS NULL) <> (NEW.process_error_taxonomy IS NULL) THEN
      RAISE EXCEPTION
        'Settlement corrections must have both correction_of and an approved process-error taxonomy.';
    END IF;

    IF NEW.correction_of IS NOT NULL THEN
      SELECT * INTO original FROM historical_outcomes WHERE outcome_id = NEW.correction_of;
      IF NOT FOUND OR original.settlement_state NOT IN ('SETTLED', 'POSTPONED', 'NO_ACTION', 'DISPUTED')
         OR original.player_id <> NEW.player_id
         OR original.game_pk <> NEW.game_pk
         OR original.market <> NEW.market THEN
        RAISE EXCEPTION
          'Settlement correction_of must reference a SETTLED outcome for the same player, game, and market.';
      END IF;
    END IF;

    IF NEW.settlement_state IN ('SETTLED', 'POSTPONED', 'NO_ACTION', 'DISPUTED') THEN
      IF NEW.ingest_run_id IS NULL
         OR NOT (NEW.official_source_metadata ? 'provider')
         OR NEW.official_source_metadata->>'provider' <> 'MLB Stats API'
         OR COALESCE(NEW.official_source_metadata->>'endpoint', '') !~ '^https://statsapi\.mlb\.com/' THEN
        RAISE EXCEPTION
          'SETTLED outcomes require MLB Stats API provenance and a settlement ingest run.';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM ingest_runs
         WHERE ingest_run_id = NEW.ingest_run_id
           AND source_id = 'MLB_OFFICIAL'
           AND job_name = 'mlb-official-settlement'
      ) THEN
        RAISE EXCEPTION
          'SETTLED outcomes require a matching MLB official settlement ingest run.';
      END IF;
    ELSIF NEW.correction_of IS NOT NULL THEN
      RAISE EXCEPTION 'Settlement corrections must be written as terminal settlement rows.';
    END IF;

    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION validate_market_postmortem_insert()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF upper(current_setting('app.writer_context', true)) = 'AI' THEN
      RAISE EXCEPTION 'AI writers cannot write settlement or postmortem tables.';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pregame_feature_snapshots pfs
      JOIN historical_outcomes ho
        ON ho.outcome_id = NEW.outcome_id
       AND ho.player_id = pfs.player_id
       AND ho.game_pk = pfs.game_pk
       AND ho.market = pfs.market
       AND ho.settlement_state = 'SETTLED'
       AND ho.source_id = 'MLB_OFFICIAL'
      WHERE pfs.snapshot_id = NEW.snapshot_id
        AND NEW.player_id = pfs.player_id
        AND NEW.game_pk = pfs.game_pk
        AND NEW.market = pfs.market
        AND NEW.snapshot_feature_hash = pfs.feature_hash
        AND NEW.outcome_value = ho.outcome_value
        AND NEW.outcome_hit = ho.outcome_hit
    ) THEN
      RAISE EXCEPTION
        'Postmortems require matching frozen snapshot and SETTLED MLB official outcome fields.';
    END IF;
    RETURN NEW;
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

  `DROP TRIGGER IF EXISTS market_postmortems_immutable
   ON market_postmortems`,

  `
  CREATE TRIGGER market_postmortems_immutable
  BEFORE UPDATE OR DELETE ON market_postmortems
  FOR EACH ROW EXECUTE FUNCTION prevent_market_postmortem_mutation()
  `,

  `DROP TRIGGER IF EXISTS historical_outcomes_ai_write_guard
   ON historical_outcomes`,

  `
  CREATE TRIGGER historical_outcomes_ai_write_guard
  BEFORE INSERT ON historical_outcomes
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_settlement_write()
  `,

  `DROP TRIGGER IF EXISTS historical_outcomes_official_settlement_guard
   ON historical_outcomes`,

  `
  CREATE TRIGGER historical_outcomes_official_settlement_guard
  BEFORE INSERT ON historical_outcomes
  FOR EACH ROW EXECUTE FUNCTION validate_official_settlement_insert()
  `,

  `DROP TRIGGER IF EXISTS market_postmortems_ai_write_guard
   ON market_postmortems`,

  `
  CREATE TRIGGER market_postmortems_ai_write_guard
  BEFORE INSERT ON market_postmortems
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_settlement_write()
  `,

  `DROP TRIGGER IF EXISTS market_postmortems_linkage_guard
   ON market_postmortems`,

  `
  CREATE TRIGGER market_postmortems_linkage_guard
  BEFORE INSERT ON market_postmortems
  FOR EACH ROW EXECUTE FUNCTION validate_market_postmortem_insert()
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

  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'historical_outcomes'
        AND constraint_name = 'historical_outcome_correction_consistency'
    ) THEN
      ALTER TABLE historical_outcomes
        ADD CONSTRAINT historical_outcome_correction_consistency
        CHECK ((correction_of IS NULL) OR (process_error_taxonomy IS NOT NULL));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'historical_outcomes'
        AND constraint_name = 'historical_outcome_official_source'
    ) THEN
      ALTER TABLE historical_outcomes
        ADD CONSTRAINT historical_outcome_official_source
        CHECK (source_id = 'MLB_OFFICIAL');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'historical_outcomes'
        AND constraint_name = 'historical_outcome_settled_at'
    ) THEN
      ALTER TABLE historical_outcomes
        ADD CONSTRAINT historical_outcome_settled_at
        CHECK (settlement_state <> 'SETTLED' OR settled_at IS NOT NULL);
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
  `
  DROP INDEX IF EXISTS historical_outcomes_settled_original_idx
  `,
  `
  CREATE UNIQUE INDEX IF NOT EXISTS historical_outcomes_settled_original_idx
  ON historical_outcomes (player_id, game_pk, market)
  WHERE settlement_state IN ('SETTLED', 'POSTPONED', 'NO_ACTION', 'DISPUTED')
    AND correction_of IS NULL
  `,
  `
  CREATE UNIQUE INDEX IF NOT EXISTS market_postmortems_snapshot_outcome_idx
  ON market_postmortems (snapshot_id, outcome_id)
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
