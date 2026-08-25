/**
 * Manual refresh triggers for every ingest and every market engine.
 *
 * Split out of routes/analyst.ts by remediation task 5.2. A PURE MOVE: every
 * handler below is byte-identical to the one that was in that file, mounted at
 * the same absolute path. No behaviour changed in the same commit.
 *
 * Routes in this module, in registration order:
 *   POST   /analyst/refresh/mlb
 *   POST   /analyst/refresh/fantasypros
 *   POST   /analyst/refresh/research
 *   POST   /analyst/refresh/research/splits-full
 *   POST   /analyst/refresh/batter-pitcher
 *   POST   /analyst/refresh/market-research/tb
 *   POST   /analyst/refresh/market-research/xbh
 *   POST   /analyst/refresh/market-research/walk
 *   POST   /analyst/refresh/market-research/hr
 *   POST   /analyst/refresh/bullpen
 *   POST   /analyst/refresh/weather
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
  RefreshHistoricalIntelligenceResponse,
  GetAnalystBatterPitcherResponse,
  RefreshAnalystBatterPitcherResponse,
  GetAnalystRoundRobinComparisonResponse,
  RefreshBullpenResponse,
  RefreshWeatherResponse,
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
import { ingestFantasyPros, ingestMlbOfficial, refreshMlbSchedule } from "../../services/data-foundation";
import { getPitcherLab, getPlayerLab, ingestResearch, ingestStatcastHandednessFallback, researchHealth } from "../../services/research-foundation";
import {
  HistoricalIntelligenceValidationError,
  materializeHistoricalIntelligence,
} from "../../services/historical-intelligence";
import { getBatterPitcherEvidence, refreshBatterPitcherSlate, type BvpMarket } from "../../services/batter-pitcher-research";
import { compareRoundRobinGame, type RoundRobinBoardId, type RoundRobinCandidate } from "../../services/round-robin-comparison";
import { LINEUP_SOURCE_PRECEDENCE, lineupSourceFilter } from "../../services/lineup-sources";
import { RR_DB_TO_MARKET, RR_MARKET_TO_DB } from "../../services/market-codes";
import { getBullpenRoom, refreshBullpen } from "../../services/bullpen-foundation";
import { runTBEngine } from "../../services/tb-engine";
import { runXBHEngine } from "../../services/xbh-engine";
import { runWALKEngine } from "../../services/walk-engine";
import { runHREngine } from "../../services/hr-engine";
import { runHRRBIEngine } from "../../services/hrrbi-engine";
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
import { queryAuditEvents, recordAuditEvent } from "../../services/audit";
import { CACHE_POLICY, invalidateCache, invalidateWeatherSlateCaches, readThroughCache } from "../../services/cache";
import { refreshWeather, WeatherRefreshValidationError } from "../../services/weather-foundation";
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
  currentEasternDate,
  engineResponseDate,
  requestedDate,
} from "./shared";

const router: IRouter = Router();

router.post("/analyst/refresh/mlb", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    if (date >= currentEasternDate()) {
      res.status(409).json({ error: "MLB Official ingestion is reserved for postgame settlement and final-state history; use FantasyPros for pregame refreshes." });
      return;
    }
    res.status(201).json(await ingestMlbOfficial(date));
  } catch (error) {
    next(error);
  }
});

// Schedule-metadata-only official refresh. Unlike /analyst/refresh/mlb it has
// no same-day guard: it carries no lineups and no settlement facts, only the
// games/venues/start-time spine that pregame research and weather need.
router.post("/analyst/refresh/mlb-schedule", async (req, res, next) => {
  try {
    res.status(201).json(await refreshMlbSchedule(requestedDate(req.query.date)));
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
    const date = requestedDate(req.query.date);
    const result = RefreshAnalystResearchResponse.parse(await ingestResearch(date));
    invalidateCache("player-lab:");
    invalidateCache("pitcher-lab:");
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/research/splits-full", async (req, res, next) => {
  void req;
  void next;
  res.status(410).json({
    error: "Live Statcast split refresh is retired. Handedness split evidence remains unavailable in the daily API-backed model; existing Statcast records are legacy audit evidence only.",
    code: "RETIRED_LIVE_SOURCE",
  });
});

router.post("/analyst/refresh/historical-intelligence", async (req, res, next) => {
  void req;
  void next;
  res.status(410).json({
    error: "Historical live Statcast refresh is retired. Existing historical observations are read-only legacy audit evidence and are never used as active daily-source data.",
    code: "RETIRED_LIVE_SOURCE",
  });
});

router.post("/analyst/refresh/batter-pitcher", async (req, res, next) => {
  try {
    res.status(201).json(
      RefreshAnalystBatterPitcherResponse.parse(await refreshBatterPitcherSlate(requestedDate(req.query.date))),
    );
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

router.post("/analyst/refresh/market-research/hrrbi", async (req, res, next) => {
  try {
    res.status(201).json(await runHRRBIEngine(requestedDate(req.query.date)));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/bullpen", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const result = await refreshBullpen(date);
    invalidateCache(`bullpen:${date}:`);
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

router.post("/analyst/refresh/weather", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    await recordAuditEvent({
      actor: "OPERATOR",
      requestId: String(req.id),
      action: "weather.refresh.requested",
      resourceType: "slate",
      resourceId: date,
      metadata: { slateDate: date },
    });
    const result = await refreshWeather(date, { actor: "OPERATOR", requestId: String(req.id) });
    invalidateWeatherSlateCaches(date);
    // Source-registration failures happen before an ingest-run ID can exist.
    // Preserve those rare failed attempts in the audit ledger as well.
    if (!result.ingestRunId) {
      await recordAuditEvent({
        actor: "OPERATOR",
        requestId: String(req.id),
        action: "weather.refresh",
        resourceType: "slate",
        resourceId: date,
        metadata: {
          status: result.status,
          ingestRunId: null,
          error: result.error ?? null,
          failures: result.failures,
        },
      });
    }
    res.status(result.status === "FAILED" ? 500 : 201).json(RefreshWeatherResponse.parse(result));
  } catch (error) {
    if (error instanceof WeatherRefreshValidationError) {
      await recordAuditEvent({
        actor: "OPERATOR",
        requestId: String(req.id),
        action: "weather.refresh.rejected",
        resourceType: "slate",
        resourceId: typeof req.query.date === "string" ? req.query.date : null,
        metadata: { error: error.message },
      });
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

export default router;
