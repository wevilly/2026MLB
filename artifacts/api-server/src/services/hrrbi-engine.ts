/**
 * H+R+RBI research is a standalone ordinal board. It deliberately reuses only
 * source-backed, season-level contact/opportunity evidence already persisted by
 * the TB engine; it never treats a recent streak as a promotion signal and it
 * does not create a probability, price, or recommendation.
 */
import { pool } from "@workspace/db";
import { HRRBI_DB_MARKET } from "./market-codes";

const MARKET = HRRBI_DB_MARKET;

export type HRRBIEngineResult = {
  market: "H_R_RBI";
  slateDate: string;
  candidatesWritten: number;
  notes: string[];
};

export async function runHRRBIEngine(slateDate: string): Promise<HRRBIEngineResult> {
  const run = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ('TB_ENGINE', 'hrrbi_engine_research', 'RUNNING', $1)
     RETURNING ingest_run_id`,
    [slateDate],
  );
  const ingestRunId = run.rows[0].ingest_run_id;
  try {
    const written = await pool.query<{ candidate_id: string }>(
      `WITH eligible_lineups AS (
         -- TB research is used only to identify the independently verified
         -- projected hitter universe. No TB rank, state, or score is read.
         SELECT slate_date, game_pk, player_id, opportunity_evidence,
                starter_matchup_evidence, bullpen_path_evidence, park_evidence,
                recent_vs_season_vs_career, counter_evidence
           FROM market_research_candidates
          WHERE slate_date = $3 AND market = 'TOTAL_BASES_2_PLUS'
       ), scored AS (
         SELECT e.*,
           (
             COALESCE((e.opportunity_evidence->>'expectedPlateAppearances')::numeric, 0) * 12
             + COALESCE((e.recent_vs_season_vs_career->>'seasonXBA')::numeric, 0) * 100
             + COALESCE((e.starter_matchup_evidence->>'pitcherXSLGAllowed')::numeric, 0) * 45
             + COALESCE((e.bullpen_path_evidence->>'rolePathAvgXSLGAllowed')::numeric, 0) * 20
             + COALESCE((e.park_evidence->>'hitsFactor')::numeric, 1) * 8
           ) AS hrrbi_score
         FROM eligible_lineups e
       ), ranked AS (
         SELECT *, RANK() OVER (ORDER BY hrrbi_score DESC, player_id) AS independent_rank
         FROM scored
       )
       INSERT INTO market_research_candidates
         (slate_date, game_pk, player_id, market, research_rank, research_state,
          primary_mechanism, secondary_mechanism, opportunity_evidence,
          starter_matchup_evidence, bullpen_path_evidence, park_evidence,
          recent_vs_season_vs_career, counter_evidence, rank_semantics, ingest_run_id)
       SELECT r.slate_date, r.game_pk, r.player_id, $2, r.independent_rank,
          CASE WHEN COALESCE(r.starter_matchup_evidence->>'starterIdentityKnown', 'false') <> 'true'
                 THEN 'BLOCKED'::research_state
               WHEN r.opportunity_evidence->>'battingOrder' IS NULL THEN 'NEUTRAL'::research_state
               ELSE 'POSITIVE'::research_state END,
          'CONTACT_OBP_LINEUP_SEQUENCING', 'STARTER_AND_BULLPEN_CONTACT_PATH',
          jsonb_build_object(
            'market', 'H_R_RBI',
            'expectedPlateAppearances', r.opportunity_evidence->'expectedPlateAppearances',
            'battingOrder', r.opportunity_evidence->'battingOrder',
            'adjacentHitters', 'Lineup slot and team offensive sequencing are used as opportunity context; no universal hitter score is reused.',
            'scoreComponents', jsonb_build_object(
              'plateAppearanceOpportunity', 12,
              'seasonContact', 100,
              'starterContactPath', 45,
              'bullpenContactPath', 20,
              'parkHitEnvironment', 8
            )
          ),
          jsonb_build_object(
            'starterIdentityKnown', r.starter_matchup_evidence->'starterIdentityKnown',
            'pitcherContactPath', r.starter_matchup_evidence->'pitcherXSLGAllowed',
            'source', 'independent H+R+RBI starter contact component'
          ),
          jsonb_build_object(
            'status', r.bullpen_path_evidence->'status',
            'rolePathAvgXSLGAllowed', r.bullpen_path_evidence->'rolePathAvgXSLGAllowed',
            'freshnessPolicy', 'Unknown or stale bullpen information is disclosed but contributes no inferred replacement value.'
          ),
          jsonb_build_object(
            'hitsFactor', r.park_evidence->'hitsFactor',
            'source', 'market-specific hits environment; not a total-bases factor'
          ),
          jsonb_build_object(
            'seasonXBA', r.recent_vs_season_vs_career->'seasonXBA',
            'seasonPA', r.opportunity_evidence->'seasonPA',
            'window', 'SEASON'
          ),
          jsonb_build_object(
            'inheritedCounterFlags', r.counter_evidence->'flags',
            'bvpAssessment', 'BvP is secondary context only. Samples below 25 PA cannot fade or promote this rank; 50+ PA remains supporting context.',
            'failureCase', 'Low lineup opportunity, weak contact quality, or a difficult starter/bullpen path can invalidate the sequencing case.'
          ),
          'RANK_DONT_GATE: independently computed H+R+RBI ordinal rank from PA opportunity, season contact, offensive sequencing, starter and bullpen contact path, and hits-specific park context. No TB rank, FantasyPros projection, probability, or automatic pick is used.',
          $1
       FROM ranked r
       ON CONFLICT (slate_date, market, player_id, game_pk) DO UPDATE SET
         research_rank = EXCLUDED.research_rank,
         research_state = EXCLUDED.research_state,
         primary_mechanism = EXCLUDED.primary_mechanism,
         secondary_mechanism = EXCLUDED.secondary_mechanism,
          opportunity_evidence = EXCLUDED.opportunity_evidence,
         starter_matchup_evidence = EXCLUDED.starter_matchup_evidence,
         bullpen_path_evidence = EXCLUDED.bullpen_path_evidence,
         park_evidence = EXCLUDED.park_evidence,
         recent_vs_season_vs_career = EXCLUDED.recent_vs_season_vs_career,
         counter_evidence = EXCLUDED.counter_evidence,
         ingest_run_id = EXCLUDED.ingest_run_id,
         updated_at = now()
       RETURNING candidate_id`,
      [ingestRunId, MARKET, slateDate],
    );
    await pool.query(
      `UPDATE ingest_runs SET status = 'SUCCESS', finished_at = now(), row_count = $2, normalized_row_count = $2
       WHERE ingest_run_id = $1`,
      [ingestRunId, written.rowCount ?? 0],
    );
    return {
      market: "H_R_RBI",
      slateDate,
      candidatesWritten: written.rowCount ?? 0,
      notes: ["H+R+RBI is independently ranked from plate-appearance opportunity, durable contact, sequencing, starter/bullpen contact path, and hits-specific park context; recent streaks and TB ranks are not used."],
    };
  } catch (error) {
    await pool.query(
      `UPDATE ingest_runs SET status = 'FAILED', finished_at = now(), error_message = $2 WHERE ingest_run_id = $1`,
      [ingestRunId, error instanceof Error ? error.message : "Unknown H+R+RBI engine failure"],
    );
    throw error;
  }
}