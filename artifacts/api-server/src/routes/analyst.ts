import { Router, type IRouter, type RequestHandler } from "express";
import {
  GetAnalystBullpenRoomResponse,
  GetAnalystDataHealthResponse,
  GetAnalystGameLabResponse,
  GetAnalystMarketResearchResponse,
  GetAnalystPitcherLabResponse,
  GetAnalystPlayerLabResponse,
  GetAnalystProjectionsResponse,
  GetAnalystSettingsResponse,
  GetAnalystTodayResponse,
  CorrectFeatureStoreSnapshotBody,
  RefreshAnalystResearchResponse,
  RefreshBullpenResponse,
  RefreshMarketResearchTBResponse,
  RefreshMarketResearchXBHResponse,
  RefreshMarketResearchWALKResponse,
  RefreshMarketResearchHRResponse,
  WriteFeatureStoreOutcomeBody,
  TrainAnalystModelResponse,
  GetAnalystModelsResponse,
  ValidateAnalystModelResponse,
  GetAnalystModelValidationResponse,
  GetAnalystDailyMarketBoardResponse,
  GetAnalystDailyBoardGameSummaryResponse,
  RefreshAnalystDailyMarketBoardResponse,
  GetAnalystBettorSourcesResponse,
  CreateAnalystBettorSourceBody,
  CreateAnalystBettorSourceResponse,
  UpdateAnalystBettorSourceBody,
  UpdateAnalystBettorSourceParams,
  UpdateAnalystBettorSourceResponse,
  DeleteAnalystBettorSourceParams,
  DeleteAnalystBettorSourceResponse,
  IngestAnalystBettorPickBody,
  IngestAnalystBettorPickResponse,
  GetAnalystBettorPicksResponse,
  GetAnalystBettorEvaluationQueryParams,
  GetAnalystBettorEvaluationResponse,
  GetAnalystAiToolRegistryResponse,
  CallAnalystAiToolBody,
  CallAnalystAiToolResponse,
} from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { ingestFantasyPros, ingestMlbOfficial } from "../services/data-foundation";
import { getPitcherLab, getPlayerLab, ingestResearch, ingestStatcastHandednessFallback, researchHealth } from "../services/research-foundation";
import { getBullpenRoom, refreshBullpen } from "../services/bullpen-foundation";
import { runTBEngine } from "../services/tb-engine";
import { runXBHEngine } from "../services/xbh-engine";
import { runWALKEngine } from "../services/walk-engine";
import { runHREngine } from "../services/hr-engine";
import {
  backfillHistoricalSnapshots,
  captureSlateSnapshots,
  correctSnapshot,
  FeatureStoreValidationError,
  queryFeatureStore,
  writeHistoricalOutcome,
} from "../services/feature-store";
import {
  createMarketPostmortem,
  queryMarketPostmortems,
  querySettlements,
  settleOfficialDate,
  settleOfficialGame,
  SettlementValidationError,
} from "../services/settlement";
import {
  MODEL_MARKETS,
  ModelTrainingValidationError,
  queryModelVersions,
  trainMarketModel,
  type ModelMarket,
} from "../services/model-training";
import {
  queryWalkForwardRuns,
  validateModelVersion,
  WalkForwardValidationError,
} from "../services/walk-forward-validation";
import {
  DailyMarketBoardValidationError,
  type BoardMarket,
  populateDailyMarketBoard,
  queryDailyBoardGameSummary,
  queryDailyMarketBoard,
} from "../services/daily-market-board";
import {
  BETTOR_MARKETS,
  BettorIntelligenceConflictError,
  BettorIntelligenceValidationError,
  createBettorSource,
  deleteBettorSource,
  ingestBettorPick,
  queryBettorEvaluation,
  queryBettorPicks,
  queryBettorSources,
  updateBettorSource,
  type BettorMarket,
} from "../services/bettor-intelligence";
import { executeAiToolCall, queryAiToolRegistry, rejectAiToolCall } from "../services/ai-tool-gateway";

const router: IRouter = Router();
const fantasyProsConfigured = Boolean(process.env.FANTASYPROS_API_KEY);

function requestedDate(value: unknown) {
  const date = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : typeof value === "string"
      ? value
      : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");
  return date;
}

function requestedBoardDate(value: unknown) {
  const date = requestedDate(value);
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new DailyMarketBoardValidationError("date must be a real calendar date");
  }
  return date;
}

function requestedBettorDate(value: unknown) {
  try {
    if (value == null || value === "") {
      throw new Error("date is required and must use YYYY-MM-DD");
    }
    const date = requestedDate(value);
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error("date must be a real calendar date using YYYY-MM-DD");
    }
    return date;
  } catch (error) {
    throw new BettorIntelligenceValidationError(error instanceof Error ? error.message : "date must use YYYY-MM-DD");
  }
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function engineResponseDate<T extends { slateDate: Date }>(response: T, slateDate: string) {
  return { ...response, slateDate };
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

// ─── Phase 3 – Market Research Contract ──────────────────────────────────────

/**
 * Maps API short-code market identifiers to the DB enum values stored in
 * market_research_candidates.market (marketTypeEnum).
 * Engines 3A–3D write using the DB enum; the API exposes short codes.
 */
const MARKET_SHORTCODE_TO_DB: Record<string, string> = {
  TB: "TOTAL_BASES_2_PLUS",
  XBH: "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR: "HOME_RUN",
};
const MARKET_DB_TO_SHORTCODE: Record<string, string> = {
  TOTAL_BASES_2_PLUS: "TB",
  EXTRA_BASE_HIT: "XBH",
  BATTER_WALK: "WALK",
  HOME_RUN: "HR",
};

const RANK_DONT_GATE_SEMANTICS =
  "RANK_DONT_GATE: research_rank is an ordinal integer only; " +
  "1 = highest-ranked candidate for this market+date. " +
  "Ties share the same integer value and are never collapsed. " +
  "No state value removes a candidate from the board. " +
  "This rank implies no threshold, gate, probability, or recommendation.";

const PROHIBITED_FIELDS = [
  "ev", "clv", "odds", "impliedProbability", "vigJuice",
  "edgePercent", "kellyFraction", "expectedValue",
];

/**
 * Canonical set of prohibited key names checked case-insensitively.
 * Any JSONB evidence payload that contains one of these keys at any depth
 * is sanitized before leaving the API layer. This is a defense-in-depth
 * measure; engines 3A–3D must also never write these keys.
 */
const PROHIBITED_KEY_SET = new Set<string>(PROHIBITED_FIELDS.map((k) => k.toLowerCase()));

/**
 * Recursively strips any object key whose lowercase form appears in
 * PROHIBITED_KEY_SET from an arbitrary value. Arrays are traversed
 * element-by-element; primitives are returned unchanged.
 */
function stripProhibitedKeys(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(stripProhibitedKeys);
  if (val !== null && typeof val === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (!PROHIBITED_KEY_SET.has(k.toLowerCase())) {
        cleaned[k] = stripProhibitedKeys(v);
      }
    }
    return cleaned;
  }
  return val;
}

router.get("/analyst/market-research", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const marketParam = typeof req.query.market === "string"
      ? req.query.market.trim().toUpperCase()
      : null;
    const gameId = typeof req.query.gameId === "string" && req.query.gameId.trim()
      ? req.query.gameId.trim()
      : null;

    // Validate market short code if provided
    if (marketParam && !MARKET_SHORTCODE_TO_DB[marketParam]) {
      res.status(400).json({ error: `Invalid market '${marketParam}'. Valid values: TB, XBH, WALK, HR` });
      return;
    }

    const dbMarket = marketParam ? MARKET_SHORTCODE_TO_DB[marketParam] : null;

    // Validate gameId is a safe positive integer
    let gameIdNum: number | null = null;
    if (gameId) {
      const parsed = parseInt(gameId, 10);
      if (isNaN(parsed) || parsed <= 0 || String(parsed) !== gameId) {
        res.status(400).json({ error: `Invalid gameId '${gameId}'. Must be a positive integer (e.g. the MLB game_pk).` });
        return;
      }
      gameIdNum = parsed;
    }

    // Build parameterized query with conditional filters
    const sqlParams: (string | number)[] = [date];
    const conditions: string[] = ["mrc.slate_date = $1"];
    if (dbMarket) { sqlParams.push(dbMarket); conditions.push(`mrc.market = $${sqlParams.length}`); }
    if (gameIdNum !== null) { sqlParams.push(gameIdNum); conditions.push(`mrc.game_pk = $${sqlParams.length}`); }

    const candidateResult = await pool.query<{
      candidate_id: string;
      slate_date: string;
      game_pk: number;
      player_id: number;
      player_name: string;
      market: string;
      research_rank: number | null;
      research_state: string;
      primary_mechanism: string | null;
      secondary_mechanism: string | null;
      opportunity_evidence: Record<string, unknown>;
      starter_matchup_evidence: Record<string, unknown>;
      bullpen_path_evidence: Record<string, unknown>;
      park_evidence: Record<string, unknown>;
      recent_vs_season_vs_career: Record<string, unknown>;
      counter_evidence: Record<string, unknown>;
      missing_stale_evidence: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT mrc.candidate_id, mrc.slate_date::text, mrc.game_pk::bigint,
              mrc.player_id, COALESCE(p.full_name, 'Unknown') AS player_name,
              mrc.market, mrc.research_rank, mrc.research_state,
              mrc.primary_mechanism, mrc.secondary_mechanism,
              mrc.opportunity_evidence, mrc.starter_matchup_evidence,
              mrc.bullpen_path_evidence, mrc.park_evidence,
              mrc.recent_vs_season_vs_career, mrc.counter_evidence,
              mrc.missing_stale_evidence,
              mrc.created_at::text, mrc.updated_at::text
       FROM market_research_candidates mrc
       LEFT JOIN players p ON p.player_id = mrc.player_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY mrc.research_rank ASC NULLS LAST, mrc.research_state, player_name`,
      sqlParams,
    );

    const candidates = candidateResult.rows.map((row) => ({
      candidateId: row.candidate_id,
      slateDate: row.slate_date,
      gamePk: Number(row.game_pk),
      playerId: row.player_id,
      playerName: row.player_name,
      market: MARKET_DB_TO_SHORTCODE[row.market] ?? row.market,
      researchRank: row.research_rank,
      researchState: row.research_state,
      primaryMechanism: row.primary_mechanism,
      secondaryMechanism: row.secondary_mechanism,
      // Defensive sanitization: strip any prohibited keys from JSONB payloads
      // before they leave the API layer. Engines must also never write them.
      opportunityEvidence: stripProhibitedKeys(row.opportunity_evidence ?? {}),
      starterMatchupEvidence: stripProhibitedKeys(row.starter_matchup_evidence ?? {}),
      bullpenPathEvidence: stripProhibitedKeys(row.bullpen_path_evidence ?? {}),
      parkEvidence: stripProhibitedKeys(row.park_evidence ?? {}),
      recentVsSeasonVsCareer: stripProhibitedKeys(row.recent_vs_season_vs_career ?? {}),
      counterEvidence: stripProhibitedKeys(row.counter_evidence ?? {}),
      missingStaleEvidence: row.missing_stale_evidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    res.json(GetAnalystMarketResearchResponse.parse({
      date,
      market: marketParam,
      gameId,
      rankSemantics: RANK_DONT_GATE_SEMANTICS,
      prohibitedFields: PROHIBITED_FIELDS,
      candidates,
      candidateCount: candidates.length,
      systemNote: "Market engines 3A–3D populate this board. Candidates appear here once at least one engine has completed a research pass for this date.",
    }));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/market-research/tb", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const result = await runTBEngine(date);
    // Propagate engine-level failures as HTTP 500 so API clients can distinguish
    // a successful run (201) from a run that produced no usable output.
    if (result.error) {
      res.status(500).json(engineResponseDate(RefreshMarketResearchTBResponse.parse(result), date));
    } else {
      res.status(201).json(engineResponseDate(RefreshMarketResearchTBResponse.parse(result), date));
    }
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/market-research/xbh", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const result = await runXBHEngine(date);
    if (result.error) {
      res.status(500).json(engineResponseDate(RefreshMarketResearchXBHResponse.parse(result), date));
    } else {
      res.status(201).json(engineResponseDate(RefreshMarketResearchXBHResponse.parse(result), date));
    }
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/market-research/walk", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const result = await runWALKEngine(date);
    if (result.error) {
      res.status(500).json(engineResponseDate(RefreshMarketResearchWALKResponse.parse(result), date));
    } else {
      res.status(201).json(engineResponseDate(RefreshMarketResearchWALKResponse.parse(result), date));
    }
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/market-research/hr", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const result = await runHREngine(date);
    if (result.error) {
      res.status(500).json(engineResponseDate(RefreshMarketResearchHRResponse.parse(result), date));
    } else {
      res.status(201).json(engineResponseDate(RefreshMarketResearchHRResponse.parse(result), date));
    }
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

// ── Phase 4A – Historical Pregame Feature Store ──────────────────────────────

router.get("/analyst/feature-store", async (req, res, next) => {
  try {
    const playerId =
      req.query.playerId != null ? Number(req.query.playerId) : null;
    const market =
      typeof req.query.market === "string" && req.query.market.trim()
        ? req.query.market.trim().toUpperCase()
        : null;
    const dateFrom =
      typeof req.query.dateFrom === "string" && req.query.dateFrom.trim()
        ? req.query.dateFrom.trim()
        : null;
    const dateTo =
      typeof req.query.dateTo === "string" && req.query.dateTo.trim()
        ? req.query.dateTo.trim()
        : null;
    const limit =
      req.query.limit != null ? Math.min(Number(req.query.limit), 500) : 200;

    const result = await queryFeatureStore({ playerId, market, dateFrom, dateTo, limit });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/feature-store/capture", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const result = await captureSlateSnapshots(date);
    if (result.error) {
      res.status(500).json(result);
    } else {
      res.status(201).json(result);
    }
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/feature-store/backfill", async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dateFrom =
      typeof req.query.dateFrom === "string" && req.query.dateFrom.trim()
        ? req.query.dateFrom.trim()
        : today;
    const dateTo =
      typeof req.query.dateTo === "string" && req.query.dateTo.trim()
        ? req.query.dateTo.trim()
        : today;
    const result = await backfillHistoricalSnapshots(dateFrom, dateTo);
    if (result.error) {
      res.status(500).json(result);
    } else {
      res.status(201).json(result);
    }
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/feature-store/correct", async (req, res, next) => {
  try {
    // Corrections become immutable rows. Strict parsing rejects unrecognized
    // fields (including raw, odds, EV, CLV, and sportsbook payloads) instead
    // of silently discarding them.
    const parsed = CorrectFeatureStoreSnapshotBody.strict().safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, "Rejected invalid feature-store correction payload");
      res.status(400).json({ error: "Invalid correction payload: only documented feature-store fields are allowed" });
      return;
    }
    const { snapshotId, correctionReason, correctionNote } = parsed.data;
    const updatedFeatures = parsed.data.updatedFeatures == null
      ? null
      : {
          ...parsed.data.updatedFeatures,
          slateDate: dateOnly(parsed.data.updatedFeatures.slateDate),
        };

    const result = await correctSnapshot(
      snapshotId,
      correctionReason as import("../services/feature-store").CorrectionReason,
      correctionNote ?? null,
      updatedFeatures ?? null,
    );
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof FeatureStoreValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes("not found")) {
      res.status(404).json({ error: error.message });
    } else {
      next(error);
    }
  }
});

router.post("/analyst/feature-store/outcome", async (req, res, next) => {
  try {
    // Outcomes contain official baseball-stat fields only. Strict parsing
    // rejects arbitrary raw objects and all undeclared betting-derived fields.
    const parsed = WriteFeatureStoreOutcomeBody.strict().safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, "Rejected invalid feature-store outcome payload");
      res.status(400).json({ error: "Invalid outcome payload: only documented official-stat fields are allowed" });
      return;
    }
    const body = parsed.data;
    const market = body.market;

    const outcomeId = await writeHistoricalOutcome({
      playerId: body.playerId,
      gamePk: body.gamePk,
      slateDate: dateOnly(body.slateDate),
      market,
      singles: body.singles ?? 0,
      doubles: body.doubles ?? 0,
      triples: body.triples ?? 0,
      homeRuns: body.homeRuns ?? 0,
      walks: body.walks ?? 0,
      plateAppearances: body.plateAppearances ?? 0,
      atBats: body.atBats ?? 0,
      sourceId: body.sourceId,
      ingestRunId: body.ingestRunId ?? null,
    });

    // Compute outcome values for the response
    const s = body.singles ?? 0;
    const d = body.doubles ?? 0;
    const t = body.triples ?? 0;
    const hr = body.homeRuns ?? 0;
    const w = body.walks ?? 0;
    const outcomeValue =
      market === "TB"   ? s + d * 2 + t * 3 + hr * 4 :
      market === "XBH"  ? d + t + hr :
      market === "WALK" ? w : hr;
    const outcomeHit =
      market === "TB"   ? (s + d * 2 + t * 3 + hr * 4) >= 2 :
      market === "XBH"  ? (d + t + hr) >= 1 :
      market === "WALK" ? w >= 1 : hr >= 1;

    res.status(201).json({ outcomeId, outcomeValue, outcomeHit });
  } catch (error) {
    if (error instanceof FeatureStoreValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

function queryPositiveInteger(value: unknown, name: string) {
  if (value === undefined || value === "") return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new SettlementValidationError(`${name} must be a positive integer`);
  return result;
}

function requestedSettlementDate(value: unknown) {
  try {
    const valueDate = requestedDate(value);
    const parsed = new Date(`${valueDate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== valueDate) {
      throw new Error("date must be a real calendar date using YYYY-MM-DD");
    }
    return valueDate;
  } catch (error) {
    throw new SettlementValidationError(error instanceof Error ? error.message : "date must use YYYY-MM-DD");
  }
}

function strictPostmortemBody(body: unknown) {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const keys = Object.keys(value);
  if (keys.some((key) => !["snapshotId", "outcomeId", "notes"].includes(key))) {
    throw new SettlementValidationError("Postmortem payload contains unsupported fields");
  }
  if (typeof value.snapshotId !== "string" || typeof value.outcomeId !== "string") {
    throw new SettlementValidationError("snapshotId and outcomeId are required");
  }
  if (value.notes != null && typeof value.notes !== "string") {
    throw new SettlementValidationError("notes must be a string or null");
  }
  return { snapshotId: value.snapshotId, outcomeId: value.outcomeId, notes: value.notes as string | null | undefined };
}

const refreshOfficialSettlement: RequestHandler = async (req, res, next) => {
  try {
    res.status(201).json(await settleOfficialDate(requestedSettlementDate(req.query.date)));
  } catch (error) {
    if (error instanceof SettlementValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
};

router.post("/analyst/settlement/refresh", refreshOfficialSettlement);
router.post("/analyst/settlements/ingest", refreshOfficialSettlement);

router.post("/analyst/settlements/:gamePk", async (req, res, next) => {
  try {
    res.status(201).json(await settleOfficialGame(req.params.gamePk));
  } catch (error) {
    if (error instanceof SettlementValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/analyst/settlements", async (req, res, next) => {
  try {
    const market = typeof req.query.market === "string" ? req.query.market.toUpperCase() : null;
    if (market && !["TB", "XBH", "WALK", "HR"].includes(market)) {
      throw new SettlementValidationError("market must be TB, XBH, WALK, or HR");
    }
    const results = await querySettlements({
      gamePk: queryPositiveInteger(req.query.gamePk, "gamePk"),
      playerId: queryPositiveInteger(req.query.playerId, "playerId"),
      market,
      dateFrom: req.query.dateFrom ? requestedDate(req.query.dateFrom) : null,
      dateTo: req.query.dateTo ? requestedDate(req.query.dateTo) : null,
    });
    res.json({
      source: "MLB Official",
      settlements: results,
      total: results.length,
      systemNote: "Settlement rows are MLB-official only, append-only, and contain no betting data.",
    });
  } catch (error) {
    if (error instanceof SettlementValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.post("/analyst/postmortems", async (req, res, next) => {
  try {
    const result = await createMarketPostmortem(strictPostmortemBody(req.body));
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof SettlementValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/analyst/postmortems", async (req, res, next) => {
  try {
    const market = typeof req.query.market === "string" ? req.query.market.toUpperCase() : null;
    if (market && !["TB", "XBH", "WALK", "HR"].includes(market)) {
      throw new SettlementValidationError("market must be TB, XBH, WALK, or HR");
    }
    const results = await queryMarketPostmortems({
      playerId: queryPositiveInteger(req.query.playerId, "playerId"),
      market,
    });
    res.json({ postmortems: results, total: results.length });
  } catch (error) {
    if (error instanceof SettlementValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

function requestedModelMarket(value: unknown): ModelMarket {
  const market = typeof value === "string" ? value.toUpperCase() : "";
  if (!MODEL_MARKETS.includes(market as ModelMarket)) {
    throw new ModelTrainingValidationError("market must be TB, XBH, WALK, or HR");
  }
  return market as ModelMarket;
}

function requestedBoardMarket(value: unknown): BoardMarket | null {
  if (value == null || value === "") return null;
  const market = String(value).trim().toUpperCase();
  if (!MODEL_MARKETS.includes(market as ModelMarket)) {
    throw new DailyMarketBoardValidationError("market must be TB, XBH, WALK, or HR");
  }
  return market as BoardMarket;
}

router.post("/analyst/models/train", async (req, res, next) => {
  try {
    const result = await trainMarketModel(requestedModelMarket(req.query.market));
    res.status(201).json(TrainAnalystModelResponse.parse(result));
  } catch (error) {
    if (error instanceof ModelTrainingValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/analyst/models", async (req, res, next) => {
  try {
    const market = req.query.market == null ? null : requestedModelMarket(req.query.market);
    const versions = await queryModelVersions(market);
    res.json(GetAnalystModelsResponse.parse({ versions, total: versions.length }));
  } catch (error) {
    if (error instanceof ModelTrainingValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.post("/analyst/models/validate", async (req, res, next) => {
  try {
    const modelVersionId = typeof req.query.modelVersionId === "string"
      ? req.query.modelVersionId.trim()
      : "";
    if (!modelVersionId) throw new WalkForwardValidationError("modelVersionId is required");
    const result = await validateModelVersion(modelVersionId);
    res.status(201).json(ValidateAnalystModelResponse.parse(result));
  } catch (error) {
    if (error instanceof WalkForwardValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/analyst/models/validation", async (req, res, next) => {
  try {
    const market = req.query.market == null ? null : requestedModelMarket(req.query.market);
    const runs = await queryWalkForwardRuns(market);
    res.json(GetAnalystModelValidationResponse.parse({ runs, total: runs.length }));
  } catch (error) {
    if (error instanceof WalkForwardValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.post("/analyst/market-board/refresh", async (req, res, next) => {
  try {
    const result = await populateDailyMarketBoard(
      requestedBoardDate(req.query.date),
      requestedBoardMarket(req.query.market),
    );
    res.status(201).json(RefreshAnalystDailyMarketBoardResponse.parse(result));
  } catch (error) {
    if (error instanceof DailyMarketBoardValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/analyst/market-board", async (req, res, next) => {
  try {
    const date = requestedBoardDate(req.query.date);
    const market = requestedBoardMarket(req.query.market);
    const entries = await queryDailyMarketBoard(date, market);
    res.json(GetAnalystDailyMarketBoardResponse.parse({
      date,
      market,
      entries,
      total: entries.length,
      notes: [
        "Confidence and calibrated probability are computed server-side from frozen snapshots and verified ACTIVE artifacts.",
        "FIRE requires STRONG research and a calibrated probability of at least 0.65. No ACTIVE calibrated model yields NONE / RESEARCH_ONLY.",
        "No odds, prices, EV, CLV, or related betting fields are included.",
      ],
    }));
  } catch (error) {
    if (error instanceof DailyMarketBoardValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/analyst/market-board/game-summary", async (req, res, next) => {
  try {
    const date = requestedBoardDate(req.query.date);
    const games = await queryDailyBoardGameSummary(date);
    res.json(GetAnalystDailyBoardGameSummaryResponse.parse({ date, games, total: games.length }));
  } catch (error) {
    if (error instanceof DailyMarketBoardValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

// ── Phase 7A – Bettor Intelligence Ingestion and Lineage ──────────────────────

function requestedBettorMarket(value: unknown): BettorMarket | null {
  if (value == null || value === "") return null;
  const market = String(value).trim().toUpperCase();
  if (!BETTOR_MARKETS.includes(market as BettorMarket)) {
    throw new BettorIntelligenceValidationError("market must be TB, XBH, WALK, or HR");
  }
  return market as BettorMarket;
}

function bettorErrorResponse(
  error: unknown,
  res: Parameters<RequestHandler>[1],
) {
  if (error instanceof BettorIntelligenceConflictError) {
    res.status(409).json({ error: error.message });
    return true;
  }
  if (error instanceof BettorIntelligenceValidationError) {
    res.status(400).json({ error: error.message });
    return true;
  }
  return false;
}

router.get("/analyst/bettor/sources", async (_req, res, next) => {
  try {
    const sources = await queryBettorSources();
    res.json(GetAnalystBettorSourcesResponse.parse({ sources, total: sources.length }));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/bettor/sources", async (req, res, next) => {
  try {
    const parsed = CreateAnalystBettorSourceBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, "Rejected invalid bettor source payload");
      res.status(400).json({ error: "Invalid bettor source payload" });
      return;
    }
    const source = await createBettorSource(parsed.data);
    res.status(201).json(CreateAnalystBettorSourceResponse.parse(source));
  } catch (error) {
    if (bettorErrorResponse(error, res)) return;
    next(error);
  }
});

router.patch("/analyst/bettor/sources/:sourceId", async (req, res, next) => {
  try {
    const params = UpdateAnalystBettorSourceParams.safeParse(req.params);
    const body = UpdateAnalystBettorSourceBody.safeParse(req.body);
    if (!params.success || !body.success || Object.keys(body.success ? body.data : {}).length === 0) {
      req.log.warn({ paramIssues: params.success ? null : params.error.issues, bodyIssues: body.success ? null : body.error.issues }, "Rejected invalid bettor source update");
      res.status(400).json({ error: "Invalid bettor source update payload" });
      return;
    }
    const source = await updateBettorSource(params.data.sourceId, body.data);
    res.json(UpdateAnalystBettorSourceResponse.parse(source));
  } catch (error) {
    if (bettorErrorResponse(error, res)) return;
    next(error);
  }
});

router.delete("/analyst/bettor/sources/:sourceId", async (req, res, next) => {
  try {
    const params = DeleteAnalystBettorSourceParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "sourceId must be a UUID" });
      return;
    }
    const result = await deleteBettorSource(params.data.sourceId);
    res.json(DeleteAnalystBettorSourceResponse.parse(result));
  } catch (error) {
    if (bettorErrorResponse(error, res)) return;
    next(error);
  }
});

router.post("/analyst/bettor/ingest", async (req, res, next) => {
  try {
    // Validate the uncoerced request value first. z.coerce.date intentionally
    // accepts JavaScript-normalized dates (such as February 30), which must not
    // silently move a source pick onto a different slate.
    const slateDate = requestedBettorDate(
      req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>).slateDate : undefined,
    );
    const parsed = IngestAnalystBettorPickBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, "Rejected invalid bettor pick payload");
      res.status(400).json({ error: "Invalid bettor pick payload: use documented baseball evidence fields only" });
      return;
    }
    const result = await ingestBettorPick({
      ...parsed.data,
      slateDate,
      postedAt: parsed.data.postedAt.toISOString(),
    });
    res.status(201).json(IngestAnalystBettorPickResponse.parse(result));
  } catch (error) {
    if (bettorErrorResponse(error, res)) return;
    next(error);
  }
});

router.get("/analyst/bettor/picks", async (req, res, next) => {
  try {
    const date = requestedBettorDate(req.query.date);
    const market = requestedBettorMarket(req.query.market);
    const picks = await queryBettorPicks({ date, market });
    res.json(GetAnalystBettorPicksResponse.parse({ date, market, picks, total: picks.length }));
  } catch (error) {
    if (bettorErrorResponse(error, res)) return;
    next(error);
  }
});

// ── Phase 7B – Bettor Evaluation (read-only observational data) ─────────────

router.get("/analyst/bettor/evaluation", async (req, res, next) => {
  try {
    const params = GetAnalystBettorEvaluationQueryParams.safeParse(req.query);
    if (!params.success) {
      req.log.warn({ issues: params.error.issues }, "Rejected invalid bettor evaluation query");
      res.status(400).json({ error: "sourceId must be a UUID and market must be TB, XBH, WALK, or HR" });
      return;
    }
    const market = requestedBettorMarket(params.data.market);
    const evaluation = await queryBettorEvaluation({
      sourceId: params.data.sourceId ?? null,
      market,
    });
    res.json(GetAnalystBettorEvaluationResponse.parse(evaluation));
  } catch (error) {
    if (bettorErrorResponse(error, res)) return;
    next(error);
  }
});

// ── Phase 8A – AI Analyst read-only tool gateway ────────────────────────────

router.get("/analyst/ai/tool-registry", async (_req, res, next) => {
  try {
    const tools = await queryAiToolRegistry();
    res.json(GetAnalystAiToolRegistryResponse.parse({ tools, total: tools.length }));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/ai/tool-call", async (req, res, next) => {
  try {
    const parsed = CallAnalystAiToolBody.safeParse(req.body);
    if (!parsed.success) {
      const raw = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
      const result = await rejectAiToolCall(
        {
          toolName: typeof raw.toolName === "string" ? raw.toolName.slice(0, 100) : "INVALID_TOOL_CALL",
          parameters: raw.parameters && typeof raw.parameters === "object" && !Array.isArray(raw.parameters)
            ? raw.parameters as Record<string, unknown>
            : {},
          sessionId: typeof raw.sessionId === "string" && raw.sessionId.trim()
            ? raw.sessionId.slice(0, 160)
            : "invalid-request",
          requestId: String(req.id),
        },
        "Invalid AI tool-call payload: toolName, parameters, and sessionId are required.",
      );
      res.status(400).json(CallAnalystAiToolResponse.parse(result));
      return;
    }
    const result = await executeAiToolCall({ ...parsed.data, requestId: String(req.id) });
    const response = CallAnalystAiToolResponse.parse(result);
    res.status(result.status === "SUCCESS" ? 200 : result.status === "REJECTED" ? 400 : 502).json(response);
  } catch (error) {
    next(error);
  }
});

export default router;