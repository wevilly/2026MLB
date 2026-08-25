import { pool } from "@workspace/db";

const MARKET_DEFINITIONS = [
  { market: "TOTAL_BASES_2_PLUS", label: "TB", field: "tb" },
  { market: "EXTRA_BASE_HIT", label: "XBH", field: "xbh" },
  { market: "BATTER_WALK", label: "WALK", field: "walk" },
  { market: "HOME_RUN", label: "HR", field: "hr" },
  { market: "HITS_RUNS_RBI_2_PLUS", label: "H_R_RBI", field: "hrrbi" },
] as const;

type BaselineMarket = (typeof MARKET_DEFINITIONS)[number];
type ProjectionRow = {
  game_pk: number;
  player_id: number;
  player_name: string;
  batting_order: number;
  normalized_stats: Record<string, unknown>;
  lineup_state: string;
  snapshot_retrieved_at: string;
  starter_player_id: number | null;
  starter_state: string | null;
};

function numberField(stats: Record<string, unknown>, key: string) {
  const value = Number(stats[key]);
  return Number.isFinite(value) ? value : null;
}

function projectedValue(stats: Record<string, unknown>, field: BaselineMarket["field"]) {
  const hits = numberField(stats, "hits");
  const singles = numberField(stats, "1b") ?? 0;
  const doubles = numberField(stats, "2b") ?? 0;
  const triples = numberField(stats, "3b") ?? 0;
  const homeRuns = numberField(stats, "hrs") ?? 0;
  const walks = numberField(stats, "bb");
  if (field === "tb") return hits === null && singles === 0 && doubles === 0 && triples === 0 && homeRuns === 0
    ? null
    : singles + 2 * doubles + 3 * triples + 4 * homeRuns;
  if (field === "xbh") return doubles + triples + homeRuns;
  if (field === "walk") return walks;
  if (field === "hr") return homeRuns;
  const runs = numberField(stats, "r");
  const rbi = numberField(stats, "rbi");
  return hits === null || runs === null || rbi === null ? null : hits + runs + rbi;
}

export type FantasyProsBaselineResult = {
  slateDate: string;
  gamesProcessed: number;
  candidatesWritten: number;
  skippedMissingProjectionFields: number;
  notes: string[];
};

export async function runFantasyProsBaseline(slateDate: string): Promise<FantasyProsBaselineResult> {
  const run = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ('FANTASYPROS', 'fantasypros_projection_baseline', 'RUNNING', $1)
     RETURNING ingest_run_id`,
    [slateDate],
  );
  const ingestRunId = run.rows[0].ingest_run_id;
  try {
    const rows = await pool.query<ProjectionRow>(
      `WITH latest_lineups AS (
         SELECT DISTINCT ON (ls.game_pk, ls.team_id)
           ls.lineup_snapshot_id, ls.game_pk, ls.team_id, ls.state
         FROM lineup_snapshots ls JOIN games g ON g.game_pk = ls.game_pk
         WHERE g.game_date = $1 AND ls.source_id = 'FANTASYPROS' AND ls.state = 'PROJECTED'
         ORDER BY ls.game_pk, ls.team_id, ls.observed_at DESC
       ),
       latest_hitter_snapshot AS (
         SELECT snapshot_id, retrieved_at
         FROM fantasypros_projection_snapshots
         WHERE effective_date = $1 AND source_id = 'FANTASYPROS' AND snapshot_label = 'Hitter daily'
         ORDER BY retrieved_at DESC LIMIT 1
       ),
       latest_starters AS (
         SELECT DISTINCT ON (game_pk, team_id) game_pk, team_id, player_id, starter_state
         FROM starters WHERE source_id = 'FANTASYPROS'
         ORDER BY game_pk, team_id, observed_at DESC
       )
        SELECT ll.game_pk::bigint, le.player_id, p.full_name AS player_name, le.batting_order,
         f.normalized_stats, ll.state AS lineup_state, hs.retrieved_at::text AS snapshot_retrieved_at,
         starter.player_id AS starter_player_id, starter.starter_state
       FROM latest_lineups ll
       JOIN lineup_entries le ON le.lineup_snapshot_id = ll.lineup_snapshot_id
       JOIN games g ON g.game_pk = ll.game_pk
       JOIN players p ON p.player_id = le.player_id
       JOIN latest_hitter_snapshot hs ON true
       JOIN fantasypros_projection_rows f ON f.snapshot_id = hs.snapshot_id AND f.canonical_player_id = le.player_id
       LEFT JOIN latest_starters starter ON starter.game_pk = ll.game_pk
         AND starter.team_id = CASE WHEN ll.team_id = g.away_team_id THEN g.home_team_id ELSE g.away_team_id END
       ORDER BY ll.game_pk, le.batting_order`,
      [slateDate],
    );
    const values = new Map<string, Array<{ row: ProjectionRow; value: number }>>();
    let skipped = 0;
    for (const definition of MARKET_DEFINITIONS) values.set(definition.market, []);
    for (const row of rows.rows) {
      for (const definition of MARKET_DEFINITIONS) {
        const value = projectedValue(row.normalized_stats ?? {}, definition.field);
        if (value === null) {
          skipped += 1;
          continue;
        }
        values.get(definition.market)!.push({ row, value });
      }
    }
    let written = 0;
    for (const definition of MARKET_DEFINITIONS) {
      const marketValues = values.get(definition.market)!;
      marketValues.sort((a, b) => b.value - a.value || a.row.player_name.localeCompare(b.row.player_name));
      let previousValue: number | null = null;
      let rank = 0;
      for (let index = 0; index < marketValues.length; index += 1) {
        const item = marketValues[index];
        if (previousValue === null || item.value !== previousValue) rank = index + 1;
        previousValue = item.value;
        await pool.query(
          `INSERT INTO fantasypros_reference_ranks
             (slate_date, game_pk, player_id, market, projected_value, reference_rank,
              snapshot_retrieved_at, lineup_state, batting_order, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10)
           ON CONFLICT (slate_date, market, player_id, game_pk, snapshot_retrieved_at) DO NOTHING`,
          [
            slateDate, item.row.game_pk, item.row.player_id, definition.market, item.value, rank,
            item.row.snapshot_retrieved_at, item.row.lineup_state, item.row.batting_order, ingestRunId,
          ],
        );
        written += 1;
      }
    }
    await pool.query(
      `UPDATE ingest_runs SET status = 'SUCCESS', finished_at = now(), row_count = $2, normalized_row_count = $2,
         rejected_row_count = $3 WHERE ingest_run_id = $1`,
      [ingestRunId, written, skipped],
    );
    return {
      slateDate,
      gamesProcessed: new Set(rows.rows.map((row) => row.game_pk)).size,
      candidatesWritten: written,
      skippedMissingProjectionFields: skipped,
      notes: [
        "FantasyPros reference ranks are available before independent Statcast, park, bullpen, and matchup research.",
        "Reference values are comparison-only and never create, sort, or overwrite a research candidate.",
      ],
    };
  } catch (error) {
    await pool.query(
      `UPDATE ingest_runs SET status = 'FAILED', finished_at = now(), error_message = $2 WHERE ingest_run_id = $1`,
      [ingestRunId, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }
}