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
 *   M2  snapshot_correction_reason: add GAME_RESUMPTION and
 *       OFFICIAL_STAT_CORRECTION, the two real settlement transitions that had
 *       no taxonomy value at all. (Remediation task 3.3.)
 *   M3  walk_forward_runs: rename calibration_error to
 *       mean_absolute_prediction_error and add the six new metric columns.
 *       THIS IS THE MIGRATION THAT UNBLOCKS push. See the note below.
 *   M4  game_weather_observations: create the table. push never created it, so
 *       the two append-only triggers had nothing to attach to.
 *   M5  Additive columns push never applied, because push aborted before it
 *       applied anything at all.
 *   M6  players.bats and players.throws: normalise the empty string to NULL, so
 *       that unknown handedness is a distinguishable value. (Audit S1.)
 *
 * WHY M3 EXISTS, AND WHY IT COMES FIRST
 *
 * drizzle-kit push aborted with:
 *
 *   Error: Interactive prompts require a TTY terminal
 *     at promptColumnsConflicts (drizzle-kit/bin.cjs:32711:65)
 *
 * promptColumnsConflicts fires when push sees a column dropped and a column
 * added on the SAME table in one diff and cannot tell a rename from a
 * create-plus-drop. It wants a human to answer. In the postMerge hook there is
 * no human, so it aborts and takes every other statement in the diff with it.
 *
 * walk_forward_runs is the only table in this schema with that shape:
 * calibration_error was dropped, and expected_calibration_error and
 * mean_absolute_prediction_error were added. Every other change in the diff is
 * purely additive, and push applies additions without prompting. So creating
 * the weather table alone does NOT unblock push. M3 does.
 *
 * The rename must be made explicitly rather than by push --force, and the
 * direction matters. The old calibration_error column held the mean absolute
 * distance between each prediction and its binary label, which is not a
 * calibration measurement. That value is preserved under the name that
 * describes it, mean_absolute_prediction_error. expected_calibration_error is
 * the quantity the acceptance gate now reads, and it starts NULL, because no
 * historical run ever computed it. Letting push guess would risk binding the
 * old, discredited values to the name the gate reads, which would silently
 * promote models on a number that never measured calibration.
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

  // ── M2. correction taxonomy values ────────────────────────────────────────
  //
  // Additive and idempotent. ALTER TYPE ... ADD VALUE cannot run inside a
  // transaction block in older PostgreSQL, so each value is its own statement.
  `ALTER TYPE snapshot_correction_reason ADD VALUE IF NOT EXISTS 'GAME_RESUMPTION'`,
  `ALTER TYPE snapshot_correction_reason ADD VALUE IF NOT EXISTS 'OFFICIAL_STAT_CORRECTION'`,

  // ── M3. walk_forward_runs metric rename and additions ─────────────────────
  //
  // This is the statement that lets push run unattended. See the header note.
  //
  // The rename is guarded on both names, so it happens exactly once and a
  // database that has already been migrated is left untouched.
  `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'walk_forward_runs'
         AND column_name = 'calibration_error'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'walk_forward_runs'
         AND column_name = 'mean_absolute_prediction_error'
    ) THEN
      ALTER TABLE walk_forward_runs
        RENAME COLUMN calibration_error TO mean_absolute_prediction_error;
    END IF;
  END
  $$
  `,

  // Idempotent additions. mean_absolute_prediction_error is listed here too, so
  // that a database which never had calibration_error at all still ends up with
  // the column. expected_calibration_error is deliberately left NULL: no
  // historical run computed it, and defaulting it to a number would hand the
  // acceptance gate a value that was never measured.
  `ALTER TABLE walk_forward_runs ADD COLUMN IF NOT EXISTS mean_absolute_prediction_error numeric`,
  `ALTER TABLE walk_forward_runs ADD COLUMN IF NOT EXISTS expected_calibration_error numeric`,
  `ALTER TABLE walk_forward_runs ADD COLUMN IF NOT EXISTS brier_skill_score numeric`,
  `ALTER TABLE walk_forward_runs ADD COLUMN IF NOT EXISTS prediction_std_dev numeric`,
  `ALTER TABLE walk_forward_runs ADD COLUMN IF NOT EXISTS benchmark_margin numeric`,
  `ALTER TABLE walk_forward_runs ADD COLUMN IF NOT EXISTS failure_reasons jsonb NOT NULL DEFAULT '[]'::jsonb`,

  // ── M4. game_weather_observations ─────────────────────────────────────────
  //
  // push aborted on M3's ambiguity before it created this table, so weather
  // reads throw on a missing relation and the two append-only triggers in
  // apply-immutability.mjs have nothing to attach to. That is the 119 OK,
  // 2 failed the immutability policy currently reports.
  //
  // The column list must match lib/db/src/schema/foundation.ts exactly, or the
  // next push diffs against it and prompts again. Kept in declaration order.
  `
  CREATE TABLE IF NOT EXISTS game_weather_observations (
    observation_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_pk                    bigint NOT NULL REFERENCES games(game_pk),
    venue_id                   integer REFERENCES venues(venue_id),
    slate_date                 date NOT NULL,
    forecast_for_utc           timestamp with time zone,
    temperature_f              numeric,
    wind_speed_mph             numeric,
    wind_direction_degrees     integer,
    wind_out_component_mph     numeric,
    wind_component             text,
    precipitation_probability  numeric,
    humidity_percent           numeric,
    roof_state                 text,
    weather_neutral            boolean NOT NULL DEFAULT false,
    source_id                  text NOT NULL REFERENCES source_registry(source_id),
    source_freshness           timestamp with time zone,
    retrieved_at               timestamp with time zone NOT NULL DEFAULT now(),
    observation_checksum       text NOT NULL,
    raw                        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at                 timestamp with time zone NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE UNIQUE INDEX IF NOT EXISTS game_weather_game_source_checksum_idx
    ON game_weather_observations (game_pk, source_id, observation_checksum)
  `,
  `
  CREATE INDEX IF NOT EXISTS game_weather_game_retrieved_idx
    ON game_weather_observations (game_pk, retrieved_at)
  `,

  // ── M5. additive columns push never reached ───────────────────────────────
  //
  // push applies additions without prompting, so none of these is ambiguous.
  // They are here because push aborted on M3 before applying anything, which
  // means the whole additive diff was lost. Restating them explicitly makes the
  // migration self-sufficient rather than dependent on push succeeding, and
  // every one is a no-op on a database that already has the column.

  // Task 3.1 and the walk settlement policy. settled_without_snapshot is the
  // column nightly settlement currently throws on.
  `ALTER TABLE historical_outcomes ADD COLUMN IF NOT EXISTS settled_without_snapshot boolean NOT NULL DEFAULT false`,
  `ALTER TABLE historical_outcomes ADD COLUMN IF NOT EXISTS intentional_walks integer`,
  `ALTER TABLE historical_outcomes ADD COLUMN IF NOT EXISTS hit_by_pitch integer`,
  `ALTER TABLE historical_outcomes ADD COLUMN IF NOT EXISTS walk_definition text`,

  // Task 4.1 and 4.2. Coordinates and orientation are what make a wind speed
  // signed, and roof_type is what distinguishes neutral weather from missing.
  `ALTER TABLE venues ADD COLUMN IF NOT EXISTS latitude numeric`,
  `ALTER TABLE venues ADD COLUMN IF NOT EXISTS longitude numeric`,
  `ALTER TABLE venues ADD COLUMN IF NOT EXISTS orientation_degrees integer`,
  `ALTER TABLE venues ADD COLUMN IF NOT EXISTS roof_type text`,

  // Task 5.3. An appearance logged with a null pitch count is still an
  // appearance, which is what the *_appeared flags record.
  `ALTER TABLE bullpen_availability_observations ADD COLUMN IF NOT EXISTS d1_appeared boolean NOT NULL DEFAULT false`,
  `ALTER TABLE bullpen_availability_observations ADD COLUMN IF NOT EXISTS d2_appeared boolean NOT NULL DEFAULT false`,
  `ALTER TABLE bullpen_availability_observations ADD COLUMN IF NOT EXISTS d3_appeared boolean NOT NULL DEFAULT false`,
  `ALTER TABLE bullpen_availability_observations ADD COLUMN IF NOT EXISTS source_observation_game_date date`,

  // Task 1.6. Feature coverage is what the INSUFFICIENT_FEATURES basis reads.
  `ALTER TABLE daily_market_board ADD COLUMN IF NOT EXISTS feature_coverage numeric`,
  `ALTER TABLE daily_market_board ADD COLUMN IF NOT EXISTS imputed_features jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE daily_market_board ADD COLUMN IF NOT EXISTS unknown_features jsonb NOT NULL DEFAULT '[]'::jsonb`,

  // ── M6. handedness: the empty string is not a value ───────────────────────
  //
  // Audit S1. The game-feed player upsert wrote String(code ?? '') and updated
  // unconditionally, so any payload without pitchHand or batSide replaced a
  // known handedness with ''. Downstream, '' is not null: resolveBatterSide
  // returns null for a switch hitter, isPlatoonDisfavored returns false, and
  // every split metric quietly resolves to the unsplit season line with nothing
  // reporting it. Park and weather then sit on a platoon layer that may not be
  // running at all.
  //
  // The upserts no longer write '', and these two statements retire the values
  // already stored. Only '' and whitespace are touched: a real L, R or S is
  // never modified, and a row already NULL is left alone. Re-hydrating the
  // handedness itself needs the MLB feed and is a separate, operator-run step:
  //   node lib/db/scripts/backfill-handedness.mjs
  `UPDATE players SET bats = NULL WHERE bats IS NOT NULL AND btrim(bats) = ''`,
  `UPDATE players SET throws = NULL WHERE throws IS NOT NULL AND btrim(throws) = ''`,

  // FantasyPros is a slate/reference source, not a research-ranking writer.
  // This append-only reference table keeps provider ranks reconstructible while
  // making it impossible for the baseline job to overwrite market candidates.
  `CREATE TABLE IF NOT EXISTS fantasypros_reference_ranks (
    reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slate_date date NOT NULL,
    game_pk bigint NOT NULL REFERENCES games(game_pk),
    player_id integer NOT NULL REFERENCES players(player_id),
    market market_type NOT NULL,
    projected_value numeric,
    reference_rank integer NOT NULL,
    snapshot_retrieved_at timestamptz NOT NULL,
    lineup_state text NOT NULL,
    batting_order integer,
    ingest_run_id uuid REFERENCES ingest_runs(ingest_run_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fp_reference_snapshot_unique UNIQUE (slate_date, market, player_id, game_pk, snapshot_retrieved_at)
  )`,
  `CREATE INDEX IF NOT EXISTS fp_reference_lookup_idx
     ON fantasypros_reference_ranks (slate_date, market, player_id, game_pk)`,
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
