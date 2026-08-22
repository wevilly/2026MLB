/**
 * Phase 8B – AI Analyst workflows and sourcing register acceptance.
 *
 * Exercises the operator-facing review lifecycle and verifies that AI-context
 * writes are blocked at the database boundary for official data domains.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const API = "http://127.0.0.1:8080";
const SESSION_ID = `phase-8b-acceptance-${process.pid}-${Date.now()}`;
const APPROVAL_KEY = process.env.AI_ANALYST_OPERATOR_APPROVAL_KEY;
let approvalCookie = "";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

after(async () => {
  await pool.end();
});

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(approvalCookie ? { cookie: approvalCookie } : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  const body = await response.json();
  return { response, body };
}

describe("Phase 8B AI analyst workflows", () => {
  test("requires an operator approval capability to make review decisions", async () => {
    const created = await request("/api/analyst/ai/drafts", {
      method: "POST",
      body: JSON.stringify({ sessionId: SESSION_ID, draftContent: "Draft reserved for approval-capability test." }),
    });
    assert.equal(created.response.status, 201);
    const response = await fetch(`${API}/api/analyst/ai/drafts/${created.body.draftId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewedBy: "operator-phase-8b" }),
    });
    assert.equal(response.status, 403);
  });

  test("keeps AI drafts out of approved notes until a human approves them", async () => {
    const session = await request("/api/analyst/ai/operator-session", {
      method: "POST",
      body: JSON.stringify({ approvalKey: APPROVAL_KEY }),
    });
    assert.equal(session.response.status, 200);
    approvalCookie = session.response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const before = await request(`/api/analyst/ai/research-notes?sessionId=${encodeURIComponent(SESSION_ID)}`);
    assert.equal(before.response.status, 200);
    assert.equal(before.body.total, 0);

    const created = await request("/api/analyst/ai/drafts", {
      method: "POST",
      body: JSON.stringify({
        sessionId: SESSION_ID,
        market: "HOME_RUN",
        draftContent: "AI draft: verify current lineup and pitcher matchup before any official research use.",
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, "DRAFT");

    const forgedReviewer = await request(`/api/analyst/ai/drafts/${created.body.draftId}/approve`, {
      method: "POST",
      body: JSON.stringify({ reviewedBy: "AI_ANALYST" }),
    });
    assert.equal(forgedReviewer.response.status, 200);
    assert.equal(forgedReviewer.body.draft.reviewedBy, "AI_REVIEW_OPERATOR");

    const notes = await request(`/api/analyst/ai/research-notes?sessionId=${encodeURIComponent(SESSION_ID)}`);
    assert.equal(notes.response.status, 200);
    assert.equal(notes.body.total, 1);
    assert.equal(notes.body.notes[0].draftId, created.body.draftId);
    assert.equal(notes.body.notes[0].approvedBy, "AI_REVIEW_OPERATOR");
  });

  test("records web claims in the sourcing register and supports operator decisions", async () => {
    const tool = await request("/api/analyst/ai/tool-call", {
      method: "POST",
      body: JSON.stringify({
        toolName: "LIVE_WEB_SEARCH",
        parameters: { query: "MLB official injury report", limit: 3 },
        sessionId: SESSION_ID,
      }),
    });
    assert.equal(tool.response.status, 200);
    assert.equal(tool.body.status, "SUCCESS");
    assert.ok(tool.body.result.sourcingClaimIds.length > 0, "web search produces reviewable source claims");

    const register = await request(`/api/analyst/ai/sourcing-register?sessionId=${encodeURIComponent(SESSION_ID)}`);
    assert.equal(register.response.status, 200);
    assert.ok(register.body.total > 0);
    const claim = register.body.claims[0];
    assert.equal(claim.sourceType, "WEB");
    assert.equal(claim.accepted, null);

    const pendingDraft = await request("/api/analyst/ai/drafts", {
      method: "POST",
      body: JSON.stringify({ sessionId: SESSION_ID, draftContent: "Draft with a pending web claim.", sourceClaimIds: [claim.claimId] }),
    });
    assert.equal(pendingDraft.response.status, 201);
    const pendingApproval = await request(`/api/analyst/ai/drafts/${pendingDraft.body.draftId}/approve`, {
      method: "POST",
      body: JSON.stringify({ reviewedBy: "forged reviewer" }),
    });
    assert.equal(pendingApproval.response.status, 400);
    assert.match(pendingApproval.body.error, /source claims must be accepted/i);

    const unknownClaimDraft = await request("/api/analyst/ai/drafts", {
      method: "POST",
      body: JSON.stringify({ sessionId: SESSION_ID, draftContent: "Draft with an unknown claim.", sourceClaimIds: ["00000000-0000-4000-8000-000000000000"] }),
    });
    assert.equal(unknownClaimDraft.response.status, 400);

    const otherSession = `${SESSION_ID}-other`;
    const otherTool = await request("/api/analyst/ai/tool-call", {
      method: "POST",
      body: JSON.stringify({ toolName: "LIVE_WEB_SEARCH", parameters: { query: "MLB roster report", limit: 1 }, sessionId: otherSession }),
    });
    assert.equal(otherTool.response.status, 200);
    const crossSessionDraft = await request("/api/analyst/ai/drafts", {
      method: "POST",
      body: JSON.stringify({ sessionId: SESSION_ID, draftContent: "Draft with another session's claim.", sourceClaimIds: [otherTool.body.result.sourcingClaimIds[0]] }),
    });
    assert.equal(crossSessionDraft.response.status, 400);

    const decision = await request(`/api/analyst/ai/sourcing-register/${claim.claimId}`, {
      method: "PATCH",
      body: JSON.stringify({
        accepted: false,
        reviewedBy: "operator-phase-8b",
        rejectionReason: "Source is not sufficiently specific for the slate.",
        operatorNote: "Use the official club release if the claim is needed.",
      }),
    });
    assert.equal(decision.response.status, 200);
    assert.equal(decision.body.accepted, false);
    assert.equal(decision.body.reviewedBy, "AI_REVIEW_OPERATOR");
    assert.match(decision.body.rejectionReason, /not sufficiently specific/i);

    const rejectedApproval = await request(`/api/analyst/ai/drafts/${pendingDraft.body.draftId}/approve`, {
      method: "POST",
      body: JSON.stringify({ reviewedBy: "forged reviewer" }),
    });
    assert.equal(rejectedApproval.response.status, 400);
    assert.match(rejectedApproval.body.error, /source claims must be accepted/i);

    const secondDecision = await request(`/api/analyst/ai/sourcing-register/${claim.claimId}`, {
      method: "PATCH",
      body: JSON.stringify({ accepted: true, reviewedBy: "operator-phase-8b" }),
    });
    assert.equal(secondDecision.response.status, 400);
  });

  test("rejects AI-context writes to approved research, frozen research, settlement, market board, and models", async () => {
    const draft = await pool.query(
      `SELECT draft_id FROM ai_research_drafts WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [SESSION_ID],
    );
    assert.ok(draft.rows[0]?.draft_id);
    async function expectAiWriteRejected(query, values, pattern) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL app.writer_context = 'AI'");
        await assert.rejects(() => client.query(query, values), pattern);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }

    await expectAiWriteRejected(
          `INSERT INTO research_notes (draft_id, session_id, note_content, approved_by)
           VALUES ($1, 'ai-direct-write', 'prohibited direct AI approved note', 'AI_ANALYST')`,
      [draft.rows[0].draft_id],
      /AI writers cannot create or change human-approved research notes/i,
    );
    await expectAiWriteRejected(
      "INSERT INTO research_files DEFAULT VALUES",
      [],
      /AI writers cannot write frozen research, market board, or model records/i,
    );
    await expectAiWriteRejected(
      "INSERT INTO daily_market_board DEFAULT VALUES",
      [],
      /AI writers cannot write frozen research, market board, or model records/i,
    );
    await expectAiWriteRejected(
          `INSERT INTO historical_outcomes
             (player_id, game_pk, slate_date, market, outcome_value, outcome_hit, source_id)
           VALUES (999999999, 999999999, '2030-01-01', 'TOTAL_BASES_2_PLUS', 0, false, 'MLB_OFFICIAL')`,
      [],
      /AI writers cannot write settlement or postmortem tables/i,
    );
    await expectAiWriteRejected(
      "INSERT INTO model_versions DEFAULT VALUES",
      [],
      /AI writers cannot write frozen research, market board, or model records/i,
    );
  });
});