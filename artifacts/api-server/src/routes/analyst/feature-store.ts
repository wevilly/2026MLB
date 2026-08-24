/**
 * Frozen pregame feature vectors: capture, backfill, correction, outcomes.
 *
 * Split out of routes/analyst.ts by remediation task 5.2. A PURE MOVE: every
 * handler below is byte-identical to the one that was in that file, mounted at
 * the same absolute path. No behaviour changed in the same commit.
 *
 * Routes in this module, in registration order:
 *   GET    /analyst/feature-store
 *   POST   /analyst/feature-store/capture
 *   POST   /analyst/feature-store/backfill
 *   POST   /analyst/feature-store/correct
 *   POST   /analyst/feature-store/outcome
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
  dateOnly,
  requestedDate,
} from "./shared";

const router: IRouter = Router();

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
      correctionReason as import("../../services/feature-store").CorrectionReason,
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

export default router;
