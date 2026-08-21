import { Router, type IRouter } from "express";
import {
  GetAnalystBullpenRoomResponse,
  GetAnalystDataHealthResponse,
  GetAnalystGameLabResponse,
  GetAnalystPitcherLabResponse,
  GetAnalystPlayerLabResponse,
  GetAnalystProjectionsResponse,
  GetAnalystSettingsResponse,
  GetAnalystTodayResponse,
  RefreshAnalystResearchResponse,
  RefreshBullpenResponse,
} from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { ingestFantasyPros, ingestMlbOfficial } from "../services/data-foundation";
import { getPitcherLab, getPlayerLab, ingestResearch, ingestStatcastHandednessFallback, researchHealth } from "../services/research-foundation";
import { getBullpenRoom, refreshBullpen } from "../services/bullpen-foundation";

const router: IRouter = Router();
const fantasyProsConfigured = Boolean(process.env.FANTASYPROS_API_KEY);

function requestedDate(value: unknown) {
  const date = typeof value === "string" ? value : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");
  return date;
}

function requestedWindow(value: unknown) {
  const window = typeof value === "string" ? value : "SEASON";
  if (!["SEASON", "CAREER", "ROLLING_7", "ROLLING_14", "ROLLING_30", "ROLLING_60"].includes(window)) {
    throw new Error("window must be SEASON, CAREER, ROLLING_7, ROLLING_14, ROLLING_30, or ROLLING_60");
  }
  return window as "SEASON" | "CAREER" | "ROLLING_7" | "ROLLING_14" | "ROLLING_30" | "ROLLING_60";
}

function requestedPlayerId(value: unknown) {
  if (value === undefined) return null;
  const playerId = Number(value);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error("playerId must be a positive integer");
  return playerId;
}

function displayTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(value))
    : "TBD";
}

function isoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

async function sourceBadges() {
  const runs = await pool.query<{
    source_id: string;
    status: string;
    finished_at: string | null;
    row_count: number | null;
    normalized_row_count: number | null;
    rejected_row_count: number | null;
     http_status: number | null;
     duration_ms: number | null;
    error_message: string | null;
  }>(
    `SELECT DISTINCT ON (source_id) source_id, status, finished_at, row_count, normalized_row_count, rejected_row_count, http_status, duration_ms, error_message
     FROM ingest_runs
     WHERE source_id IN ('MLB_OFFICIAL', 'FANTASYPROS', 'STATCAST', 'FANGRAPHS', 'PARK_FACTORS')
     ORDER BY source_id, started_at DESC`,
  );
  const bySource = new Map(runs.rows.map((row) => [row.source_id, row]));
  const makeRunBadge = (name: string, run: {
    status: string; finished_at: string | null; row_count: number | null; normalized_row_count: number | null;
    rejected_row_count: number | null; http_status: number | null; duration_ms: number | null; error_message: string | null;
  } | undefined, configured = true) => {
    if (!configured) return { name, status: "NOT CONFIGURED", freshness: "Credential missing", lastSuccess: null, rowCount: 0, detail: "A server-side credential is required." };
    if (!run) return { name, status: "NOT RUN", freshness: "No successful ingest", lastSuccess: null, rowCount: 0, detail: "No ingestion run has completed." };
    const status = run.status === "SUCCESS" ? "FRESH" : run.status === "PARTIAL" ? "PARTIAL" : "BLOCKED";
    const detail = run.error_message
      ? run.error_message
      : `${run.normalized_row_count ?? 0} normalized · ${run.rejected_row_count ?? 0} rejected${run.http_status ? ` · HTTP ${run.http_status}` : ""}${run.duration_ms ? ` · ${run.duration_ms}ms` : ""}`;
    return {
      name,
      status,
      freshness: run.finished_at ? `Last attempt ${new Date(run.finished_at).toLocaleString("en-US", { timeZone: "America/New_York" })}` : "In progress",
      lastSuccess: run.status === "SUCCESS" || run.status === "PARTIAL" ? isoString(run.finished_at) : null,
      rowCount: run.row_count ?? 0,
      detail,
    };
  };
  const splitRun = await pool.query<{
    status: string; finished_at: string | null; row_count: number | null; normalized_row_count: number | null;
    rejected_row_count: number | null; http_status: number | null; duration_ms: number | null; error_message: string | null;
  }>(
    `SELECT status, finished_at, row_count, normalized_row_count, rejected_row_count, http_status, duration_ms, error_message
     FROM ingest_runs WHERE source_id = 'STATCAST' AND job_name = 'statcast_search_handedness_fallback'
     ORDER BY started_at DESC LIMIT 1`,
  );
  const makeBadge = (sourceId: string, name: string, configured: boolean) => makeRunBadge(name, bySource.get(sourceId), configured);
  return [
    makeBadge("MLB_OFFICIAL", "MLB Official", true),
    makeBadge("FANTASYPROS", "FantasyPros", fantasyProsConfigured),
    makeBadge("STATCAST", "Baseball Savant / Statcast", true),
    makeRunBadge("Statcast Search splits", splitRun.rows[0]),
    makeBadge("FANGRAPHS", "FanGraphs", true),
    makeBadge("PARK_FACTORS", "Statcast Park Factors", true),
    { name: "Weather", status: "NOT CONFIGURED", freshness: "No provider", lastSuccess: null, rowCount: 0, detail: "Optional source; no weather credential is configured." },
  ];
}

async function identityCoverage(date: string) {
  const result = await pool.query<{
    official_starters_mapped: number; official_starters_total: number;
    official_lineup_players_mapped: number; official_lineup_players_total: number;
    projected_lineup_players_mapped: number; projected_lineup_players_total: number;
    active_projection_players_mapped: number; active_projection_players_total: number;
    unresolved_active_players: number; quarantined_rows: number;
    team_assignment_conflicts: number; blocking_projected_lineup_issues: number;
  }>(
    `WITH latest_starters AS (
       SELECT DISTINCT ON (s.game_pk, s.team_id) s.player_id
       FROM starters s JOIN games g ON g.game_pk = s.game_pk
       WHERE g.game_date = $1 AND s.source_id = 'MLB_OFFICIAL'
       ORDER BY s.game_pk, s.team_id, s.observed_at DESC
     ),
     latest_official_lineups AS (
       SELECT DISTINCT ON (ls.game_pk, ls.team_id) ls.lineup_snapshot_id
       FROM lineup_snapshots ls JOIN games g ON g.game_pk = ls.game_pk
       WHERE g.game_date = $1 AND ls.source_id = 'MLB_OFFICIAL' AND ls.state = 'POSTED'
       ORDER BY ls.game_pk, ls.team_id, ls.observed_at DESC
     ),
     latest_projected_lineups AS (
       SELECT DISTINCT ON (ls.game_pk, ls.team_id) ls.lineup_snapshot_id, ls.raw
       FROM lineup_snapshots ls JOIN games g ON g.game_pk = ls.game_pk
       WHERE g.game_date = $1 AND ls.source_id = 'FANTASYPROS' AND ls.state = 'PROJECTED'
       ORDER BY ls.game_pk, ls.team_id, ls.observed_at DESC
     ),
     current_projection_rows AS (
       SELECT DISTINCT ON (s.snapshot_label, f.source_player_id)
         f.source_player_id, f.canonical_player_id, pe.eligible_today_research, pe.requires_identity_review
       FROM fantasypros_projection_rows f
       JOIN fantasypros_projection_snapshots s ON s.snapshot_id = f.snapshot_id
       LEFT JOIN player_eligibility pe ON pe.source_id = 'FANTASYPROS'
         AND pe.external_player_id = f.source_player_id AND pe.effective_date = s.effective_date
       WHERE s.effective_date = $1
       ORDER BY s.snapshot_label, f.source_player_id, s.retrieved_at DESC
     )
     SELECT
       (SELECT count(*) FILTER (WHERE player_id IS NOT NULL)::int FROM latest_starters) AS official_starters_mapped,
       (SELECT count(*)::int FROM latest_starters) AS official_starters_total,
       (SELECT count(*) FILTER (WHERE le.player_id IS NOT NULL)::int FROM lineup_entries le JOIN latest_official_lineups l ON l.lineup_snapshot_id = le.lineup_snapshot_id) AS official_lineup_players_mapped,
       (SELECT count(*)::int FROM lineup_entries le JOIN latest_official_lineups l ON l.lineup_snapshot_id = le.lineup_snapshot_id) AS official_lineup_players_total,
       (SELECT count(*)::int FROM lineup_entries le JOIN latest_projected_lineups l ON l.lineup_snapshot_id = le.lineup_snapshot_id) AS projected_lineup_players_mapped,
       (SELECT COALESCE(sum(
         CASE WHEN jsonb_typeof(l.raw->'entries') = 'array' THEN jsonb_array_length(l.raw->'entries')
              ELSE (SELECT count(*)::int FROM lineup_entries le WHERE le.lineup_snapshot_id = l.lineup_snapshot_id)
         END
       ), 0)::int FROM latest_projected_lineups l) AS projected_lineup_players_total,
       (SELECT count(*) FILTER (WHERE canonical_player_id IS NOT NULL AND eligible_today_research)::int FROM current_projection_rows) AS active_projection_players_mapped,
       (SELECT count(*)::int FROM current_projection_rows) AS active_projection_players_total,
       (SELECT count(*) FILTER (WHERE requires_identity_review)::int FROM current_projection_rows) AS unresolved_active_players,
       (SELECT count(*)::int FROM player_eligibility WHERE source_id = 'FANTASYPROS' AND effective_date = $1 AND quarantined_from_current_research) AS quarantined_rows,
       (SELECT count(*)::int FROM ingest_issues
        WHERE issue_type = 'TEAM_ASSIGNMENT_CONFLICT'
          AND ingest_run_id = (
            SELECT ingest_run_id FROM ingest_runs
            WHERE source_id = 'FANTASYPROS' AND effective_date = $1
            ORDER BY started_at DESC LIMIT 1
          )) AS team_assignment_conflicts,
       (SELECT count(*)::int FROM ingest_issues
        WHERE issue_type = 'PROJECTED_LINEUP_IDENTITY_BLOCKING'
          AND ingest_run_id = (
            SELECT ingest_run_id FROM ingest_runs
            WHERE source_id = 'FANTASYPROS' AND effective_date = $1
            ORDER BY started_at DESC LIMIT 1
          )) AS blocking_projected_lineup_issues`,
    [date],
  );
  const row = result.rows[0];
  return {
    officialStartersMapped: row?.official_starters_mapped ?? 0,
    officialStartersTotal: row?.official_starters_total ?? 0,
    officialLineupPlayersMapped: row?.official_lineup_players_mapped ?? 0,
    officialLineupPlayersTotal: row?.official_lineup_players_total ?? 0,
    projectedLineupPlayersMapped: row?.projected_lineup_players_mapped ?? 0,
    projectedLineupPlayersTotal: row?.projected_lineup_players_total ?? 0,
    activeProjectionPlayersMapped: row?.active_projection_players_mapped ?? 0,
    activeProjectionPlayersTotal: row?.active_projection_players_total ?? 0,
    unresolvedActivePlayers: row?.unresolved_active_players ?? 0,
    quarantinedRows: row?.quarantined_rows ?? 0,
    teamAssignmentConflicts: row?.team_assignment_conflicts ?? 0,
    blockingProjectedLineupIssues: row?.blocking_projected_lineup_issues ?? 0,
  };
}

router.get("/analyst/today", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const [gameResult, sources, coverage] = await Promise.all([
      pool.query<{
        game_pk: number; start_time_utc: string | null; away: string; home: string; park: string | null;
         away_starter: string | null; home_starter: string | null; away_hand: string | null; home_hand: string | null;
         away_state: string | null; home_state: string | null; posted_lineup_teams: number; projected_lineup_teams: number;
      }>(
        `SELECT g.game_pk, g.start_time_utc, away.abbreviation AS away, home.abbreviation AS home, v.name AS park,
          away_start.full_name AS away_starter, home_start.full_name AS home_starter,
          away_start.throws AS away_hand, home_start.throws AS home_hand,
          away_start.starter_state AS away_state, home_start.starter_state AS home_state,
          COALESCE(lineups.posted_lineup_teams, 0) AS posted_lineup_teams,
          COALESCE(lineups.projected_lineup_teams, 0) AS projected_lineup_teams
         FROM games g
         JOIN teams away ON away.team_id = g.away_team_id
         JOIN teams home ON home.team_id = g.home_team_id
         LEFT JOIN venues v ON v.venue_id = g.venue_id
         LEFT JOIN LATERAL (
            SELECT s.starter_state, p.full_name, p.throws FROM starters s LEFT JOIN players p ON p.player_id = s.player_id
           WHERE s.game_pk = g.game_pk AND s.team_id = g.away_team_id ORDER BY s.observed_at DESC LIMIT 1
         ) away_start ON true
         LEFT JOIN LATERAL (
            SELECT s.starter_state, p.full_name, p.throws FROM starters s LEFT JOIN players p ON p.player_id = s.player_id
           WHERE s.game_pk = g.game_pk AND s.team_id = g.home_team_id ORDER BY s.observed_at DESC LIMIT 1
         ) home_start ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(DISTINCT team_id) FILTER (WHERE state = 'POSTED')::int AS posted_lineup_teams,
                   COUNT(DISTINCT team_id) FILTER (WHERE state = 'PROJECTED')::int AS projected_lineup_teams
            FROM lineup_snapshots WHERE game_pk = g.game_pk
          ) lineups ON true
         WHERE g.game_date = $1 ORDER BY g.start_time_utc NULLS LAST`,
        [date],
      ),
      sourceBadges(),
      identityCoverage(date),
    ]);
    const games = gameResult.rows.map((game) => ({
      id: String(game.game_pk),
      time: displayTime(game.start_time_utc),
      away: game.away,
      home: game.home,
      park: game.park ?? "NOT FOUND",
      roof: "NOT FOUND",
      weather: "NOT FOUND",
      awayStarter: { name: game.away_starter ?? "TBD", hand: game.away_hand || "NOT FOUND", state: game.away_state ?? "TBD", note: "" },
      homeStarter: { name: game.home_starter ?? "TBD", hand: game.home_hand || "NOT FOUND", state: game.home_state ?? "TBD", note: "" },
      lineupState: game.posted_lineup_teams === 2 ? "POSTED" : game.projected_lineup_teams > 0 ? "PROJECTED" : "UNKNOWN",
      state: game.posted_lineup_teams === 2 && game.away_state === "CONFIRMED" && game.home_state === "CONFIRMED"
        ? "READY"
        : "PARTIAL",
      flag: game.posted_lineup_teams === 2
        ? "Official posted lineups persisted"
        : game.projected_lineup_teams > 0
          ? "FantasyPros projected lineup evidence"
          : "No lineup evidence found",
    }));
    const today = {
      date: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date(`${date}T12:00:00Z`)),
      timezone: "America/New_York",
      games,
      sources,
      identityCoverage: coverage,
      alerts: [
        "Pre-model slate status uses READY, PARTIAL, and BLOCKED only.",
        "No forecast, price, odds, implied probability, EV, or CLV data is used in this workflow.",
        games.length ? "Official schedule and starter observations are persisted." : "No official schedule records have been ingested for this date.",
        coverage.blockingProjectedLineupIssues
          ? `${coverage.blockingProjectedLineupIssues} projected-lineup identity issue(s) are blocking research eligibility.`
          : "Projected lineup identities have no current blocking issue.",
      ],
    };
    res.json(GetAnalystTodayResponse.parse(today));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/projections", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const snapshots = await pool.query<{ snapshot_id: string; retrieved_at: string; snapshot_label: string | null }>(
      `SELECT DISTINCT ON (snapshot_label) snapshot_id, retrieved_at, snapshot_label FROM fantasypros_projection_snapshots
       WHERE effective_date = $1
       ORDER BY snapshot_label, retrieved_at DESC`,
      [date],
    );
    const currentAsOf = snapshots.rows.reduce<string | null>((latest, snapshot) => !latest || snapshot.retrieved_at > latest ? snapshot.retrieved_at : latest, null);
    type ProjectionDbRow = {
      source_player_id: string;
      team_abbreviation: string | null;
      position: string | null;
      projected_stats: Record<string, unknown>;
      raw_row: Record<string, unknown>;
    };
    const rows: ProjectionDbRow[] = snapshots.rows.length
      ? (await pool.query<ProjectionDbRow>(
       `SELECT f.source_player_id, f.team_abbreviation, f.position, f.projected_stats, f.raw_row
          FROM fantasypros_projection_rows f
          JOIN fantasypros_projection_snapshots s ON s.snapshot_id = f.snapshot_id
          JOIN player_eligibility pe ON pe.source_id = 'FANTASYPROS'
            AND pe.external_player_id = f.source_player_id AND pe.effective_date = s.effective_date
          WHERE f.snapshot_id = ANY($1) AND pe.eligible_today_research AND NOT pe.requires_identity_review
           ORDER BY f.team_abbreviation, f.source_player_id`,
        [snapshots.rows.map((snapshot) => snapshot.snapshot_id)],
      )).rows
      : [];
    const playerFilter = String(req.query.player ?? "").trim().toLowerCase();
    const teamFilter = String(req.query.team ?? "").trim().toLowerCase();
    const roleFilter = String(req.query.role ?? "").trim().toLowerCase();
    const filteredRows = rows.filter((row) => {
      const player = String(row.raw_row?.player_name ?? row.raw_row?.name ?? row.source_player_id).toLowerCase();
      return (!playerFilter || player.includes(playerFilter))
        && (!teamFilter || String(row.team_abbreviation ?? "").toLowerCase() === teamFilter)
        && (!roleFilter || String(row.position ?? "").toLowerCase() === roleFilter);
    });
    const projectionRows = filteredRows.flatMap((row) => {
      const stats = row.projected_stats ?? {};
      const player = String(row.raw_row?.player_name ?? row.raw_row?.name ?? row.source_player_id);
      const base = { player, team: row.team_abbreviation ?? "—", position: row.position ?? "—", prior: null, asOf: isoString(currentAsOf) ?? "NOT FOUND", movement: "No prior snapshot" };
      return [
        { ...base, market: "2+ Total Bases", current: null, movement: "Model not built" },
        { ...base, market: "1+ XBH", current: null, movement: "Components only · no derivation" },
        { ...base, market: "Batter Walk", current: typeof stats.bb === "number" ? stats.bb : null, movement: "Source component" },
        { ...base, market: "Home Run", current: typeof stats.hrs === "number" ? stats.hrs : null, movement: "Source component" },
      ];
    });
    res.json(GetAnalystProjectionsResponse.parse({
      snapshotLabel: snapshots.rows.length ? "FantasyPros · current hitter and pitcher snapshots" : (fantasyProsConfigured ? "FantasyPros · waiting for first ingest" : "FantasyPros · credential required"),
      effectiveDate: date.slice(0, 10),
      snapshotIds: snapshots.rows.map((snapshot) => snapshot.snapshot_id),
      uniqueEligibleHitters: filteredRows.filter((row) => row.position === "H").length,
      uniqueEligiblePitchers: filteredRows.filter((row) => row.position === "P").length,
      uniqueEligiblePlayers: new Set(filteredRows.map((row) => row.source_player_id)).size,
      currentAsOf: isoString(currentAsOf) ?? "NOT FOUND",
      priorAsOf: null,
      rows: projectionRows,
      systemNotes: [
        "Each FantasyPros response is stored as an immutable snapshot with raw payload metadata and checksum.",
        "Only current, authoritative-roster-eligible players appear here; quarantined raw rows remain available to audit.",
        "Latest uses only the listed snapshots for this effective date; component rows are not distinct current players.",
        "Walk and home run cells are source components, not predicted market probabilities.",
        "2+ Total Bases and 1+ XBH remain explicitly unmodeled until validated research engines exist.",
      ],
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/data-health", async (_req, res, next) => {
  try {
    const date = requestedDate(undefined);
    const [sources, issueResult, lastRun, coverage, research] = await Promise.all([
      sourceBadges(),
      pool.query<{ issue_type: string; detail: string; severity: string }>(
        `SELECT issue_type, detail, severity FROM ingest_issues WHERE resolved_at IS NULL
         UNION ALL
         SELECT 'IDENTITY_REVIEW' AS issue_type, CONCAT(raw_name, ' (FantasyPros ID ', external_player_id, ') requires review') AS detail, 'REVIEW' AS severity
         FROM identity_review_queue WHERE state = 'OPEN'
         ORDER BY issue_type LIMIT 50`,
      ),
      pool.query<{ finished_at: string | null }>("SELECT max(finished_at) AS finished_at FROM ingest_runs"),
      identityCoverage(date),
      researchHealth(),
    ]);
    const phaseTwoSources = sources.filter((source) => !["FanGraphs", "Weather"].includes(source.name));
    const phaseTwoReady = research.handednessCoverageScope === "FULL_ELIGIBLE_HITTER_AND_PITCHER_UNIVERSE"
      && research.handednessIngestStatus === "SUCCESS"
      && research.missingHandednessSplits === 0
      && research.handednessTargetPlayers === research.handednessCoveredPlayers
      && research.parkRequiredVenues > 0
      && research.parkVenueCoverageGaps === 0;
    const sourceStatus = !phaseTwoReady || phaseTwoSources.some((source) => source.status === "BLOCKED" || source.status === "NOT RUN") ? "BLOCKED"
      : "READY";
    res.json(GetAnalystDataHealthResponse.parse({
      overall: sourceStatus,
      phase2aReady: phaseTwoReady,
      sources,
      issues: issueResult.rows.map((issue) => ({ label: issue.issue_type.replaceAll("_", " "), detail: issue.detail, severity: issue.severity })),
      identityCoverage: coverage,
      researchHealth: research,
      lastRun: isoString(lastRun.rows[0]?.finished_at) ?? "No completed ingestion runs recorded",
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/player-lab", async (req, res, next) => {
  try {
    const profile = await getPlayerLab(
      requestedPlayerId(req.query.playerId),
      String(req.query.search ?? "").trim(),
      requestedWindow(req.query.window),
      requestedDate(req.query.date),
    );
    res.json(GetAnalystPlayerLabResponse.parse(profile));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/pitcher-lab", async (req, res, next) => {
  try {
    const profile = await getPitcherLab(
      requestedPlayerId(req.query.playerId),
      String(req.query.search ?? "").trim(),
      requestedWindow(req.query.window),
      requestedDate(req.query.date),
    );
    res.json(GetAnalystPitcherLabResponse.parse(profile));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/game-lab", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const games = await pool.query<{
      game_pk: number; venue_id: number | null; start_time_utc: string | null; away: string; home: string; park: string | null;
      away_starter: string | null; home_starter: string | null; away_hand: string | null; home_hand: string | null;
      away_state: string | null; home_state: string | null; posted_lineup_teams: number; projected_lineup_teams: number;
    }>(
       `SELECT g.game_pk, g.venue_id, g.start_time_utc, away.abbreviation AS away, home.abbreviation AS home, v.name AS park,
        away_start.full_name AS away_starter, home_start.full_name AS home_starter, away_start.throws AS away_hand, home_start.throws AS home_hand,
        away_start.starter_state AS away_state, home_start.starter_state AS home_state,
        COALESCE(lineups.posted_lineup_teams, 0) AS posted_lineup_teams, COALESCE(lineups.projected_lineup_teams, 0) AS projected_lineup_teams
       FROM games g JOIN teams away ON away.team_id = g.away_team_id JOIN teams home ON home.team_id = g.home_team_id
       LEFT JOIN venues v ON v.venue_id = g.venue_id
       LEFT JOIN LATERAL (SELECT s.starter_state, p.full_name, p.throws FROM starters s LEFT JOIN players p ON p.player_id = s.player_id WHERE s.game_pk = g.game_pk AND s.team_id = g.away_team_id ORDER BY s.observed_at DESC LIMIT 1) away_start ON true
       LEFT JOIN LATERAL (SELECT s.starter_state, p.full_name, p.throws FROM starters s LEFT JOIN players p ON p.player_id = s.player_id WHERE s.game_pk = g.game_pk AND s.team_id = g.home_team_id ORDER BY s.observed_at DESC LIMIT 1) home_start ON true
       LEFT JOIN LATERAL (SELECT COUNT(DISTINCT team_id) FILTER (WHERE state = 'POSTED')::int AS posted_lineup_teams, COUNT(DISTINCT team_id) FILTER (WHERE state = 'PROJECTED')::int AS projected_lineup_teams FROM lineup_snapshots WHERE game_pk = g.game_pk) lineups ON true
       WHERE g.game_date = $1 ORDER BY g.start_time_utc NULLS LAST`,
      [date],
    );
    const responseGames = games.rows.map((game) => ({
      id: String(game.game_pk), time: displayTime(game.start_time_utc), away: game.away, home: game.home,
      park: game.park ?? "NOT FOUND", roof: "NOT FOUND", weather: "NOT FOUND",
      awayStarter: { name: game.away_starter ?? "TBD", hand: game.away_hand ?? "NOT FOUND", state: game.away_state ?? "TBD", note: "" },
      homeStarter: { name: game.home_starter ?? "TBD", hand: game.home_hand ?? "NOT FOUND", state: game.home_state ?? "TBD", note: "" },
      lineupState: game.posted_lineup_teams === 2 ? "POSTED" : game.projected_lineup_teams ? "PROJECTED" : "UNKNOWN",
      state: game.posted_lineup_teams === 2 && game.away_state === "CONFIRMED" && game.home_state === "CONFIRMED" ? "READY" : "PARTIAL" as const,
      flag: game.posted_lineup_teams === 2 ? "Official posted lineups persisted" : "Research context only — no matchup score",
    }));
    const selectedIndex = req.query.gameId ? games.rows.findIndex((game) => game.game_pk === Number(req.query.gameId)) : (games.rows.length ? 0 : -1);
    const selected = selectedIndex >= 0 ? responseGames[selectedIndex] : null;
    const selectedDb = selectedIndex >= 0 ? games.rows[selectedIndex] : null;
    const fallbackParkFactors = [
      ["hr_factor", "Home run component", "HR component factor."],
      ["doubles_factor", "Doubles component", "2B component factor."],
      ["triples_factor", "Triples component", "3B component factor."],
      ["xbh_factor", "Extra-base hit component", "XBH component factor."],
    ].map(([key, label, definition]) => ({
      key, label, value: null, unit: "factor", denominator: null, sampleSize: null,
        source: "NOT FOUND", definition, transformation: "RAW" as const, status: "NOT_FOUND" as const, retrievedAt: "NOT FOUND",
    }));
    const parkSnapshot = selectedDb?.venue_id ? await pool.query<{
      span: string; retrieved_at: string; park_research_snapshot_id: string; batter_side: string | null;
    }>(
      `SELECT DISTINCT ON (f.batter_side) ps.park_research_snapshot_id, ps.span, ps.retrieved_at, f.batter_side
       FROM park_research_snapshots ps JOIN park_research_features f ON f.park_research_snapshot_id = ps.park_research_snapshot_id
       WHERE ps.venue_id = $1 ORDER BY f.batter_side NULLS FIRST, ps.season DESC, ps.retrieved_at DESC`,
      [selectedDb.venue_id],
    ) : { rows: [] };
    let parkFactors: Array<{
      key: string; label: string; value: number | null; unit: string; denominator: number | null; sampleSize: number | null;
      source: string; definition: string; transformation: "RAW" | "NORMALIZED" | "DERIVED" | "DERIVED_FROM_STATCAST" | "HEURISTIC";
      status: "AVAILABLE" | "INSUFFICIENT_SAMPLE" | "NOT_FOUND" | "QUARANTINED"; retrievedAt: string;
    }> = parkSnapshot.rows.length ? (await pool.query<{
      metric_key: string; metric_label: string; value: string | null; batter_side: string | null; transformation: "RAW" | "NORMALIZED" | "DERIVED" | "DERIVED_FROM_STATCAST" | "HEURISTIC"; sample_status: "AVAILABLE" | "INSUFFICIENT_SAMPLE" | "NOT_FOUND" | "QUARANTINED"; definition: string;
    }>(
       `SELECT metric_key, metric_label, value, batter_side, transformation, sample_status, definition
        FROM park_research_features WHERE park_research_snapshot_id = ANY($1) ORDER BY batter_side NULLS FIRST, metric_label`,
       [parkSnapshot.rows.map((snapshot) => snapshot.park_research_snapshot_id)],
    )).rows.map((factor) => ({
      key: `${factor.metric_key}-${factor.batter_side ?? "all"}`,
      label: `${factor.metric_label}${factor.batter_side ? ` vs ${factor.batter_side}HB` : ""}`,
      value: factor.value === null ? null : Number(factor.value),
      unit: "factor", denominator: null, sampleSize: null,
      source: "Baseball Savant Statcast Park Factors", definition: factor.definition,
      transformation: factor.transformation, status: factor.sample_status,
       retrievedAt: isoString(parkSnapshot.rows[0]?.retrieved_at) ?? "NOT FOUND",
    })) : fallbackParkFactors;
    res.json(GetAnalystGameLabResponse.parse({
      date,
      games: responseGames,
      selectedGame: selected,
       parkResearch: selected ? { venue: selected.park, span: parkSnapshot.rows.map((snapshot) => snapshot.span).filter((span, index, spans) => spans.indexOf(span) === index).join(", ") || "NOT FOUND", factors: parkFactors } : null,
      notes: [
        "Game Lab exposes research-ready starter, lineup, park, and freshness context only.",
        "Park values are raw Baseball Savant components when available. No Total Bases composite or heuristic is presented.",
        "No market probability, recommendation, price, odds, EV, or CLV is calculated in Phase 2A.",
      ],
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/settings", (_req, res) => {
  res.json(GetAnalystSettingsResponse.parse({
    connections: [
      { name: "FantasyPros", configured: fantasyProsConfigured, detail: fantasyProsConfigured ? "Secret present · server-side only" : "Not configured" },
      { name: "MLB Official", configured: true, detail: "Public official Stats API adapter" },
      { name: "Weather", configured: false, detail: "Optional source not configured" },
    ],
    timezone: "America/New_York",
    defaultMarket: "2+ total bases",
    refreshCadence: "Manual refresh during data foundation",
  }));
});

router.post("/analyst/refresh/mlb", async (req, res, next) => {
  try {
    res.status(201).json(await ingestMlbOfficial(requestedDate(req.query.date)));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/fantasypros", async (req, res, next) => {
  try {
    res.status(201).json(await ingestFantasyPros(requestedDate(req.query.date)));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/research", async (req, res, next) => {
  try {
    res.status(201).json(RefreshAnalystResearchResponse.parse(await ingestResearch(requestedDate(req.query.date))));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/research/splits-full", async (req, res, next) => {
  try {
    res.status(202).json(await ingestStatcastHandednessFallback(requestedDate(req.query.date), "FULL_UNIVERSE", 24));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/bullpen-room", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const team = typeof req.query.team === "string" && req.query.team.trim()
      ? req.query.team.trim().toUpperCase()
      : undefined;
    const data = await getBullpenRoom(date, team);
    res.json(GetAnalystBullpenRoomResponse.parse(data));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/bullpen", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const result = await refreshBullpen(date);
    res.status(201).json(RefreshBullpenResponse.parse({
      source: "BULLPEN",
      slateDate: date,
      gamesProcessed: result.gamesProcessed,
      appearancesNormalized: result.appearancesNormalized,
      appearancesRejected: result.appearancesRejected,
      teamsComputed: result.teamsComputed,
      error: result.error ?? null,
    }));
  } catch (error) {
    next(error);
  }
});

export default router;