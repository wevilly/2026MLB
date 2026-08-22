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
  // ── 0. Phase 5B controlled validation roles ─────────────────────────────
  `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mlb_walk_forward_validator') THEN
      CREATE ROLE mlb_walk_forward_validator NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mlb_analyst_writer') THEN
      CREATE ROLE mlb_analyst_writer NOLOGIN NOINHERIT;
    END IF;
  END;
  $$
  `,
  `GRANT mlb_walk_forward_validator TO postgres`,
  `GRANT SELECT, INSERT ON walk_forward_runs TO mlb_analyst_writer`,
  `GRANT SELECT ON model_versions TO mlb_analyst_writer`,
  `REVOKE UPDATE, DELETE, TRUNCATE ON walk_forward_runs, model_versions FROM mlb_analyst_writer`,
  `GRANT SELECT, UPDATE ON walk_forward_runs, model_versions TO mlb_walk_forward_validator`,

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
  CREATE OR REPLACE FUNCTION prevent_ai_bettor_intelligence_write()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF upper(current_setting('app.writer_context', true)) = 'AI' THEN
      RAISE EXCEPTION 'AI writers cannot write bettor ingestion or lineage tables.';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION prevent_ai_official_research_or_model_write()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF upper(current_setting('app.writer_context', true)) = 'AI' THEN
      RAISE EXCEPTION 'AI writers cannot write frozen research, market board, or model records.';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION enforce_ai_sourcing_register_lifecycle()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'AI sourcing register claims are retained for audit and may not be deleted.';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.accepted IS NOT NULL
         OR NEW.accepted IS NULL
         OR NEW.session_id IS DISTINCT FROM OLD.session_id
         OR NEW.tool_call_id IS DISTINCT FROM OLD.tool_call_id
         OR NEW.claim_text IS DISTINCT FROM OLD.claim_text
         OR NEW.source_url_or_description IS DISTINCT FROM OLD.source_url_or_description
         OR NEW.source_type IS DISTINCT FROM OLD.source_type
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'AI sourcing register decisions are one-way and source claim content is immutable.';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION prevent_ai_tool_call_log_mutation()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION
      'ai_tool_call_log is append-only. Audit records may not be updated, deleted, or truncated.';
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION
      'audit_events is append-only. Audit records may not be updated, deleted, or truncated.';
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION prevent_ai_approved_research_write()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF upper(current_setting('app.writer_context', true)) = 'AI' THEN
      RAISE EXCEPTION 'AI writers cannot create or change human-approved research notes.';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION prevent_ai_draft_self_review()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF upper(current_setting('app.writer_context', true)) = 'AI'
       AND (TG_OP = 'DELETE' OR NEW.status <> 'DRAFT' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'AI writers may create drafts but cannot review, approve, reject, withdraw, or delete them.';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION bettor_mechanism_tags_are_unique(tags bettor_mechanism[])
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT cardinality(tags) = cardinality(ARRAY(SELECT DISTINCT unnest(tags)));
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

  `
  CREATE OR REPLACE FUNCTION guard_model_version_lifecycle()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.status = 'ACTIVE'
       AND NEW.status NOT IN ('ACTIVE', 'RETIRED') THEN
      RAISE EXCEPTION 'ACTIVE model versions may only remain ACTIVE or transition to RETIRED.';
    END IF;

    IF TG_OP = 'UPDATE'
       AND (
         NEW.status = 'ACTIVE'
         OR NEW.walk_forward_acceptance_id IS DISTINCT FROM OLD.walk_forward_acceptance_id
         OR NEW.calibration_method IS DISTINCT FROM OLD.calibration_method
         OR NEW.calibration_slope IS DISTINCT FROM OLD.calibration_slope
         OR NEW.calibration_intercept IS DISTINCT FROM OLD.calibration_intercept
         OR (OLD.status IN ('DRAFT', 'CANDIDATE') AND NEW.status = 'FAILED')
       )
       AND current_user <> 'mlb_walk_forward_validator' THEN
      RAISE EXCEPTION
        'Model promotion, validation acceptance, and calibration updates require the controlled validation writer.';
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.status = 'ACTIVE'
       AND (NEW.calibration_method IS DISTINCT FROM OLD.calibration_method
            OR NEW.calibration_slope IS DISTINCT FROM OLD.calibration_slope
            OR NEW.calibration_intercept IS DISTINCT FROM OLD.calibration_intercept) THEN
      RAISE EXCEPTION 'ACTIVE model calibration parameters are immutable.';
    END IF;

    IF NEW.status = 'ACTIVE' THEN
      IF NEW.walk_forward_acceptance_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM walk_forward_runs
            WHERE walk_forward_run_id = NEW.walk_forward_acceptance_id
              AND model_version_id = NEW.version_id
              AND status = 'PASS'
              AND benchmark_beat = true
              AND calibration_passed = true
         ) THEN
        RAISE EXCEPTION
          'ACTIVE models require a linked PASS walk-forward run that beats its benchmark and passes calibration.';
      END IF;
    END IF;

    IF TG_OP = 'UPDATE'
       AND (NEW.artifact_key <> OLD.artifact_key
            OR NEW.artifact_generation <> OLD.artifact_generation
            OR NEW.artifact_content_hash <> OLD.artifact_content_hash
            OR NEW.feature_set_hash <> OLD.feature_set_hash) THEN
      RAISE EXCEPTION 'Model artifact and feature identity are immutable once a version is created.';
    END IF;
    RETURN NEW;
  END;
  $$
  `,

  `
  CREATE OR REPLACE FUNCTION guard_walk_forward_run_lifecycle()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF current_setting('app.bypass_immutability', true) = 'true' THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'INCOMPLETE'
         OR NEW.finished_at IS NOT NULL
         OR NEW.fold_count <> 0
         OR NEW.overall_metric IS NOT NULL
         OR NEW.benchmark_metric IS NOT NULL
         OR NEW.benchmark_beat <> false
         OR NEW.calibration_error IS NOT NULL
         OR NEW.calibration_passed <> false
         OR NEW.fold_results <> '[]'::jsonb
         OR NEW.calibration_curve <> '[]'::jsonb THEN
        RAISE EXCEPTION
          'walk_forward_runs must be inserted as an unfinished INCOMPLETE record.';
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'walk_forward_runs are append-and-complete records and may not be deleted.';
    END IF;

    IF OLD.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'Completed walk_forward_runs are immutable.';
    END IF;
    IF NEW.walk_forward_run_id <> OLD.walk_forward_run_id
       OR NEW.model_version_id <> OLD.model_version_id
       OR NEW.market <> OLD.market
       OR NEW.started_at <> OLD.started_at
       OR NEW.benchmark_method <> OLD.benchmark_method
       OR NEW.calibration_method <> OLD.calibration_method THEN
      RAISE EXCEPTION 'Walk-forward run identity and methods are immutable.';
    END IF;
    IF NEW.finished_at IS NULL
       OR current_user <> 'mlb_walk_forward_validator' THEN
      RAISE EXCEPTION 'Walk-forward runs may only be completed by the controlled validation writer role.';
    END IF;
    IF NEW.status = 'PASS'
       AND (NEW.fold_count < 2
            OR NEW.overall_metric IS NULL
            OR NEW.benchmark_metric IS NULL
            OR NEW.benchmark_beat <> true
            OR NEW.calibration_error IS NULL
            OR NEW.calibration_passed <> true
            OR NEW.calibration_slope IS NULL
            OR NEW.calibration_intercept IS NULL) THEN
      RAISE EXCEPTION 'PASS walk-forward runs require completed folds, benchmark success, and calibration success.';
    END IF;
    IF NEW.status = 'FAIL'
       AND (NEW.fold_count < 2
            OR NEW.overall_metric IS NULL
            OR NEW.benchmark_metric IS NULL
            OR NEW.calibration_error IS NULL) THEN
      RAISE EXCEPTION 'FAIL walk-forward runs require completed folds and recorded metrics.';
    END IF;
    IF NEW.status = 'INCOMPLETE'
       AND (NEW.fold_count <> 0
            OR NEW.overall_metric IS NOT NULL
            OR NEW.benchmark_metric IS NOT NULL
            OR NEW.benchmark_beat <> false
            OR NEW.calibration_error IS NOT NULL
            OR NEW.calibration_passed <> false) THEN
      RAISE EXCEPTION 'INCOMPLETE walk-forward runs cannot contain terminal metrics.';
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

  `DROP TRIGGER IF EXISTS bettor_sources_ai_write_guard ON bettor_sources`,
  `
  CREATE TRIGGER bettor_sources_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bettor_sources
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_bettor_intelligence_write()
  `,
  `DROP TRIGGER IF EXISTS bettor_picks_ai_write_guard ON bettor_picks`,
  `
  CREATE TRIGGER bettor_picks_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bettor_picks
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_bettor_intelligence_write()
  `,
  `DROP TRIGGER IF EXISTS pick_duplication_lineage_ai_write_guard ON pick_duplication_lineage`,
  `
  CREATE TRIGGER pick_duplication_lineage_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pick_duplication_lineage
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_bettor_intelligence_write()
  `,
  `DROP TRIGGER IF EXISTS bettor_performance_records_ai_write_guard ON bettor_performance_records`,
  `
  CREATE TRIGGER bettor_performance_records_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bettor_performance_records
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_bettor_intelligence_write()
  `,

  `DROP TRIGGER IF EXISTS ai_tool_call_log_append_only ON ai_tool_call_log`,
  `
  CREATE TRIGGER ai_tool_call_log_append_only
  BEFORE UPDATE OR DELETE ON ai_tool_call_log
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_tool_call_log_mutation()
  `,
  `DROP TRIGGER IF EXISTS ai_tool_call_log_truncate_guard ON ai_tool_call_log`,
  `
  CREATE TRIGGER ai_tool_call_log_truncate_guard
  BEFORE TRUNCATE ON ai_tool_call_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_ai_tool_call_log_mutation()
  `,

  `DROP TRIGGER IF EXISTS research_notes_ai_write_guard ON research_notes`,
  `
  CREATE TRIGGER research_notes_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON research_notes
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_approved_research_write()
  `,
  `DROP TRIGGER IF EXISTS ai_research_drafts_ai_self_review_guard ON ai_research_drafts`,
  `
  CREATE TRIGGER ai_research_drafts_ai_self_review_guard
  BEFORE INSERT OR UPDATE OR DELETE ON ai_research_drafts
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_draft_self_review()
  `,

  `DROP TRIGGER IF EXISTS research_files_ai_write_guard ON research_files`,
  `
  CREATE TRIGGER research_files_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON research_files
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS player_research_snapshots_ai_write_guard ON player_research_snapshots`,
  `
  CREATE TRIGGER player_research_snapshots_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON player_research_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS player_research_features_ai_write_guard ON player_research_features`,
  `
  CREATE TRIGGER player_research_features_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON player_research_features
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS pitcher_research_snapshots_ai_write_guard ON pitcher_research_snapshots`,
  `
  CREATE TRIGGER pitcher_research_snapshots_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pitcher_research_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS pitcher_research_features_ai_write_guard ON pitcher_research_features`,
  `
  CREATE TRIGGER pitcher_research_features_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pitcher_research_features
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS park_research_snapshots_ai_write_guard ON park_research_snapshots`,
  `
  CREATE TRIGGER park_research_snapshots_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON park_research_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS park_research_features_ai_write_guard ON park_research_features`,
  `
  CREATE TRIGGER park_research_features_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON park_research_features
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS future_market_predictions_ai_write_guard ON future_market_predictions`,
  `
  CREATE TRIGGER future_market_predictions_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON future_market_predictions
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS market_research_provenance_ai_write_guard ON market_research_provenance`,
  `
  CREATE TRIGGER market_research_provenance_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON market_research_provenance
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS daily_market_board_ai_write_guard ON daily_market_board`,
  `
  CREATE TRIGGER daily_market_board_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON daily_market_board
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS model_versions_ai_write_guard ON model_versions`,
  `
  CREATE TRIGGER model_versions_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON model_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS walk_forward_runs_ai_write_guard ON walk_forward_runs`,
  `
  CREATE TRIGGER walk_forward_runs_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON walk_forward_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS pregame_feature_snapshots_ai_write_guard ON pregame_feature_snapshots`,
  `
  CREATE TRIGGER pregame_feature_snapshots_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pregame_feature_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS feature_snapshot_provenance_ai_write_guard ON feature_snapshot_provenance`,
  `
  CREATE TRIGGER feature_snapshot_provenance_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON feature_snapshot_provenance
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS pitch_arsenal_features_ai_write_guard ON pitch_arsenal_features`,
  `
  CREATE TRIGGER pitch_arsenal_features_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pitch_arsenal_features
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS model_training_runs_ai_write_guard ON model_training_runs`,
  `
  CREATE TRIGGER model_training_runs_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON model_training_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS model_walk_forward_acceptances_ai_write_guard ON model_walk_forward_acceptances`,
  `
  CREATE TRIGGER model_walk_forward_acceptances_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON model_walk_forward_acceptances
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS market_research_candidates_ai_write_guard ON market_research_candidates`,
  `
  CREATE TRIGGER market_research_candidates_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON market_research_candidates
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS market_research_evidence_blocks_ai_write_guard ON market_research_evidence_blocks`,
  `
  CREATE TRIGGER market_research_evidence_blocks_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON market_research_evidence_blocks
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS market_settlement_outcomes_ai_write_guard ON market_settlement_outcomes`,
  `
  CREATE TRIGGER market_settlement_outcomes_ai_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON market_settlement_outcomes
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_official_research_or_model_write()
  `,
  `DROP TRIGGER IF EXISTS ai_sourcing_register_lifecycle_guard ON ai_sourcing_register`,
  `
  CREATE TRIGGER ai_sourcing_register_lifecycle_guard
  BEFORE UPDATE OR DELETE ON ai_sourcing_register
  FOR EACH ROW EXECUTE FUNCTION enforce_ai_sourcing_register_lifecycle()
  `,

  `DROP TRIGGER IF EXISTS market_postmortems_linkage_guard
   ON market_postmortems`,

  `
  CREATE TRIGGER market_postmortems_linkage_guard
  BEFORE INSERT ON market_postmortems
  FOR EACH ROW EXECUTE FUNCTION validate_market_postmortem_insert()
  `,

  `DROP TRIGGER IF EXISTS model_versions_lifecycle_guard
   ON model_versions`,

  `
  CREATE TRIGGER model_versions_lifecycle_guard
  BEFORE INSERT OR UPDATE ON model_versions
  FOR EACH ROW EXECUTE FUNCTION guard_model_version_lifecycle()
  `,

  `DROP TRIGGER IF EXISTS walk_forward_runs_lifecycle_guard
   ON walk_forward_runs`,

  `
  CREATE TRIGGER walk_forward_runs_lifecycle_guard
  BEFORE INSERT OR UPDATE OR DELETE ON walk_forward_runs
  FOR EACH ROW EXECUTE FUNCTION guard_walk_forward_run_lifecycle()
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

  // ── 3B. Phase 7A identity and lineage constraints ──────────────────────
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'bettor_picks'
        AND constraint_name = 'bettor_picks_mechanism_tags_unique_check'
    ) THEN
      ALTER TABLE bettor_picks
        ADD CONSTRAINT bettor_picks_mechanism_tags_unique_check
        CHECK (bettor_mechanism_tags_are_unique(mechanism_tags));
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
  `DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events`,
  `
  CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation()
  `,
  `DROP TRIGGER IF EXISTS audit_events_truncate_guard ON audit_events`,
  `
  CREATE TRIGGER audit_events_truncate_guard
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_event_mutation()
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
