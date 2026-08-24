/**
 * The AI research surface: drafts, sourcing register, tool gateway, operator session.
 *
 * Split out of routes/analyst.ts by remediation task 5.2. A PURE MOVE: every
 * handler below is byte-identical to the one that was in that file, mounted at
 * the same absolute path. No behaviour changed in the same commit.
 *
 * Routes in this module, in registration order:
 *   GET    /analyst/ai/tool-registry
 *   POST   /analyst/ai/tool-call
 *   POST   /analyst/ai/operator-session
 *   GET    /analyst/ai/operator-session
 *   POST   /analyst/ai/chat
 *   GET    /analyst/ai/drafts
 *   POST   /analyst/ai/drafts
 *   POST   /analyst/ai/drafts/:draftId/approve
 *   POST   /analyst/ai/drafts/:draftId/reject
 *   GET    /analyst/ai/sourcing-register
 *   PATCH  /analyst/ai/sourcing-register/:claimId
 *   GET    /analyst/ai/research-notes
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
  APPROVAL_OPERATOR_ID,
  aiWorkflowErrorResponse,
  hasOperatorApprovalCapability,
  issueOperatorApprovalSession,
  matchesOperatorApprovalKey,
} from "./shared";

const router: IRouter = Router();

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

/**
 * NOT a duplicate of /analyst/operations/operator-session.
 *
 * The remediation plan flagged these two as the same endpoint under two paths
 * and asked for one to be removed or made an explicit alias. They are not the
 * same endpoint: this one issues and reads the `ai_operator_approval` cookie,
 * the operations one issues and reads `operations_operator_approval`. They are
 * two separate approval sessions in two separate cookie namespaces, and
 * collapsing them would silently grant an AI-surface approval to the operations
 * surface and the reverse.
 *
 * Both are kept, and each says why the other exists.
 */
router.post("/analyst/ai/operator-session", (req, res) => {
  const secret = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
  if (!secret) {
    res.status(503).json({ error: "Operator approval is unavailable until AI_ANALYST_OPERATOR_APPROVAL_KEY is configured." });
    return;
  }
  if (!matchesOperatorApprovalKey(req.body?.approvalKey, secret)) {
    res.status(403).json({ error: "Invalid operator approval key." });
    return;
  }
  issueOperatorApprovalSession(res, secret);
  res.json({ operatorId: APPROVAL_OPERATOR_ID, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
});

router.get("/analyst/ai/operator-session", (req, res) => {
  const secret = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
  const rawCookie = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("ai_operator_approval="))?.slice("ai_operator_approval=".length);
  const [payload, signature] = rawCookie?.split(".") ?? [];
  const expectedSignature = payload && secret ? createHmac("sha256", secret).update(payload).digest("base64url") : "";
  try {
    const session = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as { operatorId?: unknown; capability?: unknown; expiresAt?: unknown };
    const authorized = Boolean(payload && signature && matchesOperatorApprovalKey(signature, expectedSignature) && session.operatorId === APPROVAL_OPERATOR_ID && session.capability === "AI_REVIEW" && typeof session.expiresAt === "number" && session.expiresAt > Date.now());
    res.json({ authorized, expiresAt: authorized ? new Date(session.expiresAt as number).toISOString() : null, detail: authorized ? "AI review approval is active." : "Unlock before taking an AI review action." });
  } catch {
    res.json({ authorized: false, expiresAt: null, detail: "Unlock before taking an AI review action." });
  }
});

router.post("/analyst/ai/chat", async (req, res, next) => {
  try {
    const parsed = ChatWithAnalystAiBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid AI chat payload: sessionId and message are required." });
      return;
    }
    const chat = await runAiAnalystChat({ sessionId: parsed.data.sessionId, message: parsed.data.message, requestId: String(req.id) });
    res.json(ChatWithAnalystAiResponse.parse(chat));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    req.log.error({ err: error, requestId: req.id }, "AI Analyst chat request failed");
    res.status(502).json({ error: "AI Analyst chat is temporarily unavailable.", requestId: req.id });
  }
});

router.get("/analyst/ai/drafts", async (req, res, next) => {
  try {
    const parsed = GetAnalystAiDraftsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid AI draft filters." });
      return;
    }
    const drafts = await queryAiResearchDrafts(parsed.data);
    res.json(GetAnalystAiDraftsResponse.parse({ drafts, total: drafts.length }));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    next(error);
  }
});

router.post("/analyst/ai/drafts", async (req, res, next) => {
  try {
    const parsed = CreateAnalystAiDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid AI research draft payload." });
      return;
    }
    const draft = await createAiResearchDraft(parsed.data);
    res.status(201).json(CreateAnalystAiDraftResponse.parse(draft));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    next(error);
  }
});

router.post("/analyst/ai/drafts/:draftId/approve", async (req, res, next) => {
  try {
    const operatorName = hasOperatorApprovalCapability(req, res);
    if (!operatorName) return;
    const params = ApproveAnalystAiDraftParams.safeParse(req.params);
    const body = ApproveAnalystAiDraftBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid AI draft approval payload." });
      return;
    }
    const result = await reviewAiResearchDraft(params.data.draftId, { ...body.data, reviewedBy: operatorName }, "APPROVED");
    res.json(ApproveAnalystAiDraftResponse.parse(result));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    next(error);
  }
});

router.post("/analyst/ai/drafts/:draftId/reject", async (req, res, next) => {
  try {
    const operatorName = hasOperatorApprovalCapability(req, res);
    if (!operatorName) return;
    const params = RejectAnalystAiDraftParams.safeParse(req.params);
    const body = RejectAnalystAiDraftBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid AI draft rejection payload." });
      return;
    }
    const result = await reviewAiResearchDraft(params.data.draftId, { ...body.data, reviewedBy: operatorName }, "REJECTED");
    res.json(RejectAnalystAiDraftResponse.parse(result));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    next(error);
  }
});

router.get("/analyst/ai/sourcing-register", async (req, res, next) => {
  try {
    const parsed = GetAnalystAiSourcingRegisterQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid sourcing-register filters." });
      return;
    }
    const claims = await queryAiSourcingRegister(parsed.data);
    res.json(GetAnalystAiSourcingRegisterResponse.parse({ claims, total: claims.length }));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    next(error);
  }
});

router.patch("/analyst/ai/sourcing-register/:claimId", async (req, res, next) => {
  try {
    const operatorName = hasOperatorApprovalCapability(req, res);
    if (!operatorName) return;
    const params = DecideAnalystAiSourcingClaimParams.safeParse(req.params);
    const body = DecideAnalystAiSourcingClaimBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid sourcing-register decision." });
      return;
    }
    const claim = await decideAiSourcingClaim(params.data.claimId, { ...body.data, reviewedBy: operatorName });
    res.json(DecideAnalystAiSourcingClaimResponse.parse(claim));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    next(error);
  }
});

router.get("/analyst/ai/research-notes", async (req, res, next) => {
  try {
    const parsed = GetAnalystAiResearchNotesQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid approved-note filters." });
      return;
    }
    const notes = await queryResearchNotes(parsed.data);
    res.json(GetAnalystAiResearchNotesResponse.parse({ notes, total: notes.length }));
  } catch (error) {
    if (aiWorkflowErrorResponse(error, res)) return;
    next(error);
  }
});

export default router;
