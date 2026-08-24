/**
 * Official settlement and postmortems.
 *
 * Split out of routes/analyst.ts by remediation task 5.2. A PURE MOVE: every
 * handler below is byte-identical to the one that was in that file, mounted at
 * the same absolute path. No behaviour changed in the same commit.
 *
 * Routes in this module, in registration order:
 *   POST   /analyst/settlements/automate
 *   POST   /analyst/settlement/refresh
 *   POST   /analyst/settlements/ingest
 *   POST   /analyst/settlements/:gamePk
 *   GET    /analyst/settlements
 *   POST   /analyst/postmortems
 *   GET    /analyst/postmortems
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
  queryPositiveInteger,
  refreshOfficialSettlement,
  requestedDate,
  requiredDate,
  strictPostmortemBody,
} from "./shared";

const router: IRouter = Router();

router.post("/analyst/settlements/automate", async (req, res, next) => {
  try {
    res.status(201).json(await automateSettlementDate(requiredDate(req.query.date)));
  } catch (error) {
    if (error instanceof SettlementValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

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

export default router;
