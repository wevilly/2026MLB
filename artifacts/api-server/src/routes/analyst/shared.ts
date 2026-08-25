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
import { PREGAME_LINEUP_SOURCE_PRECEDENCE, lineupSourceFilter } from "../../services/lineup-sources";
import { ROUND_ROBIN_MARKETS, RR_DB_TO_MARKET, RR_MARKET_TO_DB } from "../../services/market-codes";
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
 * Accepted projected-lineup pairs for the Round Robin pregame read. Official
 * posted cards remain audit context and cannot replace these research inputs.
 */
export const ROUND_ROBIN_LINEUP_FILTER = lineupSourceFilter(PREGAME_LINEUP_SOURCE_PRECEDENCE);

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
       SELECT DISTINCT ON (ls.game_pk, ls.team_id) ls.lineup_snapshot_id, ls.game_pk, ls.team_id, ls.raw
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
      ),
      current_projected_lineup_identity_failures AS (
        SELECT l.game_pk, l.team_id, entry->>'playerId' AS external_player_id
        FROM latest_projected_lineups l
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(l.raw->'entries') = 'array' THEN l.raw->'entries' ELSE '[]'::jsonb END
        ) entry
        WHERE NULLIF(entry->>'playerId', '') IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM (
               SELECT player_id FROM player_external_ids
                WHERE source_id = 'FANTASYPROS' AND external_player_id = entry->>'playerId' AND valid_to IS NULL
               UNION ALL
               SELECT player_id FROM player_external_id_aliases
                WHERE source_id = 'FANTASYPROS' AND external_player_id = entry->>'playerId'
             ) mapped
             JOIN player_eligibility pe ON pe.source_id = 'FANTASYPROS'
               AND pe.external_player_id = entry->>'playerId' AND pe.effective_date = $1
             WHERE pe.eligible_lineup_projection AND NOT pe.requires_identity_review
           )
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
       -- This remains an audit count for broad FantasyPros projection-component
       -- review. It is intentionally not a readiness blocker: only players
       -- present in the current projected lineup can block the slate.
       (SELECT count(*) FILTER (WHERE requires_identity_review)::int FROM current_projection_rows) AS unresolved_active_players,
       (SELECT count(*)::int FROM player_eligibility WHERE source_id = 'FANTASYPROS' AND effective_date = $1 AND quarantined_from_current_research) AS quarantined_rows,
       (SELECT count(*)::int FROM ingest_issues
        WHERE issue_type = 'TEAM_ASSIGNMENT_CONFLICT'
          AND ingest_run_id = (
            SELECT ingest_run_id FROM ingest_runs
            WHERE source_id = 'FANTASYPROS' AND effective_date = $1
            ORDER BY started_at DESC LIMIT 1
          )) AS team_assignment_conflicts,
        (SELECT count(*)::int FROM current_projected_lineup_identity_failures) AS blocking_projected_lineup_issues`,
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
  const [sources, issueResult, lastRun, coverage, research, slate, workflow, bullpen, fantasyProsReferences, weatherRefresh] = await Promise.all([
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
    pool.query<{ references: number }>(
      "SELECT count(*)::int AS references FROM fantasypros_reference_ranks WHERE slate_date = $1",
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
  const baselineReady = Boolean(slate.rows[0]?.games) && Boolean(fantasyProsReferences.rows[0]?.references);
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
    ...(fantasyProsReferences.rows[0]?.references ? [] : [`No FantasyPros reference ranks were recorded for ${date}.`]),
    ...(coverage.blockingProjectedLineupIssues
      ? [`${coverage.blockingProjectedLineupIssues} current projected-lineup identity record(s) remain unresolved.`]
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
    ...(fantasyProsReferences.rows[0]?.references ? [] : [{ label: "FANTASYPROS REFERENCES MISSING", detail: `No FantasyPros reference ranks were recorded for ${date}.`, severity: "CRITICAL" }]),
    ...(coverage.blockingProjectedLineupIssues
      ? [{ label: "CURRENT PROJECTED LINEUP IDENTITY UNRESOLVED", detail: `${coverage.blockingProjectedLineupIssues} current projected-lineup identity record(s) are unresolved.`, severity: "CRITICAL" }]
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
      { code: "FANTASYPROS_REFERENCES", label: "FantasyPros reference ranks", status: baselineReady ? "READY" : "BLOCKED", detail: baselineReady ? `${fantasyProsReferences.rows[0]?.references ?? 0} reference rank record(s) are available for comparison only.` : `No FantasyPros reference ranks were recorded for ${date}.` },
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
  if (!ROUND_ROBIN_MARKETS.includes(market as (typeof ROUND_ROBIN_MARKETS)[number])) {
    throw new DailyMarketBoardValidationError("market must be TB, XBH, WALK, HR, or H_R_RBI");
  }
  return market as BoardMarket;
}

export function marketBoardPresentation(
  entries: Awaited<ReturnType<typeof queryDailyMarketBoard>>,
  readiness: OperationalReadiness,
  date: string,
) {
  void readiness;
  void date;
  return entries;
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


/**
 * The Round Robin comparison, read from the database and compared.
 *
 * Lifted out of the GET /analyst/round-robin/comparison handler unchanged when
 * the Excel export was added, so the JSON surface and the workbook answer from
 * one query and one comparison rather than two that can drift apart. Both
 * routes now format what this returns; neither decides anything the comparison
 * did not.
 */
export const ROUND_ROBIN_BOARDS: RoundRobinBoardId[] = ["RR1", "RR2", "RR3", "RR4", "RR5"];

export function isRoundRobinBoard(value: unknown): value is RoundRobinBoardId {
  return typeof value === "string" && (ROUND_ROBIN_BOARDS as string[]).includes(value);
}

/** Both teams are evaluated before a construction is selected. Ties are surfaced, never collapsed. */
export async function buildRoundRobinComparison(date: string, board: RoundRobinBoardId) {
  const health = await analystDataHealth(date);
  const operationallyUsable = date === health.readiness.currentDate && health.readiness.usable;
  const rows = await pool.query<{
    candidate_id: string; game_pk: number; player_id: number; player_name: string; market: string;
    research_rank: number | null; research_state: "STRONG" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "BLOCKED";
    primary_mechanism: string | null; opportunity_evidence: Record<string, unknown>; starter_matchup_evidence: Record<string, unknown>;
    bullpen_path_evidence: Record<string, unknown>; park_evidence: Record<string, unknown>; counter_evidence: Record<string, unknown>;
     missing_stale_evidence: string | null; identity_resolved: boolean; side: "AWAY" | "HOME"; team: string;
     lineup_state: "POSTED" | "CONFIRMED" | "PROJECTED"; lineup_source: string;
  }>(
    `WITH accepted AS (
       SELECT * FROM unnest($2::text[], $3::text[]) AS s(source_id, state)
     ),
     latest_lineup AS (
       -- One projected lineup per team, selected through the documented
       -- pregame policy in lineup-sources.ts. Official MLB cards are
       -- retained separately for audit and settlement context.
       SELECT DISTINCT ON (ls.game_pk, ls.team_id)
          ls.lineup_snapshot_id, ls.game_pk, ls.team_id, ls.state, ls.source_id
       FROM lineup_snapshots ls
       JOIN games g ON g.game_pk = ls.game_pk
       JOIN accepted a ON a.source_id = ls.source_id AND a.state = ls.state::text
       WHERE g.game_date = $1
       ORDER BY ls.game_pk, ls.team_id,
         array_position($2::text[], ls.source_id),
         CASE ls.state::text
           WHEN 'POSTED' THEN 1
           WHEN 'CONFIRMED' THEN 2
           WHEN 'UPDATED' THEN 3
           WHEN 'PROJECTED' THEN 4
           ELSE 9
         END,
         ls.observed_at DESC
     )
     SELECT mrc.candidate_id, mrc.game_pk::bigint, mrc.player_id, COALESCE(p.full_name, 'Unknown') AS player_name,
            mrc.market, mrc.research_rank, mrc.research_state, mrc.primary_mechanism,
            mrc.opportunity_evidence, mrc.starter_matchup_evidence, mrc.bullpen_path_evidence,
             mrc.park_evidence, mrc.counter_evidence, mrc.missing_stale_evidence, ll.state AS lineup_state, ll.source_id AS lineup_source,
            CASE WHEN ll.team_id = g.away_team_id THEN 'AWAY' ELSE 'HOME' END AS side,
            CASE WHEN ll.team_id = g.away_team_id THEN away.abbreviation ELSE home.abbreviation END AS team,
            NOT EXISTS (
              SELECT 1 FROM player_eligibility pe
              WHERE pe.player_id = mrc.player_id
                AND pe.source_id = 'FANTASYPROS'
                AND pe.effective_date = mrc.slate_date
                AND pe.requires_identity_review
            ) AS identity_resolved
     FROM market_research_candidates mrc
     JOIN games g ON g.game_pk = mrc.game_pk
     JOIN teams away ON away.team_id = g.away_team_id
     JOIN teams home ON home.team_id = g.home_team_id
     JOIN latest_lineup ll ON ll.game_pk = mrc.game_pk
     JOIN lineup_entries le ON le.lineup_snapshot_id = ll.lineup_snapshot_id AND le.player_id = mrc.player_id
     LEFT JOIN players p ON p.player_id = mrc.player_id
     WHERE mrc.slate_date = $1
     ORDER BY mrc.game_pk, side, mrc.research_rank ASC NULLS LAST, player_name`,
    [date, ROUND_ROBIN_LINEUP_FILTER.sourceIds, ROUND_ROBIN_LINEUP_FILTER.states],
  );

  const candidates = await Promise.all(rows.rows.map(async (row) => {
    const starterId = typeof row.starter_matchup_evidence?.starterPlayerId === "number"
      ? row.starter_matchup_evidence.starterPlayerId
      : null;
    const starterState = typeof row.starter_matchup_evidence?.starterState === "string"
      ? row.starter_matchup_evidence.starterState
      : "UNKNOWN";
    const baseEligibility = getMarketResearchSelectionEligibility({
      researchState: row.research_state,
      missingStaleEvidence: row.missing_stale_evidence,
      identityResolved: row.identity_resolved,
    });
    const starterResolved = starterId !== null && !["UNKNOWN", "TBD"].includes(starterState);
    const selectionBlockReason = !operationallyUsable
      ? "BLOCKED"
      : !starterResolved
      ? "BLOCKED"
      : baseEligibility.selectionBlockReason;
    const selectable = operationallyUsable && starterResolved && baseEligibility.selectable;
    const bvpEvidence = starterId && MARKET_DB_TO_SHORTCODE[row.market] !== "H_R_RBI"
      ? await getBatterPitcherEvidence(row.player_id, starterId, date, MARKET_DB_TO_SHORTCODE[row.market] as BvpMarket)
      : null;
    const evidenceFreshness = row.missing_stale_evidence
      ? /\bstale\b/i.test(row.missing_stale_evidence) ? "STALE" : "INCOMPLETE"
      : "CURRENT";
    return {
      candidateId: row.candidate_id,
      gamePk: Number(row.game_pk),
      playerId: row.player_id,
      playerName: row.player_name,
      market: MARKET_DB_TO_SHORTCODE[row.market] as RoundRobinCandidate["market"],
      researchRank: row.research_rank,
      researchState: row.research_state,
      side: row.side,
      team: row.team,
      selectable,
      selectionBlockReason,
      lineupState: row.lineup_state,
      starterState,
      bvpStatus: bvpEvidence?.status ?? "NOT_FOUND",
      bvpEvidence,
      arsenalStatus: bvpEvidence?.arsenal.status ?? "NOT_FOUND",
      evidenceFreshness,
      evidenceFreshnessDetail: row.missing_stale_evidence,
      primaryMechanism: row.primary_mechanism,
      opportunityEvidence: stripProhibitedKeys(row.opportunity_evidence ?? {}) as Record<string, unknown>,
      starterMatchupEvidence: stripProhibitedKeys(row.starter_matchup_evidence ?? {}) as Record<string, unknown>,
      bullpenPathEvidence: stripProhibitedKeys(row.bullpen_path_evidence ?? {}) as Record<string, unknown>,
      parkEvidence: stripProhibitedKeys(row.park_evidence ?? {}) as Record<string, unknown>,
      counterEvidence: stripProhibitedKeys(row.counter_evidence ?? {}) as Record<string, unknown>,
      sourceLineage: { lineupSource: row.lineup_source, lineupState: row.lineup_state, starterSource: "FANTASYPROS" },
      sampleDenominators: {
        starter: (row.starter_matchup_evidence ?? {}).sampleSize ?? null,
        bullpen: (row.bullpen_path_evidence ?? {}).sampleSize ?? null,
        park: (row.park_evidence ?? {}).sampleSize ?? null,
      },
    } satisfies RoundRobinCandidate;
  }));

  const gameMetadata = await pool.query<{
    game_pk: number; away: string; home: string;
    away_lineup_state: "POSTED" | "CONFIRMED" | "PROJECTED" | null; away_lineup_source: string | null;
    away_lineup_observed_at: string | null; away_lineup_hitters: number;
    home_lineup_state: "POSTED" | "CONFIRMED" | "PROJECTED" | null; home_lineup_source: string | null;
    home_lineup_observed_at: string | null; home_lineup_hitters: number;
  }>(
    `WITH latest_lineup AS (
       SELECT DISTINCT ON (ls.game_pk, ls.team_id)
         ls.lineup_snapshot_id, ls.game_pk, ls.team_id, ls.state, ls.source_id, ls.observed_at
       FROM lineup_snapshots ls
       JOIN games g ON g.game_pk = ls.game_pk
       WHERE g.game_date = $1
         AND ls.source_id = 'FANTASYPROS'
         AND ls.state = 'PROJECTED'
       ORDER BY ls.game_pk, ls.team_id,
         ls.observed_at DESC
     ),
     lineup_hitter_counts AS (
       SELECT lineup_snapshot_id, count(*)::int AS hitter_count
       FROM lineup_entries
       GROUP BY lineup_snapshot_id
     )
     SELECT g.game_pk::bigint, away.abbreviation AS away, home.abbreviation AS home,
            away_lineup.state AS away_lineup_state, away_lineup.source_id AS away_lineup_source,
            away_lineup.observed_at::text AS away_lineup_observed_at,
            COALESCE(away_count.hitter_count, 0)::int AS away_lineup_hitters,
            home_lineup.state AS home_lineup_state, home_lineup.source_id AS home_lineup_source,
            home_lineup.observed_at::text AS home_lineup_observed_at,
            COALESCE(home_count.hitter_count, 0)::int AS home_lineup_hitters
     FROM games g
     JOIN teams away ON away.team_id = g.away_team_id
     JOIN teams home ON home.team_id = g.home_team_id
     LEFT JOIN latest_lineup away_lineup ON away_lineup.game_pk = g.game_pk AND away_lineup.team_id = g.away_team_id
     LEFT JOIN lineup_hitter_counts away_count ON away_count.lineup_snapshot_id = away_lineup.lineup_snapshot_id
     LEFT JOIN latest_lineup home_lineup ON home_lineup.game_pk = g.game_pk AND home_lineup.team_id = g.home_team_id
     LEFT JOIN lineup_hitter_counts home_count ON home_count.lineup_snapshot_id = home_lineup.lineup_snapshot_id
     WHERE g.game_date = $1
     ORDER BY g.start_time_utc NULLS LAST`,
    [date],
  );
  const byGame = new Map<number, RoundRobinCandidate[]>();
  for (const candidate of candidates) {
    const gameCandidates = byGame.get(candidate.gamePk) ?? [];
    gameCandidates.push(candidate);
    byGame.set(candidate.gamePk, gameCandidates);
  }
  const games = gameMetadata.rows.map((game) => compareRoundRobinGame(
    board as RoundRobinBoardId,
    Number(game.game_pk),
    game.away,
    game.home,
    byGame.get(Number(game.game_pk)) ?? [],
    {
      lineupState: `${game.away_lineup_state ?? "UNKNOWN"},${game.home_lineup_state ?? "UNKNOWN"}`,
      lineupSource: `${game.away_lineup_source ?? "MISSING"},${game.home_lineup_source ?? "MISSING"}`,
      starterState: "FANTASYPROS_PROJECTED_CONTEXT",
      evidenceGaps: [
        !game.away_lineup_state || !game.home_lineup_state ? "Missing selected lineup snapshot for one or both teams" : null,
        !operationallyUsable ? (health.readiness.reason ?? "Research readiness is unavailable") : null,
      ].filter((gap): gap is string => Boolean(gap)),
    },
  ));
  return {
    date,
    board,
    games,
    readiness: health.readiness,
    prohibitedFields: PROHIBITED_FIELDS,
  };
}
