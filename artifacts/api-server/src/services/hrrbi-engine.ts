/**
 * H+R+RBI research is a standalone ordinal board. It deliberately reuses only
 * source-backed, season-level contact/opportunity evidence already persisted by
 * the TB engine; it never treats a recent streak as a promotion signal and it
 * does not create a probability, price, or recommendation.
 */
import { pool } from "@workspace/db";

const MARKET = "HITS_RUNS_RBI_2_PLUS";

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
      `INSERT INTO market_research_candidates
         (slate_date, game_pk, player_id, market, research_rank, research_state,
          primary_mechanism, secondary_mechanism, opportunity_evidence,
          starter_matchup_evidence, bullpen_path_evidence, park_evidence,
          recent_vs_season_vs_career, counter_evidence, missing_stale_evidence,
          rank_semantics, ingest_run_id)
       SELECT tb.slate_date, tb.game_pk, tb.player_id, $2, tb.research_rank, tb.research_state,
          'CONTACT_AND_LINEUP_OPPORTUNITY', tb.primary_mechanism,
          jsonb_build_object(
            'source', 'TB_ENGINE season-level research',
            'lineupOpportunity', tb.opportunity_evidence,
            'signal', 'H+R+RBI uses durable contact and lineup opportunity context; no recent-streak promotion'
          ),
          tb.starter_matchup_evidence, tb.bullpen_path_evidence, tb.park_evidence,
          tb.recent_vs_season_vs_career,
          tb.counter_evidence,
          tb.missing_stale_evidence,
          'RANK_DONT_GATE: standalone H+R+RBI ordinal research using source-backed season contact and lineup opportunity evidence; no probability or recommendation implied',
          $1
       FROM market_research_candidates tb
       WHERE tb.slate_date = $3 AND tb.market = 'TOTAL_BASES_2_PLUS'
       ON CONFLICT (slate_date, market, player_id, game_pk) DO UPDATE SET
         research_rank = EXCLUDED.research_rank,
         research_state = EXCLUDED.research_state,
         primary_mechanism = EXCLUDED.primary_mechanism,
         secondary_mechanism = EXCLUDED.secondary_mechanism,
          opportunity_evidence = CASE
            WHEN market_research_candidates.opportunity_evidence->>'source' = 'FANTASYPROS'
              THEN jsonb_build_object('baseline', market_research_candidates.opportunity_evidence, 'research', EXCLUDED.opportunity_evidence)
            WHEN market_research_candidates.opportunity_evidence ? 'baseline'
              THEN jsonb_set(market_research_candidates.opportunity_evidence, '{research}', EXCLUDED.opportunity_evidence, true)
            ELSE EXCLUDED.opportunity_evidence
          END,
         starter_matchup_evidence = EXCLUDED.starter_matchup_evidence,
         bullpen_path_evidence = EXCLUDED.bullpen_path_evidence,
         park_evidence = EXCLUDED.park_evidence,
         recent_vs_season_vs_career = EXCLUDED.recent_vs_season_vs_career,
         counter_evidence = EXCLUDED.counter_evidence,
         missing_stale_evidence = EXCLUDED.missing_stale_evidence,
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
      notes: ["H+R+RBI ordinal evidence is sourced from current season contact and lineup opportunity context; recent streaks are not used."],
    };
  } catch (error) {
    await pool.query(
      `UPDATE ingest_runs SET status = 'FAILED', finished_at = now(), error_message = $2 WHERE ingest_run_id = $1`,
      [ingestRunId, error instanceof Error ? error.message : "Unknown H+R+RBI engine failure"],
    );
    throw error;
  }
}