/**
 * Research surfaces: labs, market research, projections, exports, Round Robin, health.
 *
 * Split out of routes/analyst.ts by remediation task 5.2. A PURE MOVE: every
 * handler below is byte-identical to the one that was in that file, mounted at
 * the same absolute path. No behaviour changed in the same commit.
 *
 * Routes in this module, in registration order:
 *   GET    /analyst/today
 *   GET    /analyst/projections
 *   GET    /analyst/data-health
 *   GET    /analyst/player-lab
 *   GET    /analyst/historical-intelligence/coverage
 *   GET    /analyst/pitcher-lab
 *   GET    /analyst/batter-pitcher
 *   GET    /analyst/game-lab
 *   GET    /analyst/settings
 *   GET    /analyst/export/slate-json
 *   GET    /analyst/export/workbook
 *   GET    /analyst/export/round-robin/workbook
 *   GET    /analyst/audit-events
 *   GET    /analyst/round-robin/comparison
 *   GET    /analyst/market-research
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
  GetHistoricalIntelligenceCoverageResponse,
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
import { historicalIntelligenceCoverage } from "../../services/historical-intelligence";
import { getBatterPitcherEvidence, refreshBatterPitcherSlate, type BvpMarket } from "../../services/batter-pitcher-research";
import { compareRoundRobinGame, type RoundRobinBoardId, type RoundRobinCandidate } from "../../services/round-robin-comparison";
import { buildRoundRobinWorkbook } from "../../services/round-robin-workbook";
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
import {
  MARKET_DB_TO_SHORTCODE,
  MARKET_SHORTCODE_TO_DB,
  PROHIBITED_FIELDS,
  RANK_DONT_GATE_SEMANTICS,
  ROUND_ROBIN_BOARDS,
  ROUND_ROBIN_LINEUP_FILTER,
  analystDataHealth,
  buildRoundRobinComparison,
  displayTime,
  fantasyProsConfigured,
  identityCoverage,
  isoString,
  requestedDate,
  requestedLabSearch,
  requestedPlayerId,
  requestedWindow,
  isRoundRobinBoard,
  requiredDate,
  stripProhibitedKeys,
} from "./shared";

const router: IRouter = Router();

router.get("/analyst/today", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const [gameResult, health] = await Promise.all([
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
            SELECT COUNT(DISTINCT team_id) FILTER (WHERE source_id = 'MLB_OFFICIAL' AND state = 'POSTED')::int AS posted_lineup_teams,
                   COUNT(DISTINCT team_id) FILTER (WHERE source_id = 'FANTASYPROS' AND state = 'PROJECTED')::int AS projected_lineup_teams
            FROM lineup_snapshots WHERE game_pk = g.game_pk
          ) lineups ON true
         WHERE g.game_date = $1 ORDER BY g.start_time_utc NULLS LAST`,
        [date],
      ),
      analystDataHealth(date),
    ]);
    const games = gameResult.rows.map((game) => ({
      id: String(game.game_pk),
      time: displayTime(game.start_time_utc),
      away: game.away,
      home: game.home,
      park: game.park ?? "NOT FOUND",
      roof: "NOT FOUND",
      weather: "NOT FOUND",
      awayStarter: {
        name: game.away_starter ?? "TBD",
        hand: game.away_hand || "NOT FOUND",
        state: game.away_state ?? "TBD",
        note: "",
      },
      homeStarter: {
        name: game.home_starter ?? "TBD",
        hand: game.home_hand || "NOT FOUND",
        state: game.home_state ?? "TBD",
        note: "",
      },
      lineupState: game.projected_lineup_teams === 2
        ? game.posted_lineup_teams === 2 ? "PROJECTED · MLB POSTED" : "PROJECTED"
        : "UNKNOWN",
      state: game.projected_lineup_teams === 2 &&
        game.away_state !== "TBD" &&
        game.home_state !== "TBD"
        ? health.readiness.usable ? "READY" : "PARTIAL"
        : health.readiness.status === "BLOCKED" || health.readiness.status === "AUDIT_ONLY"
          ? "BLOCKED"
          : "PARTIAL",
      flag: !health.readiness.usable
        ? health.readiness.reason
        : game.projected_lineup_teams === 2
        ? game.posted_lineup_teams === 2
          ? "FantasyPros projected lineups drive research · MLB posted cards retained for audit"
          : "FantasyPros projected lineups drive pregame research"
        : game.projected_lineup_teams > 0
          ? "FantasyPros lineup evidence is incomplete"
          : "No projected lineup evidence found",
    }));
    const today = {
      date: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date(`${date}T12:00:00Z`)),
      timezone: "America/New_York",
      games,
      sources: health.sources,
      identityCoverage: health.identityCoverage,
      readiness: health.readiness,
      alerts: [
        "Pre-model slate status uses READY, PARTIAL, and BLOCKED only.",
        "No forecast, price, odds, implied probability, EV, or CLV data is used in this workflow.",
        games.length ? "FantasyPros projected matchups, lineups, and starter observations are persisted." : "No FantasyPros projected slate has been ingested for this date.",
        health.identityCoverage.blockingProjectedLineupIssues
          ? `${health.identityCoverage.blockingProjectedLineupIssues} projected-lineup identity issue(s) are blocking research eligibility.`
          : "Projected lineup identities have no current blocking issue.",
        health.readiness.reason,
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

router.get("/analyst/data-health", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    res.json(GetAnalystDataHealthResponse.parse(await analystDataHealth(date)));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/player-lab", async (req, res, next) => {
  try {
    const playerId = requestedPlayerId(req.query.playerId);
    const search = requestedLabSearch(req.query.search);
    const window = requestedWindow(req.query.window);
    const date = requestedDate(req.query.date);
    const profile = await readThroughCache(
      `player-lab:${playerId ?? "search"}:${search}:${window}:${date}`,
      CACHE_POLICY.labs,
      () => getPlayerLab(playerId, search, window, date),
    );
    res.json(GetAnalystPlayerLabResponse.parse(profile));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/historical-intelligence/coverage", async (req, res, next) => {
  try {
    const playerId = requestedPlayerId(req.query.playerId);
    const coverage = await historicalIntelligenceCoverage(playerId);
    res.json(GetHistoricalIntelligenceCoverageResponse.parse(coverage));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/pitcher-lab", async (req, res, next) => {
  try {
    const playerId = requestedPlayerId(req.query.playerId);
    const search = requestedLabSearch(req.query.search);
    const window = requestedWindow(req.query.window);
    const date = requestedDate(req.query.date);
    const profile = await readThroughCache(
      `pitcher-lab:${playerId ?? "search"}:${search}:${window}:${date}`,
      CACHE_POLICY.labs,
      () => getPitcherLab(playerId, search, window, date),
    );
    res.json(GetAnalystPitcherLabResponse.parse(profile));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/batter-pitcher", async (req, res, next) => {
  try {
    const batterId = requestedPlayerId(req.query.batterId);
    const pitcherId = requestedPlayerId(req.query.pitcherId);
    if (!batterId || !pitcherId) {
      res.status(400).json({ error: "batterId and pitcherId must be resolved canonical MLB player IDs." });
      return;
    }
    const requestedMarket = typeof req.query.market === "string" ? req.query.market.toUpperCase() : "TB";
    const market = ["TB", "XBH", "WALK", "HR"].includes(requestedMarket) ? requestedMarket as BvpMarket : "TB";
    res.json(GetAnalystBatterPitcherResponse.parse(
      await getBatterPitcherEvidence(batterId, pitcherId, requestedDate(req.query.date), market),
    ));
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
       LEFT JOIN LATERAL (SELECT
         COUNT(DISTINCT team_id) FILTER (WHERE source_id = 'MLB_OFFICIAL' AND state = 'POSTED')::int AS posted_lineup_teams,
         COUNT(DISTINCT team_id) FILTER (WHERE source_id = 'FANTASYPROS' AND state = 'PROJECTED')::int AS projected_lineup_teams
         FROM lineup_snapshots WHERE game_pk = g.game_pk) lineups ON true
       WHERE g.game_date = $1 ORDER BY g.start_time_utc NULLS LAST`,
      [date],
    );
    const responseGames = games.rows.map((game) => ({
      id: String(game.game_pk), time: displayTime(game.start_time_utc), away: game.away, home: game.home,
      park: game.park ?? "NOT FOUND", roof: "NOT FOUND", weather: "NOT FOUND",
      awayStarter: { name: game.away_starter ?? "TBD", hand: game.away_hand ?? "NOT FOUND", state: game.away_state ?? "TBD", note: "" },
      homeStarter: { name: game.home_starter ?? "TBD", hand: game.home_hand ?? "NOT FOUND", state: game.home_state ?? "TBD", note: "" },
      lineupState: game.projected_lineup_teams === 2
        ? game.posted_lineup_teams === 2 ? "PROJECTED · MLB POSTED" : "PROJECTED"
        : "UNKNOWN",
      state: game.projected_lineup_teams === 2 && game.away_state === "CONFIRMED" && game.home_state === "CONFIRMED" ? "READY" : "PARTIAL" as const,
      flag: game.projected_lineup_teams === 2
        ? game.posted_lineup_teams === 2
          ? "FantasyPros projected lineups drive research · MLB posted cards retained for audit"
          : "FantasyPros projected lineups drive pregame research"
        : "Research context only — no projected lineup coverage",
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

router.get("/analyst/export/slate-json", async (req, res, next) => {
  try {
    // The platform is the official record. This is a read-only derived export.
    res.json(await buildSlateExport(requiredDate(req.query.date)));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/export/workbook", async (req, res, next) => {
  try {
    // The platform is the official record. This Excel-compatible workbook is derived output.
    const result = await buildWorkbookExport(requiredDate(req.query.date));
    res.type("application/vnd.ms-excel");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.send(result.workbook);
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/export/round-robin/workbook", async (req, res, next) => {
  try {
    // Derived output. The platform remains the official record, and the
    // workbook carries only what the comparison surface already carries.
    const date = requestedDate(req.query.date);
    const boardParam = typeof req.query.board === "string" ? req.query.board.toUpperCase() : "";
    if (boardParam !== "" && !isRoundRobinBoard(boardParam)) {
      res.status(400).json({ error: "board must be RR1, RR2, RR3, RR4, or RR5." });
      return;
    }
    const requestedBoards = isRoundRobinBoard(boardParam) ? [boardParam] : ROUND_ROBIN_BOARDS;
    // Sequential on purpose: each board runs the full slate comparison, and
    // five of those at once is pool pressure for no operator benefit.
    const comparisons = [];
    for (const board of requestedBoards) {
      comparisons.push(await buildRoundRobinComparison(date, board));
    }
    const readiness = comparisons[0]?.readiness ?? null;
    const boards = comparisons.map((comparison) => ({ board: comparison.board, games: comparison.games }));
    const result = buildRoundRobinWorkbook({
      slateDate: date,
      generatedAt: new Date().toISOString(),
      boards,
      readiness: {
        status: readiness?.status ?? "UNKNOWN",
        usable: readiness?.usable ?? false,
        reason: readiness?.reason ?? "",
        reasons: readiness?.reasons ?? [],
        currentDate: readiness?.currentDate ?? "",
        requestedDate: readiness?.requestedDate ?? date,
        isCurrentDate: readiness?.isCurrentDate ?? false,
        observedAt: readiness?.observedAt ?? "",
      },
      prohibitedFields: PROHIBITED_FIELDS,
    });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.send(result.workbook);
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/audit-events", async (req, res, next) => {
  try {
    const parsed = req.query.limit == null ? 100 : Number(req.query.limit);
    if (!Number.isFinite(parsed)) throw new Error("limit must be numeric");
    const events = await queryAuditEvents(parsed);
    res.json({ events, total: events.length });
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/round-robin/comparison", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const board = typeof req.query.board === "string" ? req.query.board.toUpperCase() : "";
    if (!isRoundRobinBoard(board)) {
      res.status(400).json({ error: "board must be RR1, RR2, RR3, RR4, or RR5." });
      return;
    }
    res.json(GetAnalystRoundRobinComparisonResponse.parse(await buildRoundRobinComparison(date, board)));
  } catch (error) {
    next(error);
  }
});

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
    const health = await analystDataHealth(date);
    const operationallyUsable = date === health.readiness.currentDate && health.readiness.usable;

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
       identity_resolved: boolean;
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
              NOT EXISTS (
                SELECT 1
                FROM player_eligibility pe
                WHERE pe.player_id = mrc.player_id
                  AND pe.source_id = 'FANTASYPROS'
                  AND pe.effective_date = mrc.slate_date
                  AND pe.requires_identity_review
              ) AS identity_resolved,
               mrc.created_at::text, mrc.updated_at::text
       FROM market_research_candidates mrc
       LEFT JOIN players p ON p.player_id = mrc.player_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY mrc.research_rank ASC NULLS LAST, mrc.research_state, player_name`,
      sqlParams,
    );

    const candidates = await Promise.all(candidateResult.rows.map(async (row) => {
      const eligibility = getMarketResearchSelectionEligibility({
        researchState: row.research_state,
        missingStaleEvidence: row.missing_stale_evidence,
        identityResolved: row.identity_resolved,
      });

      const starterId = typeof row.starter_matchup_evidence?.starterPlayerId === "number"
        ? row.starter_matchup_evidence.starterPlayerId
        : null;
      const bvpEvidence = starterId && MARKET_DB_TO_SHORTCODE[row.market] !== "H_R_RBI"
        ? await getBatterPitcherEvidence(row.player_id, starterId, date, MARKET_DB_TO_SHORTCODE[row.market] as BvpMarket)
        : null;
      return {
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
        bvpEvidence,
        missingStaleEvidence: row.missing_stale_evidence,
        identityResolved: row.identity_resolved,
        selectable: operationallyUsable && eligibility.selectable,
        selectionBlockReason: !operationallyUsable ? "BLOCKED" : eligibility.selectionBlockReason,
        operationalState: operationallyUsable && eligibility.selectable ? "USABLE" : "AUDIT_ONLY",
        auditReason: operationallyUsable && eligibility.selectable
          ? null
          : !operationallyUsable ? health.readiness.reason
            : eligibility.selectionBlockReason
              ? `Not usable: ${eligibility.selectionBlockReason.replaceAll("_", " ").toLowerCase()}.`
              : "Not usable under the current-date safety contract.",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }));

    res.json(GetAnalystMarketResearchResponse.parse({
      date,
      market: marketParam,
      gameId,
      readiness: health.readiness,
      rankSemantics: RANK_DONT_GATE_SEMANTICS,
      prohibitedFields: PROHIBITED_FIELDS,
      candidates,
      candidateCount: candidates.length,
      selectableCandidateCount: candidates.filter((candidate) => candidate.selectable).length,
      systemNote: "Market engines 3A–3D populate this board. All candidates remain visible for audit; only current rows with resolved identity, complete evidence, and a READY current-date health contract are usable in Round Robin.",
    }));
  } catch (error) {
    next(error);
  }
});

export default router;
