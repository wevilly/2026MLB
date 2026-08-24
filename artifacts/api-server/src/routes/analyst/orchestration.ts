/**
 * The daily pipeline, operator sessions and late scratches.
 *
 * Split out of routes/analyst.ts by remediation task 5.2. A PURE MOVE: every
 * handler below is byte-identical to the one that was in that file, mounted at
 * the same absolute path. No behaviour changed in the same commit.
 *
 * Routes in this module, in registration order:
 *   GET    /analyst/orchestration/runs
 *   POST   /analyst/orchestration/run
 *   POST   /analyst/orchestration/runs/:runId/interrupt
 *   POST   /analyst/orchestration/late-scratches
 *   POST   /analyst/operations/operator-session
 *   GET    /analyst/operations/operator-session
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
  issueOperationsApprovalSession,
  matchesOperatorApprovalKey,
  requestedDate,
  requiredDate,
} from "./shared";

const router: IRouter = Router();

// ─── Phase 9 – Operations, settlement automation, and derived exports ─────────

router.get("/analyst/orchestration/runs", async (req, res, next) => {
  try {
    const date = req.query.date == null ? undefined : requestedDate(req.query.date);
    const runs = await queryOrchestrationRuns(date);
    res.json({
      runs,
      total: runs.length,
      schedulePolicy: {
        timezone: "America/New_York",
        morningRefreshLocal: "08:00",
        snapshotFreeze: "90 minutes before the earliest scheduled first pitch",
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/orchestration/run", async (req, res, next) => {
  try {
    const run = await launchOrchestrationRun(requiredDate(req.query.date), "OPERATOR");
    res.status(202).json(run);
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/orchestration/runs/:runId/interrupt", async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.runId)) {
      res.status(400).json({ error: "runId must be a UUID" });
      return;
    }
    res.json(await interruptOrchestrationRun(req.params.runId));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/orchestration/late-scratches", async (req, res, next) => {
  try {
    res.status(201).json(await detectLateScratches(requiredDate(req.query.date)));
  } catch (error) {
    next(error);
  }
});

/**
 * NOT a duplicate of /analyst/ai/operator-session. This session lives in the
 * `operations_operator_approval` cookie namespace; the AI surface uses
 * `ai_operator_approval`. See the note on that route.
 */
router.post("/analyst/operations/operator-session", (req, res) => {
  const secret = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
  if (!secret) return res.status(503).json({ error: "Operator approval is unavailable until the server approval key is configured." });
  if (!matchesOperatorApprovalKey(req.body?.approvalKey, secret)) return res.status(403).json({ error: "Invalid operator approval key." });
  issueOperationsApprovalSession(res, secret);
  return res.json({ operatorId: "OPERATIONS_OPERATOR", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
});

router.get("/analyst/operations/operator-session", (req, res) => {
  const secret = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
  const rawCookie = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("operations_operator_approval="))?.slice("operations_operator_approval=".length);
  const [payload, signature] = rawCookie?.split(".") ?? [];
  const expectedSignature = payload && secret ? createHmac("sha256", secret).update(payload).digest("base64url") : "";
  try {
    const session = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as { capability?: unknown; expiresAt?: unknown };
    const authorized = Boolean(payload && signature && matchesOperatorApprovalKey(signature, expectedSignature) && session.capability === "OPERATIONS" && typeof session.expiresAt === "number" && session.expiresAt > Date.now());
    res.json({ authorized, expiresAt: authorized ? new Date(session.expiresAt as number).toISOString() : null, detail: authorized ? "Operator approval is active." : "Unlock before starting, refreshing, interrupting, or scanning a slate." });
  } catch {
    res.json({ authorized: false, expiresAt: null, detail: "Unlock before starting, refreshing, interrupting, or scanning a slate." });
  }
});

export default router;
