/**
 * Shared declarations for the analyst routers.
 *
 * Remediation task 5.2 split routes/analyst.ts, which was 2,405 lines and 70
 * routes in one file, past the read limit of standard tooling and therefore the
 * largest unreviewed surface in the application.
 *
 * This is a PURE MOVE. Every declaration below is the one that was previously
 * in that file, with `export` prefixed and nothing else changed. It is declared
 * here exactly once; the domain modules import what they use.
 */
import { Router, type IRouter, type RequestHandler } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
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
  GetAnalystBatterPitcherResponse,
  RefreshAnalystBatterPitcherResponse,
  GetAnalystRoundRobinComparisonResponse,
  RefreshBullpenResponse,
  RefreshMarketResearchTBResponse,
  RefreshMarketResearchXBHResponse,
  RefreshMarketResearchWALKResponse,
  RefreshMarketResearchHRResponse,
  WriteFeatureStoreOutcomeBody,
  TrainAnalystModelResponse,
  DemoteAnalystModelBody,
  DemoteAnalystModelResponse,
  GetAnalystModelsResponse,
  PromoteAnalystModelResponse,
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
  ChatWithAnalystAiBody,
  ChatWithAnalystAiResponse,
  GetAnalystAiDraftsQueryParams,
  GetAnalystAiDraftsResponse,
  CreateAnalystAiDraftBody,
  CreateAnalystAiDraftResponse,
  ApproveAnalystAiDraftParams,
  ApproveAnalystAiDraftBody,
  ApproveAnalystAiDraftResponse,
  RejectAnalystAiDraftParams,
  RejectAnalystAiDraftBody,
  RejectAnalystAiDraftResponse,
  GetAnalystAiSourcingRegisterQueryParams,
  GetAnalystAiSourcingRegisterResponse,
  DecideAnalystAiSourcingClaimParams,
  DecideAnalystAiSourcingClaimBody,
  DecideAnalystAiSourcingClaimResponse,
  GetAnalystAiResearchNotesQueryParams,
  GetAnalystAiResearchNotesResponse,
  getMarketResearchSelectionEligibility,
} from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { ingestFantasyPros, ingestMlbOfficial } from "../../services/data-foundation";
import { getPitcherLab, getPlayerLab, ingestResearch, ingestStatcastHandednessFallback, researchHealth } from "../../services/research-foundation";
import { getBatterPitcherEvidence, refreshBatterPitcherSlate, type BvpMarket } from "../../services/batter-pitcher-research";
import { compareRoundRobinGame, type RoundRobinBoardId, type RoundRobinCandidate } from "../../services/round-robin-comparison";
import { LINEUP_SOURCE_PRECEDENCE, lineupSourceFilter } from "../../services/lineup-sources";
import { RR_DB_TO_MARKET, RR_MARKET_TO_DB } from "../../services/market-codes";
import { getBullpenRoom, refreshBullpen } from "../../services/bullpen-foundation";
import { runTBEngine } from "../../services/tb-engine";
import { runXBHEngine } from "../../services/xbh-engine";
import { runWALKEngine } from "../../services/walk-engine";
import { runHREngine } from "../../services/hr-engine";
import {
  backfillHistoricalSnapshots,
  captureSlateSnapshots,
  correctSnapshot,
  FeatureStoreValidationError,
  queryFeatureStore,
  writeHistoricalOutcome,
} from "../../services/feature-store";
import {
  createMarketPostmortem,
  queryMarketPostmortems,
  querySettlements,
  settleOfficialDate,
  settleOfficialGame,
  SettlementValidationError,
} from "../../services/settlement";
import {
  MODEL_MARKETS,
  ModelTrainingValidationError,
  queryModelVersions,
  trainMarketModel,
  type ModelMarket,
} from "../../services/model-training";
import {
  queryWalkForwardRuns,
  validateModelVersion,
  WalkForwardValidationError,
} from "../../services/walk-forward-validation";
import {
  demoteModelVersion,
  ModelPromotionError,
  promoteModelVersion,
} from "../../services/model-promotion";
import {
  DailyMarketBoardValidationError,
  type BoardMarket,
  populateDailyMarketBoard,
  queryDailyBoardGameSummary,
  queryDailyMarketBoard,
} from "../../services/daily-market-board";
import {
  automateSettlementDate,
  detectLateScratches,
  interruptOrchestrationRun,
  launchOrchestrationRun,
  queryOrchestrationRuns,
} from "../../services/orchestration";
import { buildSlateExport, buildWorkbookExport } from "../../services/exports";
import { queryAuditEvents } from "../../services/audit";
import { CACHE_POLICY, invalidateCache, readThroughCache } from "../../services/cache";
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
} from "../../services/bettor-intelligence";
import { executeAiToolCall, queryAiToolRegistry, rejectAiToolCall } from "../../services/ai-tool-gateway";
import {
  AiWorkflowValidationError,
  createAiResearchDraft,
  decideAiSourcingClaim,
  queryAiResearchDrafts,
  queryAiSourcingRegister,
  queryResearchNotes,
  reviewAiResearchDraft,
  runAiAnalystChat,
} from "../../services/ai-workflows";

/**
 * Accepted (source, state) pairs for the Round Robin lineup read, in precedence
 * order. array_position over sourceIds gives the query the same ordering the
 * shared resolver applies.
 */
export const ROUND_ROBIN_LINEUP_FILTER = lineupSourceFilter(LINEUP_SOURCE_PRECEDENCE);

export const fantasyProsConfigured = Boolean(process.env.FANTASYPROS_API_KEY);

export function currentEasternDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export type OperationalReadiness = {
  currentDate: string;
  requestedDate: string;
  isCurrentDate: boolean;
  status: "READY" | "PARTIAL" | "BLOCKED" | "AUDIT_ONLY";
  usable: boolean;
  reason: string;
  reasons: string[];
  observedAt: string;
};

export class AnalystRequestValidationError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_DATE" | "INVALID_PLAYER_ID" | "INVALID_SEARCH" | "INVALID_WINDOW",
  ) {
    super(message);
    this.name = "AnalystRequestValidationError";
  }
}

function invalidQueryValue(value: unknown) {
  return value === null
    || Array.isArray(value)
    || (typeof value === "string" && ["null", "undefined"].includes(value.trim().toLowerCase()));
}

function isCalendarDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function requestedDate(value: unknown) {
  if (value !== undefined && invalidQueryValue(value)) {
    throw new AnalystRequestValidationError("date must use a real YYYY-MM-DD calendar date", "INVALID_DATE");
  }
  const date = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : typeof value === "string"
      ? value
      : currentEasternDate();
  if (!isCalendarDate(date)) {
    throw new AnalystRequestValidationError("date must use a real YYYY-MM-DD calendar date", "INVALID_DATE");
  }
  return date;
}

export function requiredDate(value: unknown) {
  if (value == null || value === "") throw new Error("date is required");
  return requestedDate(value);
}

export function requestedBoardDate(value: unknown) {
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

export function requestedBettorDate(value: unknown) {
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

export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function engineResponseDate<T extends { slateDate: Date }>(response: T, slateDate: string) {
  return { ...response, slateDate };
}

export function requestedWindow(value: unknown) {
  if (value !== undefined && invalidQueryValue(value)) {
    throw new AnalystRequestValidationError("window must be SEASON, CAREER, ROLLING_7, ROLLING_14, ROLLING_30, or ROLLING_60", "INVALID_WINDOW");
  }
  const window = typeof value === "string" ? value : "SEASON";
  if (!["SEASON", "CAREER", "ROLLING_7", "ROLLING_14", "ROLLING_30", "ROLLING_60"].includes(window)) {
    throw new AnalystRequestValidationError("window must be SEASON, CAREER, ROLLING_7, ROLLING_14, ROLLING_30, or ROLLING_60", "INVALID_WINDOW");
  }
  return window as "SEASON" | "CAREER" | "ROLLING_7" | "ROLLING_14" | "ROLLING_30" | "ROLLING_60";
}

export function requestedPlayerId(value: unknown) {
  if (value === undefined) return null;
  if (invalidQueryValue(value) || (typeof value !== "string" && typeof value !== "number")) {
    throw new AnalystRequestValidationError("playerId must be a positive integer", "INVALID_PLAYER_ID");
  }
  const playerId = Number(value);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) {
    throw new AnalystRequestValidationError("playerId must be a positive integer", "INVALID_PLAYER_ID");
  }
  return playerId;
}

export function requestedLabSearch(value: unknown) {
  if (value === undefined || value === "") return "";
  if (invalidQueryValue(value) || typeof value !== "string") {
    throw new AnalystRequestValidationError("search must be plain text, not a null-like value", "INVALID_SEARCH");
  }
  const search = value.trim();
  if (search.length > 120) {
    throw new AnalystRequestValidationError("search must contain at most 120 characters", "INVALID_SEARCH");
  }
  return search;
}

export function displayTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(value))
    : "TBD";
}

export function isoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function sourceBadges(effectiveDate: string) {
  const runs = await pool.query<{
    source_id: string;
    status: string;
    effective_date: Date;
    finished_at: string | null;
    row_count: number | null;
    normalized_row_count: number | null;
    rejected_row_count: number | null;
     http_status: number | null;
     duration_ms: number | null;
    error_message: string | null;
  }>(
    `SELECT DISTINCT ON (source_id) source_id, status, effective_date, finished_at, row_count, normalized_row_count, rejected_row_count, http_status, duration_ms, error_message
     FROM ingest_runs
     WHERE source_id IN ('MLB_OFFICIAL', 'FANTASYPROS', 'STATCAST', 'FANGRAPHS', 'PARK_FACTORS', 'OPEN_METEO')
       AND effective_date <= $1
     ORDER BY source_id, effective_date DESC, started_at DESC`,
    [effectiveDate],
  );
  const bySource = new Map(runs.rows.map((row) => [row.source_id, row]));
  const makeRunBadge = (name: string, run: {
    status: string; effective_date: Date; finished_at: string | null; row_count: number | null; normalized_row_count: number | null;
    rejected_row_count: number | null; http_status: number | null; duration_ms: number | null; error_message: string | null;
  } | undefined, configured = true) => {
    if (!configured) return {
      name, status: "NOT CONFIGURED", freshness: "Credential missing", lastSuccess: null, rowCount: 0,
      detail: "A server-side credential is required.", effectiveDate: null, ageMinutes: null, isCurrentDate: false,
    };
    if (!run) return {
      name, status: "NOT RUN", freshness: "No successful ingest", lastSuccess: null, rowCount: 0,
      detail: "No ingestion run has completed.", effectiveDate: null, ageMinutes: null, isCurrentDate: false,
    };
    const runDate = dateOnly(run.effective_date);
    const isCurrentDate = runDate === effectiveDate;
    const status = !isCurrentDate ? "STALE" : run.status === "SUCCESS" ? "FRESH" : run.status === "PARTIAL" ? "PARTIAL" : "BLOCKED";
    const ageMinutes = run.finished_at
      ? Math.max(0, Math.floor((Date.now() - new Date(run.finished_at).getTime()) / 60_000))
      : null;
    const runDetail = run.error_message
      ? run.error_message
      : `${run.normalized_row_count ?? 0} normalized · ${run.rejected_row_count ?? 0} rejected${run.http_status ? ` · HTTP ${run.http_status}` : ""}${run.duration_ms ? ` · ${run.duration_ms}ms` : ""}`;
    return {
      name,
      status,
      freshness: !isCurrentDate
        ? `Latest effective date ${runDate}`
        : run.finished_at ? `Last attempt ${new Date(run.finished_at).toLocaleString("en-US", { timeZone: "America/New_York" })}` : "In progress",
      lastSuccess: run.status === "SUCCESS" || run.status === "PARTIAL" ? isoString(run.finished_at) : null,
      rowCount: run.row_count ?? 0,
      detail: isCurrentDate ? runDetail : `No ${effectiveDate} run. ${runDetail}`,
      effectiveDate: runDate,
      ageMinutes,
      isCurrentDate,
    };
  };
  const splitRun = await pool.query<{
    status: string; effective_date: Date; finished_at: string | null; row_count: number | null; normalized_row_count: number | null;
    rejected_row_count: number | null; http_status: number | null; duration_ms: number | null; error_message: string | null;
  }>(
    `SELECT status, effective_date, finished_at, row_count, normalized_row_count, rejected_row_count, http_status, duration_ms, error_message
     FROM ingest_runs WHERE source_id = 'STATCAST' AND job_name = 'statcast_search_handedness_fallback'
       AND effective_date <= $1
     ORDER BY effective_date DESC, started_at DESC LIMIT 1`,
    [effectiveDate],
  );
  const makeBadge = (sourceId: string, name: string, configured: boolean) => makeRunBadge(name, bySource.get(sourceId), configured);
  return [
    makeBadge("MLB_OFFICIAL", "MLB Official", true),
    makeBadge("FANTASYPROS", "FantasyPros", fantasyProsConfigured),
    makeBadge("STATCAST", "Baseball Savant / Statcast", true),
    makeRunBadge("Statcast Search splits", splitRun.rows[0]),
    makeBadge("FANGRAPHS", "FanGraphs", true),
    makeBadge("PARK_FACTORS", "Statcast Park Factors", true),
    makeBadge("OPEN_METEO", "Weather", true),
  ];
}

export async function identityCoverage(date: string) {
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

export async function analystDataHealth(date: string) {
  const [sources, issueResult, lastRun, coverage, research, slate, workflow, bullpen, marketCandidates, weatherRefresh] = await Promise.all([
    sourceBadges(date),
    pool.query<{ issue_type: string; detail: string; severity: string }>(
      `SELECT ii.issue_type, ii.detail, ii.severity
       FROM ingest_issues ii JOIN ingest_runs ir ON ir.ingest_run_id = ii.ingest_run_id
       WHERE ii.resolved_at IS NULL AND ir.effective_date = $1
       UNION ALL
       SELECT 'IDENTITY_REVIEW' AS issue_type, CONCAT(raw_name, ' (FantasyPros ID ', external_player_id, ') requires review') AS detail, 'REVIEW' AS severity
       FROM identity_review_queue WHERE state = 'OPEN'
       ORDER BY issue_type LIMIT 50`,
      [date],
    ),
    pool.query<{ finished_at: string | null }>("SELECT max(finished_at) AS finished_at FROM ingest_runs WHERE effective_date = $1", [date]),
    identityCoverage(date),
    researchHealth(date),
    pool.query<{ games: number }>("SELECT count(*)::int AS games FROM games WHERE game_date = $1", [date]),
    pool.query<{ overall_status: "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED" | "CANCELLED"; error_message: string | null }>(
      `SELECT overall_status, error_message FROM orchestration_runs
       WHERE run_date = $1 ORDER BY created_at DESC LIMIT 1`,
      [date],
    ),
    pool.query<{ status: string; row_count: number | null }>(
      `SELECT status, row_count FROM ingest_runs WHERE source_id = 'BULLPEN' AND effective_date = $1
       ORDER BY started_at DESC LIMIT 1`,
      [date],
    ),
    pool.query<{ candidates: number }>(
      "SELECT count(*)::int AS candidates FROM market_research_candidates WHERE slate_date = $1",
      [date],
    ),
    pool.query<{
      ingest_run_id: string;
      status: "SUCCESS" | "PARTIAL" | "FAILED" | "RUNNING";
      effective_date: Date;
      started_at: string;
      finished_at: string | null;
      row_count: number | null;
      normalized_row_count: number | null;
      rejected_row_count: number | null;
      error_message: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT ingest_run_id, status, effective_date, started_at::text, finished_at::text,
              row_count, normalized_row_count, rejected_row_count, error_message, metadata
         FROM ingest_runs
        WHERE source_id = 'OPEN_METEO' AND job_name = 'weather_refresh' AND effective_date = $1
        ORDER BY started_at DESC LIMIT 1`,
      [date],
    ),
  ]);
  const currentDate = currentEasternDate();
  const fantasyProsSource = sources.find((source) => source.name === "FantasyPros");
  const baselineReady = Boolean(slate.rows[0]?.games) && Boolean(marketCandidates.rows[0]?.candidates);
  const phaseTwoReady = research.handednessCoverageScope === "FULL_ELIGIBLE_HITTER_AND_PITCHER_UNIVERSE"
    && research.handednessIngestStatus === "SUCCESS"
    && research.missingHandednessSplits === 0
    && research.handednessTargetPlayers === research.handednessCoveredPlayers
    && research.parkRequiredVenues > 0
    && research.parkVenueCoverageGaps === 0
    && research.hitterProfilesMissingEvidence === 0
    && research.pitcherProfilesMissingEvidence === 0;
  const workflowRun = workflow.rows[0];
  const optionalEnrichmentReady = phaseTwoReady && bullpen.rows[0]?.status === "SUCCESS";
  const slateState = !slate.rows[0]?.games
    ? fantasyProsSource?.status === "BLOCKED" || fantasyProsSource?.status === "PARTIAL" ? "FAILED_SOURCE" : "NO_INGEST_RUN"
    : baselineReady ? "POPULATED" : "MISSING_DOWNSTREAM_STAGE";
  const blockingReasons = [
    ...(slate.rows[0]?.games ? [] : [`No FantasyPros matchup records are available for ${date}.`]),
    ...(marketCandidates.rows[0]?.candidates ? [] : [`No FantasyPros baseline candidates were produced for ${date}.`]),
    ...(coverage.unresolvedActivePlayers || coverage.blockingProjectedLineupIssues
      ? [`${coverage.unresolvedActivePlayers + coverage.blockingProjectedLineupIssues} unresolved or blocking identity record(s) remain.`]
      : []),
    ...(workflowRun && ["FAILED", "CANCELLED"].includes(workflowRun.overall_status)
      ? [`The latest workflow is ${workflowRun.overall_status.toLowerCase()}${workflowRun.error_message ? `: ${workflowRun.error_message}` : "."}`]
      : []),
  ];
  const partialReasons = [
    ...(optionalEnrichmentReady ? [] : ["Optional enrichment is still running or incomplete; baseline ordinal ranks remain available."]),
    ...(workflowRun && ["RUNNING", "PARTIAL"].includes(workflowRun.overall_status)
      ? [`The latest workflow is ${workflowRun.overall_status.toLowerCase()}; outputs are not operational until it completes.`]
      : []),
  ];
  const isCurrentDate = date === currentDate;
  const status: OperationalReadiness["status"] = !isCurrentDate
    ? "AUDIT_ONLY"
    : blockingReasons.length ? "BLOCKED"
      : partialReasons.length ? "PARTIAL"
        : "READY";
  const reasons = !isCurrentDate
    ? [`${date} is not the current Eastern slate date (${currentDate}); this is an audit-only view.`]
    : [...blockingReasons, ...partialReasons];
  const readiness: OperationalReadiness = {
    currentDate,
    requestedDate: date,
    isCurrentDate,
    status,
    usable: status === "READY",
    reason: reasons[0] ?? "All required current-date source, identity, research, and workflow checks passed.",
    reasons,
    observedAt: new Date().toISOString(),
  };
  const readinessIssues = [
    ...(slate.rows[0]?.games ? [] : [{ label: "FANTASYPROS SLATE MISSING", detail: `No FantasyPros matchup records are available for ${date}.`, severity: "CRITICAL" }]),
    ...(marketCandidates.rows[0]?.candidates ? [] : [{ label: "BASELINE STAGE MISSING", detail: `No FantasyPros baseline candidates were produced for ${date}.`, severity: "CRITICAL" }]),
    ...(coverage.unresolvedActivePlayers || coverage.blockingProjectedLineupIssues
      ? [{ label: "CURRENT IDENTITY UNRESOLVED", detail: `${coverage.unresolvedActivePlayers + coverage.blockingProjectedLineupIssues} active identity record(s) are unresolved or blocking.`, severity: "CRITICAL" }]
      : []),
    ...(workflowRun && ["FAILED", "CANCELLED"].includes(workflowRun.overall_status)
      ? [{ label: "CURRENT WORKFLOW BLOCKED", detail: readiness.reason, severity: "CRITICAL" }]
      : []),
  ];
  return {
    selectedDate: date,
    timezone: "America/New_York",
    slateState,
    overall: readiness.status,
    phase2aReady: baselineReady,
    readinessDiagnostics: [
      { code: "FANTASYPROS_SLATE", label: "FantasyPros projected slate", status: slate.rows[0]?.games ? "READY" : "BLOCKED", detail: slate.rows[0]?.games ? `${slate.rows[0].games} FantasyPros game(s) are available for ${date}.` : `No FantasyPros matchup records are available for ${date}.` },
      { code: "BASELINE", label: "FantasyPros baseline ranks", status: baselineReady ? "READY" : "BLOCKED", detail: baselineReady ? `${marketCandidates.rows[0]?.candidates ?? 0} independent market baseline candidate(s) are available.` : `No baseline candidates were produced for ${date}.` },
      { code: "OPTIONAL_RESEARCH", label: "Optional research enrichment", status: optionalEnrichmentReady ? "READY" : "BLOCKED", detail: optionalEnrichmentReady ? "Current role paths and research coverage are available." : "Enrichment remains non-blocking and is still incomplete." },
    ],
    readiness,
    sources,
    issues: [
      ...readinessIssues,
      ...issueResult.rows.map((issue) => ({ label: issue.issue_type.replaceAll("_", " "), detail: issue.detail, severity: issue.severity })),
    ],
    identityCoverage: coverage,
    researchHealth: research,
    lastRun: isoString(lastRun.rows[0]?.finished_at) ?? "No completed ingestion runs recorded",
    weatherRefresh: weatherRefresh.rows[0]
      ? {
        ingestRunId: weatherRefresh.rows[0].ingest_run_id,
        status: weatherRefresh.rows[0].status,
        slateDate: dateOnly(weatherRefresh.rows[0].effective_date),
        startedAt: weatherRefresh.rows[0].started_at,
        finishedAt: weatherRefresh.rows[0].finished_at,
        gamesFound: weatherRefresh.rows[0].row_count ?? 0,
        observationsWritten: weatherRefresh.rows[0].normalized_row_count ?? 0,
        failures: weatherRefresh.rows[0].rejected_row_count ?? 0,
        error: weatherRefresh.rows[0].error_message,
      }
      : null,
  };
}

// ─── Phase 3 – Market Research Contract ──────────────────────────────────────

/**
 * Maps API short-code market identifiers to the DB enum values stored in
 * market_research_candidates.market (marketTypeEnum).
 * Engines 3A–3D write using the DB enum; the API exposes short codes.
 */
// The vocabulary lives in market-codes.ts. These aliases keep the existing call
// sites readable without a second copy of the mapping in this file.
export const MARKET_SHORTCODE_TO_DB: Record<string, string> = RR_MARKET_TO_DB;
export const MARKET_DB_TO_SHORTCODE: Record<string, string> = RR_DB_TO_MARKET;

export const RANK_DONT_GATE_SEMANTICS =
  "RANK_DONT_GATE: research_rank is an ordinal integer only; " +
  "1 = highest-ranked candidate for this market+date. " +
  "Ties share the same integer value and are never collapsed. " +
  "No state value removes a candidate from the board. " +
  "This rank implies no threshold, gate, probability, or recommendation.";

export const PROHIBITED_FIELDS = [
  "ev", "clv", "odds", "impliedProbability", "vigJuice",
  "edgePercent", "kellyFraction", "expectedValue",
];

/**
 * Canonical set of prohibited key names checked case-insensitively.
 * Any JSONB evidence payload that contains one of these keys at any depth
 * is sanitized before leaving the API layer. This is a defense-in-depth
 * measure; engines 3A–3D must also never write these keys.
 */
export const PROHIBITED_KEY_SET = new Set<string>(PROHIBITED_FIELDS.map((k) => k.toLowerCase()));

/**
 * Recursively strips any object key whose lowercase form appears in
 * PROHIBITED_KEY_SET from an arbitrary value. Arrays are traversed
 * element-by-element; primitives are returned unchanged.
 */
export function stripProhibitedKeys(val: unknown): unknown {
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

export function queryPositiveInteger(value: unknown, name: string) {
  if (value === undefined || value === "") return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new SettlementValidationError(`${name} must be a positive integer`);
  return result;
}

export function requestedSettlementDate(value: unknown) {
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

export function strictPostmortemBody(body: unknown) {
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

export const refreshOfficialSettlement: RequestHandler = async (req, res, next) => {
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

export function requestedModelMarket(value: unknown): ModelMarket {
  const market = typeof value === "string" ? value.toUpperCase() : "";
  if (!MODEL_MARKETS.includes(market as ModelMarket)) {
    throw new ModelTrainingValidationError("market must be TB, XBH, WALK, or HR");
  }
  return market as ModelMarket;
}

export function requestedBoardMarket(value: unknown): BoardMarket | null {
  if (value == null || value === "") return null;
  const market = String(value).trim().toUpperCase();
  if (!MODEL_MARKETS.includes(market as ModelMarket)) {
    throw new DailyMarketBoardValidationError("market must be TB, XBH, WALK, or HR");
  }
  return market as BoardMarket;
}

export function marketBoardPresentation(
  entries: Awaited<ReturnType<typeof queryDailyMarketBoard>>,
  readiness: OperationalReadiness,
  date: string,
) {
  const validatedCurrentPresentation = date === readiness.currentDate && readiness.usable;
  return validatedCurrentPresentation ? entries : entries.map((entry) => ({
    ...entry,
    modelPrediction: null,
    calibratedProbability: null,
    modelVersionId: null,
    confidenceLabel: "NONE" as const,
    confidenceBasis: "RESEARCH_ONLY" as const,
    // The feature coverage disclosures describe a model output. When the model
    // output is suppressed they are suppressed with it, so a research-only
    // presentation never carries half of a model row.
    featureCoverage: null,
    imputedFeatures: [] as string[],
    unknownFeatures: [] as string[],
  }));
}

// ── Phase 7A – Bettor Intelligence Ingestion and Lineage ──────────────────────

export function requestedBettorMarket(value: unknown): BettorMarket | null {
  if (value == null || value === "") return null;
  const market = String(value).trim().toUpperCase();
  if (!BETTOR_MARKETS.includes(market as BettorMarket)) {
    throw new BettorIntelligenceValidationError("market must be TB, XBH, WALK, or HR");
  }
  return market as BettorMarket;
}

export function bettorErrorResponse(
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

export function aiWorkflowErrorResponse(error: unknown, res: Parameters<RequestHandler>[1]) {
  if (error instanceof AiWorkflowValidationError) {
    res.status(400).json({ error: error.message });
    return true;
  }
  return false;
}

export function matchesOperatorApprovalKey(received: unknown, expected: string) {
  return typeof received === "string"
    && Buffer.byteLength(received) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export const APPROVAL_OPERATOR_ID = "AI_REVIEW_OPERATOR";

export function issueOperatorApprovalSession(res: Parameters<RequestHandler>[1], secret: string): void {
  const payload = Buffer.from(JSON.stringify({ operatorId: APPROVAL_OPERATOR_ID, capability: "AI_REVIEW", expiresAt: Date.now() + 15 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  res.cookie("ai_operator_approval", `${payload}.${signature}`, {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 15 * 60 * 1000, path: "/api",
  });
}

export function issueOperationsApprovalSession(res: Parameters<RequestHandler>[1], secret: string): void {
  const payload = Buffer.from(JSON.stringify({ capability: "OPERATIONS", expiresAt: Date.now() + 15 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  res.cookie("operations_operator_approval", `${payload}.${signature}`, {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 15 * 60 * 1000, path: "/api",
  });
}

export function hasOperatorApprovalCapability(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]): string | null {
  const expected = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
  if (!expected) {
    res.status(503).json({ error: "Operator approval is unavailable until AI_ANALYST_OPERATOR_APPROVAL_KEY is configured." });
    return null;
  }
  const rawCookie = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("ai_operator_approval="))?.slice("ai_operator_approval=".length);
  const [payload, signature] = rawCookie?.split(".") ?? [];
  const expectedSignature = payload ? createHmac("sha256", expected).update(payload).digest("base64url") : "";
  if (!payload || !signature || !matchesOperatorApprovalKey(signature, expectedSignature)) {
    res.status(403).json({ error: "A valid operator approval session is required for this action." });
    return null;
  }
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { operatorId?: unknown; capability?: unknown; expiresAt?: unknown };
    if (session.operatorId !== APPROVAL_OPERATOR_ID || session.capability !== "AI_REVIEW" || typeof session.expiresAt !== "number" || session.expiresAt < Date.now()) throw new Error("expired");
    return APPROVAL_OPERATOR_ID;
  } catch {
    res.status(403).json({ error: "The operator approval session is expired or invalid." });
    return null;
  }
}
