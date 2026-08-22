import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const API = "http://127.0.0.1:8080/api";
const date = new Date().toISOString().slice(0, 10);

async function json(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  return { response, body: await response.json() };
}

test("Phase 9A persists an orchestration ledger and exposes its operating policy", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const table = await pool.query(`SELECT to_regclass('public.orchestration_runs') AS table_name`);
    assert.equal(table.rows[0].table_name, "orchestration_runs");
    const response = await json(`/analyst/orchestration/runs?date=${date}`);
    assert.equal(response.response.status, 200);
    assert.equal(response.body.schedulePolicy.snapshotFreeze, "90 minutes before the earliest scheduled first pitch");
    assert.ok(Array.isArray(response.body.runs));
  } finally {
    await pool.end();
  }
});

test("Phase 9B exports derived platform records without claiming they replace the official platform", async () => {
  const slate = await json(`/analyst/export/slate-json?date=${date}`);
  assert.equal(slate.response.status, 200);
  assert.equal(slate.body.officialRecord, "MLB Analyst Platform");
  assert.equal(slate.body.slateDate, date);
  assert.ok(Array.isArray(slate.body.games));
  assert.ok(Array.isArray(slate.body.marketBoard));

  const workbook = await fetch(`${API}/analyst/export/workbook?date=${date}`);
  const workbookText = await workbook.text();
  assert.equal(workbook.status, 200);
  assert.match(workbook.headers.get("content-type") ?? "", /application\/vnd\.ms-excel/i);
  assert.match(workbookText, /Worksheet ss:Name="XBH"/);
  assert.match(workbookText, /Official record/);
});

test("Phase 10 health and audit responses are safe operational read models", async () => {
  const health = await json("/healthz");
  assert.ok([200, 503].includes(health.response.status));
  assert.ok(health.response.headers.get("x-request-id"));
  assert.ok(!JSON.stringify(health.body).includes("DATABASE_URL"));

  const audit = await json("/analyst/audit-events?limit=10");
  assert.equal(audit.response.status, 200);
  assert.ok(Array.isArray(audit.body.events));
});

test("Phase 9A makes a queued interruption terminal without allowing a future freeze", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const steps = [
      { name: "mlb_ingest", status: "SUCCESS", startedAt: null, finishedAt: null, detail: "fixture" },
      { name: "feature_snapshot_freeze", status: "PENDING", startedAt: null, finishedAt: null, detail: "fixture" },
    ];
    const inserted = await pool.query(
      `INSERT INTO orchestration_runs (run_date, triggered_by, overall_status, steps, schedule)
       VALUES ($1, 'OPERATOR', 'RUNNING', $2::jsonb, $3::jsonb) RETURNING run_id`,
      [date, JSON.stringify(steps), JSON.stringify({ calculatedFreezeUtc: new Date(Date.now() + 60_000).toISOString() })],
    );
    const runId = inserted.rows[0].run_id;
    const interrupted = await json(`/analyst/orchestration/runs/${runId}/interrupt`, { method: "POST" });
    assert.equal(interrupted.response.status, 200);
    assert.equal(interrupted.body.overallStatus, "CANCELLED");
    assert.equal(interrupted.body.frozenAt, null);
    assert.ok(interrupted.body.steps.every((step) => step.status !== "PENDING"));
  } finally {
    await pool.end();
  }
});

test("Phase 9A preserves completed run history when an operator retries interruption", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const inserted = await pool.query(
      `INSERT INTO orchestration_runs (run_date, triggered_by, overall_status, steps, schedule, finished_at)
       VALUES ($1, 'OPERATOR', 'COMPLETE', '[]'::jsonb, '{}'::jsonb, now()) RETURNING run_id`,
      [date],
    );
    const interrupted = await json(`/analyst/orchestration/runs/${inserted.rows[0].run_id}/interrupt`, { method: "POST" });
    assert.equal(interrupted.response.status, 200);
    assert.equal(interrupted.body.overallStatus, "COMPLETE");
    assert.equal(interrupted.body.cancelRequestedAt, null);
  } finally {
    await pool.end();
  }
});

test("Phase 10 audit events are immutable at the database boundary", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const inserted = await pool.query(
      `INSERT INTO audit_events (actor, action, resource_type, metadata)
       VALUES ('TEST', 'acceptance.audit_immutability', 'test', '{}'::jsonb) RETURNING audit_event_id`,
    );
    const id = inserted.rows[0].audit_event_id;
    await assert.rejects(
      () => pool.query(`UPDATE audit_events SET actor = 'MUTATED' WHERE audit_event_id = $1`, [id]),
      /append-only/i,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM audit_events WHERE audit_event_id = $1`, [id]),
      /append-only/i,
    );
    await assert.rejects(
      () => pool.query(`TRUNCATE audit_events`),
      /append-only/i,
    );
  } finally {
    await pool.end();
  }
});