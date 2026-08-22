import { pool } from "@workspace/db";

function dateOnly(value: unknown) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("date must use YYYY-MM-DD");
  return text;
}

export async function buildSlateExport(rawDate: unknown) {
  const date = dateOnly(rawDate);
  const [games, board, research, lineups, starters] = await Promise.all([
    pool.query(
      `SELECT g.game_pk::bigint AS "gamePk", g.start_time_utc::text AS "startTimeUtc", g.game_status AS "gameStatus",
              away.abbreviation AS "awayTeam", home.abbreviation AS "homeTeam", v.name AS park
       FROM games g JOIN teams away ON away.team_id = g.away_team_id JOIN teams home ON home.team_id = g.home_team_id
       LEFT JOIN venues v ON v.venue_id = g.venue_id WHERE g.game_date = $1 ORDER BY g.start_time_utc NULLS LAST`,
      [date],
    ),
    pool.query(
      `SELECT dmb.game_pk::bigint AS "gamePk", dmb.player_id AS "playerId", p.full_name AS "playerName", dmb.market,
              dmb.research_rank AS "researchRank", dmb.research_state AS "researchState", dmb.confidence_label AS "confidenceLabel"
       FROM daily_market_board dmb JOIN players p ON p.player_id = dmb.player_id
       WHERE dmb.slate_date = $1 ORDER BY dmb.market, dmb.research_rank NULLS LAST`,
      [date],
    ),
    pool.query(
      `SELECT game_pk::bigint AS "gamePk", player_id AS "playerId", market, research_state AS "researchState"
       FROM market_research_candidates WHERE slate_date = $1 ORDER BY game_pk, player_id, market`,
      [date],
    ),
    pool.query(
      `WITH latest_posted_lineups AS (
         SELECT DISTINCT ON (ls.game_pk, ls.team_id) ls.lineup_snapshot_id, ls.game_pk, ls.team_id
         FROM lineup_snapshots ls JOIN games g ON g.game_pk = ls.game_pk
         WHERE g.game_date = $1 AND ls.state = 'POSTED' AND ls.source_id = 'MLB_OFFICIAL'
         ORDER BY ls.game_pk, ls.team_id, ls.observed_at DESC
       )
       SELECT l.game_pk::bigint AS "gamePk", t.abbreviation AS team, le.batting_order AS "battingOrder",
              le.position, le.player_id AS "playerId", p.full_name AS "playerName"
       FROM latest_posted_lineups l
       JOIN teams t ON t.team_id = l.team_id
       JOIN lineup_entries le ON le.lineup_snapshot_id = l.lineup_snapshot_id
       JOIN players p ON p.player_id = le.player_id
       ORDER BY l.game_pk, t.abbreviation, le.batting_order`,
      [date],
    ),
    pool.query(
      `WITH latest_starters AS (
         SELECT DISTINCT ON (s.game_pk, s.team_id) s.game_pk, s.team_id, s.player_id, s.starter_state
         FROM starters s JOIN games g ON g.game_pk = s.game_pk
         WHERE g.game_date = $1 AND s.source_id = 'MLB_OFFICIAL'
         ORDER BY s.game_pk, s.team_id, s.observed_at DESC
       )
       SELECT s.game_pk::bigint AS "gamePk", t.abbreviation AS team, s.player_id AS "playerId",
              p.full_name AS "playerName", s.starter_state AS "starterState"
       FROM latest_starters s JOIN teams t ON t.team_id = s.team_id JOIN players p ON p.player_id = s.player_id
       ORDER BY s.game_pk, t.abbreviation`,
      [date],
    ),
  ]);
  return {
    formatVersion: "1.1",
    officialRecord: "MLB Analyst Platform",
    exportedAt: new Date().toISOString(),
    slateDate: date,
    games: games.rows,
    confirmedLineups: lineups.rows,
    starters: starters.rows,
    marketBoard: board.rows,
    researchStates: research.rows,
  };
}

function xml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function worksheet(name: string, headers: string[], rows: unknown[][]) {
  const row = (cells: unknown[]) => `<Row>${cells.map((cell) => `<Cell><Data ss:Type="String">${xml(cell)}</Data></Cell>`).join("")}</Row>`;
  return `<Worksheet ss:Name="${xml(name)}"><Table>${row(headers)}${rows.map(row).join("")}</Table></Worksheet>`;
}

/** Excel-compatible XML workbook. It is derived output; platform state remains official. */
export async function buildWorkbookExport(rawDate: unknown) {
  const slate = await buildSlateExport(rawDate);
  const boardRows = slate.marketBoard as Array<Record<string, unknown>>;
  const games = slate.games as Array<Record<string, unknown>>;
  const marketSheets = ["TB", "XBH", "WALK", "HR"].map((market) => worksheet(
    market,
    ["Game", "Player", "Rank", "State", "Confidence"],
    boardRows.filter((row) => String(row.market).includes(market === "TB" ? "TOTAL_BASES" : market === "XBH" ? "EXTRA_BASE" : market === "WALK" ? "BATTER_WALK" : "HOME_RUN"))
      .map((row) => [row.gamePk, row.playerName, row.researchRank, row.researchState, row.confidenceLabel]),
  ));
  const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Title>MLB Analyst compatibility export</Title><Version>${xml(slate.formatVersion)}</Version><Description>Derived export only. MLB Analyst Platform is the official record.</Description></DocumentProperties>
${worksheet("README", ["Field", "Value"], [["Format version", slate.formatVersion], ["Official record", slate.officialRecord], ["Slate date", slate.slateDate]])}
${worksheet("Games", ["Game", "Away", "Home", "Start UTC", "Status", "Park"], games.map((g) => [g.gamePk, g.awayTeam, g.homeTeam, g.startTimeUtc, g.gameStatus, g.park]))}
${marketSheets.join("")}
${worksheet("Research States", ["Game", "Player", "Market", "State"], (slate.researchStates as Array<Record<string, unknown>>).map((r) => [r.gamePk, r.playerId, r.market, r.researchState]))}
</Workbook>`;
  return {
    workbook,
    filename: `mlb-analyst-${slate.slateDate}.xls`,
    formatVersion: slate.formatVersion,
    metadata: { formatVersion: slate.formatVersion, officialRecord: slate.officialRecord, derivedExport: true },
  };
}