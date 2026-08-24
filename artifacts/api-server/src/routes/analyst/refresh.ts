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

export default router;
