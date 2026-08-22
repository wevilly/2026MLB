/**
 * Phase 8A – AI Analyst Read-Only Tool Layer
 *
 * Proves the gateway only exposes documented read tools, delegates to the
 * same read models used by the platform, and records both successful reads
 * and prohibited write attempts without mutating baseball state.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const API = "http://127.0.0.1:8080";
const DATE = "2030-07-04";
const SESSION_PREFIX = `phase-8a-acceptance-${process.pid}-${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const REQUIRED_TOOLS = [
  "READ_MARKET_BOARD",
  "READ_FEATURE_SNAPSHOTS",
  "READ_SETTLEMENT_RECORDS",
  "READ_BETTOR_PICKS",
  "READ_BULLPEN_STATE",
  "READ_PLAYER_RESEARCH",
  "READ_PITCHER_RESEARCH",
  "LIVE_WEB_SEARCH",
];

async function callTool(toolName, parameters, sessionId = `${SESSION_PREFIX}-read`) {
  const response = await fetch(`${API}/api/analyst/ai/tool-call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolName, parameters, sessionId }),
  });
  return { response, body: await response.json() };
}

after(async () => {
  await pool.end();
});

describe("Phase 8A – AI Analyst Read-Only Tool Layer", () => {
  test("documents the complete active read-only tool registry", async () => {
    const response = await fetch(`${API}/api/analyst/ai/tool-registry`);
    assert.equal(response.status, 200);
    const registry = await response.json();
    assert.deepEqual(
      registry.tools.map((tool) => tool.toolName).sort(),
      [...REQUIRED_TOOLS].sort(),
    );
    for (const tool of registry.tools) {
      assert.equal(tool.accessLevel, "READ_ONLY");
      assert.equal(tool.active, true);
      assert.ok(tool.dataSource.length > 0);
      assert.ok(tool.prohibitedActions.some((action) => /INSERT|UPDATE|DELETE/i.test(action)));
    }
  });

  test("returns internal reads through the same source-of-truth services without writes", async () => {
    const cases = [
      ["READ_MARKET_BOARD", { date: DATE }, `/api/analyst/market-board?date=${DATE}`, null, "entries"],
      ["READ_FEATURE_SNAPSHOTS", { dateFrom: DATE, dateTo: DATE, limit: 5 }, `/api/analyst/feature-store?dateFrom=${DATE}&dateTo=${DATE}&limit=5`, "snapshots", "snapshots"],
      ["READ_SETTLEMENT_RECORDS", { dateFrom: DATE, dateTo: DATE }, `/api/analyst/settlements?dateFrom=${DATE}&dateTo=${DATE}`, null, "settlements"],
      ["READ_BETTOR_PICKS", { date: DATE }, `/api/analyst/bettor/picks?date=${DATE}`, null, "picks"],
      ["READ_BULLPEN_STATE", { date: DATE }, `/api/analyst/bullpen-room?date=${DATE}`, "teams", "teams"],
      ["READ_PLAYER_RESEARCH", { date: DATE }, `/api/analyst/player-lab?date=${DATE}`, null, null],
      ["READ_PITCHER_RESEARCH", { date: DATE }, `/api/analyst/pitcher-lab?date=${DATE}`, null, null],
    ];
    for (const [toolName, parameters, canonicalPath, toolField, canonicalField] of cases) {
      const { response, body } = await callTool(toolName, parameters);
      assert.equal(response.status, 200, toolName);
      assert.equal(body.status, "SUCCESS", toolName);
      assert.ok(body.result && "data" in body.result, toolName);
      assert.match(body.callId, /^[0-9a-f-]{36}$/i);
      const canonicalResponse = await fetch(`${API}${canonicalPath}`);
      assert.equal(canonicalResponse.status, 200, `${toolName} canonical endpoint`);
      const canonical = await canonicalResponse.json();
      if (canonicalField) {
        const toolResult = toolField ? body.result.data[toolField] : body.result.data;
        assert.deepEqual(toolResult, canonical[canonicalField], `${toolName} uses the canonical read result`);
      } else {
        assert.deepEqual(body.result.data, canonical, `${toolName} uses the canonical read result`);
      }
    }

    const logs = await pool.query(
      `SELECT tool_name, status, parameters, response_summary, tool_definition, request_id
         FROM ai_tool_call_log
        WHERE session_id = $1
        ORDER BY called_at`,
      [`${SESSION_PREFIX}-read`],
    );
    assert.equal(logs.rows.length, cases.length);
    assert.ok(logs.rows.every((row) => row.status === "SUCCESS"));
    assert.ok(logs.rows.every((row) => row.parameters && row.response_summary));
    assert.ok(logs.rows.every((row) => row.tool_definition?.accessLevel === "READ_ONLY"));
    assert.ok(logs.rows.every((row) => /^\d+$/.test(row.request_id)));
  });

  test("rejects and audits a write-like operation with a clear error", async () => {
    const { response, body } = await callTool(
      "UPDATE_MODEL_STATUS",
      { modelVersionId: "forbidden", status: "ACTIVE" },
      `${SESSION_PREFIX}-write`,
    );
    assert.equal(response.status, 400);
    assert.equal(body.status, "REJECTED");
    assert.match(body.error, /not an active READ_ONLY tool|Write operations are prohibited/i);

    const log = await pool.query(
      `SELECT status, tool_name, parameters, rejection_reason
         FROM ai_tool_call_log
        WHERE call_id = $1`,
      [body.callId],
    );
    assert.equal(log.rows[0].status, "REJECTED");
    assert.equal(log.rows[0].tool_name, "UPDATE_MODEL_STATUS");
    assert.equal(log.rows[0].parameters.status, "ACTIVE");
    assert.match(log.rows[0].rejection_reason, /WRITE_ONLY|Write operations are prohibited|READ_ONLY/i);
  });

  test("rejects and audits malformed payloads and write-like extra parameters", async () => {
    const malformedResponse = await fetch(`${API}/api/analyst/ai/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolName: "READ_MARKET_BOARD", sessionId: `${SESSION_PREFIX}-malformed` }),
    });
    assert.equal(malformedResponse.status, 400);
    const malformed = await malformedResponse.json();
    assert.equal(malformed.status, "REJECTED");
    assert.match(malformed.callId, /^[0-9a-f-]{36}$/i);

    const strict = await callTool(
      "READ_MARKET_BOARD",
      { date: DATE, action: "DELETE" },
      `${SESSION_PREFIX}-strict`,
    );
    assert.equal(strict.response.status, 400);
    assert.equal(strict.body.status, "REJECTED");
    assert.match(strict.body.error, /Unsupported parameter|write instructions/i);

    const logs = await pool.query(
      `SELECT status, rejection_reason FROM ai_tool_call_log WHERE call_id = ANY($1::uuid[])`,
      [[malformed.callId, strict.body.callId]],
    );
    assert.equal(logs.rows.length, 2);
    assert.ok(logs.rows.every((row) => row.status === "REJECTED" && row.rejection_reason));
  });

  test("keeps audit records append-only at the database boundary", async () => {
    const { body } = await callTool("READ_MARKET_BOARD", { date: DATE }, `${SESSION_PREFIX}-immutable`);
    await assert.rejects(
      () => pool.query("UPDATE ai_tool_call_log SET session_id = 'tampered' WHERE call_id = $1", [body.callId]),
      /append-only/i,
    );
    await assert.rejects(
      () => pool.query("DELETE FROM ai_tool_call_log WHERE call_id = $1", [body.callId]),
      /append-only/i,
    );
    await assert.rejects(
      () => pool.query("TRUNCATE ai_tool_call_log"),
      /append-only|foreign key constraint/i,
    );
  });
});