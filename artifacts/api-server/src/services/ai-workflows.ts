import OpenAI from "openai";
import { pool } from "@workspace/db";
import { executeAiToolCall } from "./ai-tool-gateway";

export type AiDraftStatus = "DRAFT" | "APPROVED" | "REJECTED" | "WITHDRAWN";
export type AiSourcingSourceType = "WEB" | "INTERNAL_RESEARCH" | "BETTOR_PICK";

export class AiWorkflowValidationError extends Error {}

type DraftRow = {
  draft_id: string;
  session_id: string;
  player_id: number | null;
  market: string | null;
  draft_content: string;
  status: AiDraftStatus;
  source_claim_ids: unknown;
  created_at: Date | string;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  rejection_reason: string | null;
};

type ClaimRow = {
  claim_id: string;
  session_id: string;
  tool_call_id: string | null;
  claim_text: string;
  source_url_or_description: string;
  source_type: AiSourcingSourceType;
  accepted: boolean | null;
  rejection_reason: string | null;
  operator_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  created_at: Date | string;
};

function iso(value: Date | string | null) {
  return value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDraft(row: DraftRow) {
  return {
    draftId: row.draft_id,
    sessionId: row.session_id,
    playerId: row.player_id,
    market: row.market,
    draftContent: row.draft_content,
    status: row.status,
    sourceClaimIds: Array.isArray(row.source_claim_ids) ? row.source_claim_ids : [],
    createdAt: iso(row.created_at),
    reviewedBy: row.reviewed_by,
    reviewedAt: iso(row.reviewed_at),
    rejectionReason: row.rejection_reason,
  };
}

function toClaim(row: ClaimRow) {
  return {
    claimId: row.claim_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    claimText: row.claim_text,
    sourceUrlOrDescription: row.source_url_or_description,
    sourceType: row.source_type,
    accepted: row.accepted,
    rejectionReason: row.rejection_reason,
    operatorNote: row.operator_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at),
  };
}

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new AiWorkflowValidationError(`${field} is required and must be at most ${maximum} characters`);
  }
  return value.trim();
}

function optionalPlayerId(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AiWorkflowValidationError("playerId must be a positive integer");
  }
  return parsed;
}

function optionalMarket(value: unknown) {
  if (value == null || value === "") return null;
  const market = String(value).trim().toUpperCase();
  if (!["TOTAL_BASES_2_PLUS", "EXTRA_BASE_HIT", "BATTER_WALK", "HOME_RUN"].includes(market)) {
    throw new AiWorkflowValidationError("market must be TOTAL_BASES_2_PLUS, EXTRA_BASE_HIT, BATTER_WALK, or HOME_RUN");
  }
  return market;
}

function optionalClaimIds(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string")) {
    throw new AiWorkflowValidationError("sourceClaimIds must be an array of at most 50 IDs");
  }
  return value;
}

export async function createAiResearchDraft(input: {
  sessionId: unknown;
  playerId?: unknown;
  market?: unknown;
  draftContent: unknown;
  sourceClaimIds?: unknown;
}) {
  const sessionId = requiredText(input.sessionId, "sessionId", 160);
  const draftContent = requiredText(input.draftContent, "draftContent", 12000);
  const playerId = optionalPlayerId(input.playerId);
  const market = optionalMarket(input.market);
  const sourceClaimIds = optionalClaimIds(input.sourceClaimIds);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.writer_context = 'AI'");
    const result = await client.query<DraftRow>(
      `INSERT INTO ai_research_drafts
         (session_id, player_id, market, draft_content, source_claim_ids)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING draft_id, session_id, player_id, market, draft_content, status, source_claim_ids,
         created_at, reviewed_by, reviewed_at, rejection_reason`,
      [sessionId, playerId, market, draftContent, JSON.stringify(sourceClaimIds)],
    );
    await client.query("COMMIT");
    return toDraft(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryAiResearchDrafts(filters: { sessionId?: unknown; status?: unknown } = {}) {
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (filters.sessionId != null && filters.sessionId !== "") {
    values.push(requiredText(filters.sessionId, "sessionId", 160));
    clauses.push(`session_id = $${values.length}`);
  }
  if (filters.status != null && filters.status !== "") {
    const status = String(filters.status).trim().toUpperCase();
    if (!["DRAFT", "APPROVED", "REJECTED", "WITHDRAWN"].includes(status)) {
      throw new AiWorkflowValidationError("status must be DRAFT, APPROVED, REJECTED, or WITHDRAWN");
    }
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }
  const result = await pool.query<DraftRow>(
    `SELECT draft_id, session_id, player_id, market, draft_content, status, source_claim_ids,
       created_at, reviewed_by, reviewed_at, rejection_reason
     FROM ai_research_drafts
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT 200`,
    values,
  );
  return result.rows.map(toDraft);
}

function reviewedBy(value: unknown) {
  const reviewer = requiredText(value, "reviewedBy", 160);
  if (/^(ai|ai[_ -]?analyst|assistant|system)$/i.test(reviewer)) {
    throw new AiWorkflowValidationError("AI cannot approve or reject its own drafts");
  }
  return reviewer;
}

export async function reviewAiResearchDraft(
  draftId: string,
  input: { reviewedBy: unknown; rejectionReason?: unknown },
  decision: "APPROVED" | "REJECTED" | "WITHDRAWN",
) {
  const reviewer = reviewedBy(input.reviewedBy);
  const rejectionReason = input.rejectionReason == null ? null : requiredText(input.rejectionReason, "rejectionReason", 2000);
  if ((decision === "REJECTED" || decision === "WITHDRAWN") && !rejectionReason) {
    throw new AiWorkflowValidationError("rejectionReason is required for rejected or withdrawn drafts");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const draftResult = await client.query<DraftRow>(
      `SELECT draft_id, session_id, player_id, market, draft_content, status, source_claim_ids,
         created_at, reviewed_by, reviewed_at, rejection_reason
       FROM ai_research_drafts WHERE draft_id = $1 FOR UPDATE`,
      [draftId],
    );
    const draft = draftResult.rows[0];
    if (!draft) throw new AiWorkflowValidationError("draft not found");
    if (draft.status !== "DRAFT") throw new AiWorkflowValidationError(`draft is already ${draft.status}`);
    const now = new Date();
    if (decision === "APPROVED") {
      const noteResult = await client.query<{ note_id: string }>(
        `INSERT INTO research_notes
           (draft_id, session_id, player_id, market, note_content, source_claim_ids, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING note_id`,
        [
          draft.draft_id,
          draft.session_id,
          draft.player_id,
          draft.market,
          draft.draft_content,
          JSON.stringify(Array.isArray(draft.source_claim_ids) ? draft.source_claim_ids : []),
          reviewer,
          now,
        ],
      );
      await client.query(
        `UPDATE ai_research_drafts
         SET status = 'APPROVED', reviewed_by = $2, reviewed_at = $3, rejection_reason = NULL
         WHERE draft_id = $1`,
        [draft.draft_id, reviewer, now],
      );
      await client.query("COMMIT");
      return { draft: { ...toDraft(draft), status: "APPROVED", reviewedBy: reviewer, reviewedAt: now.toISOString(), rejectionReason: null }, noteId: noteResult.rows[0].note_id };
    }
    await client.query(
      `UPDATE ai_research_drafts
       SET status = $2, reviewed_by = $3, reviewed_at = $4, rejection_reason = $5
       WHERE draft_id = $1`,
      [draft.draft_id, decision, reviewer, now, rejectionReason],
    );
    await client.query("COMMIT");
    return { draft: { ...toDraft(draft), status: decision, reviewedBy: reviewer, reviewedAt: now.toISOString(), rejectionReason }, noteId: null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryResearchNotes(filters: { sessionId?: unknown; playerId?: unknown } = {}) {
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (filters.sessionId != null && filters.sessionId !== "") {
    values.push(requiredText(filters.sessionId, "sessionId", 160));
    clauses.push(`session_id = $${values.length}`);
  }
  if (filters.playerId != null && filters.playerId !== "") {
    values.push(optionalPlayerId(filters.playerId));
    clauses.push(`player_id = $${values.length}`);
  }
  const result = await pool.query(
    `SELECT note_id, draft_id, session_id, player_id, market, note_content, source_type,
       source_claim_ids, approved_by, approved_at, created_at
     FROM research_notes ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY approved_at DESC LIMIT 200`,
    values,
  );
  return result.rows.map((row) => ({
    noteId: row.note_id,
    draftId: row.draft_id,
    sessionId: row.session_id,
    playerId: row.player_id,
    market: row.market,
    noteContent: row.note_content,
    sourceType: row.source_type,
    sourceClaimIds: Array.isArray(row.source_claim_ids) ? row.source_claim_ids : [],
    approvedBy: row.approved_by,
    approvedAt: iso(row.approved_at),
    createdAt: iso(row.created_at),
  }));
}

export async function queryAiSourcingRegister(filters: { sessionId?: unknown; accepted?: unknown } = {}) {
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (filters.sessionId != null && filters.sessionId !== "") {
    values.push(requiredText(filters.sessionId, "sessionId", 160));
    clauses.push(`session_id = $${values.length}`);
  }
  if (filters.accepted != null && filters.accepted !== "") {
    const accepted = String(filters.accepted).toLowerCase();
    if (!["true", "false", "pending"].includes(accepted)) {
      throw new AiWorkflowValidationError("accepted must be true, false, or pending");
    }
    if (accepted === "pending") clauses.push("accepted IS NULL");
    else {
      values.push(accepted === "true");
      clauses.push(`accepted = $${values.length}`);
    }
  }
  const result = await pool.query<ClaimRow>(
    `SELECT claim_id, session_id, tool_call_id, claim_text, source_url_or_description, source_type,
       accepted, rejection_reason, operator_note, reviewed_by, reviewed_at, created_at
     FROM ai_sourcing_register ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT 300`,
    values,
  );
  return result.rows.map(toClaim);
}

export async function decideAiSourcingClaim(
  claimId: string,
  input: { accepted: unknown; reviewedBy: unknown; rejectionReason?: unknown; operatorNote?: unknown },
) {
  if (typeof input.accepted !== "boolean") throw new AiWorkflowValidationError("accepted must be true or false");
  const reviewer = reviewedBy(input.reviewedBy);
  const rejectionReason = input.accepted
    ? null
    : requiredText(input.rejectionReason, "rejectionReason", 2000);
  const operatorNote = input.operatorNote == null ? null : requiredText(input.operatorNote, "operatorNote", 2000);
  const result = await pool.query<ClaimRow>(
    `UPDATE ai_sourcing_register
     SET accepted = $2, reviewed_by = $3, reviewed_at = now(), rejection_reason = $4, operator_note = $5
     WHERE claim_id = $1 AND accepted IS NULL
     RETURNING claim_id, session_id, tool_call_id, claim_text, source_url_or_description, source_type,
       accepted, rejection_reason, operator_note, reviewed_by, reviewed_at, created_at`,
    [claimId, input.accepted, reviewer, rejectionReason, operatorNote],
  );
  if (!result.rows[0]) throw new AiWorkflowValidationError("claim not found or already decided");
  return toClaim(result.rows[0]);
}

function selectedTool(message: string) {
  const normalized = message.toLowerCase();
  if (/\b(web|news|latest|source|research|search|injury|report)\b/.test(normalized)) {
    return { toolName: "LIVE_WEB_SEARCH", parameters: { query: message.slice(0, 300), limit: 5 } };
  }
  if (/\b(bullpen|reliever|relief)\b/.test(normalized)) {
    return { toolName: "READ_BULLPEN_STATE", parameters: { date: new Date().toISOString().slice(0, 10) } };
  }
  if (/\b(pick|bettor|capper)\b/.test(normalized)) {
    return { toolName: "READ_BETTOR_PICKS", parameters: { date: new Date().toISOString().slice(0, 10) } };
  }
  if (/\b(settle|settlement|result|outcome)\b/.test(normalized)) {
    return { toolName: "READ_SETTLEMENT_RECORDS", parameters: { dateFrom: new Date().toISOString().slice(0, 10), dateTo: new Date().toISOString().slice(0, 10) } };
  }
  if (/\b(feature|snapshot|evidence)\b/.test(normalized)) {
    return { toolName: "READ_FEATURE_SNAPSHOTS", parameters: { dateFrom: new Date().toISOString().slice(0, 10), dateTo: new Date().toISOString().slice(0, 10), limit: 20 } };
  }
  return { toolName: "READ_MARKET_BOARD", parameters: { date: new Date().toISOString().slice(0, 10) } };
}

function openAiClient() {
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) throw new Error("Managed OpenAI integration is not configured");
  return new OpenAI({ baseURL, apiKey });
}

export async function runAiAnalystChat(input: { sessionId: unknown; message: unknown; requestId: string }) {
  const sessionId = requiredText(input.sessionId, "sessionId", 160);
  const message = requiredText(input.message, "message", 4000);
  const selected = selectedTool(message);
  const toolResult = await executeAiToolCall({
    toolName: selected.toolName,
    parameters: selected.parameters,
    sessionId,
    requestId: input.requestId,
  });
  if (toolResult.status !== "SUCCESS" || !toolResult.result) {
    throw new AiWorkflowValidationError("The requested read tool did not return evidence for this AI response");
  }
  const client = openAiClient();
  const response = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    max_completion_tokens: 1200,
    messages: [
      {
        role: "system",
        content: "You are the MLB Analyst assistant. You may only explain the JSON evidence returned by the platform tool. Do not invent stats, odds, recommendations, actions, or approvals. Clearly label missing, stale, or unverified information. If web results appear, tell the operator that each cited claim is unverified until reviewed in the sourcing register. Never say you wrote an official research record; draft notes require human approval.",
      },
      {
        role: "user",
        content: `Operator request: ${message}\n\nRead-only tool: ${selected.toolName}\nTool response JSON:\n${JSON.stringify(toolResult.result).slice(0, 24000)}`,
      },
    ],
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("AI provider returned an empty response");
  const sourcingClaimIds = toolResult.result && typeof toolResult.result === "object" && Array.isArray(toolResult.result.sourcingClaimIds)
    ? toolResult.result.sourcingClaimIds
    : [];
  return {
    sessionId,
    message,
    response: text,
    toolName: selected.toolName,
    toolCallId: toolResult.callId,
    toolStatus: toolResult.status,
    sourcingClaimIds,
    canCreateDraft: true,
  };
}
