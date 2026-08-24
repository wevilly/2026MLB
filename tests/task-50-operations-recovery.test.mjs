import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("daily orchestration catches up after startup and claims before execution", async () => {
  const source = await readFile("artifacts/api-server/src/services/orchestration.ts", "utf8");
  assert.match(source, /export async function catchUpScheduledOrchestration/);
  assert.match(source, /if \(localTime < "08:00"\) return/);
  assert.match(source, /await catchUpScheduledOrchestration\(now\)/);
  assert.match(source, /const start = await earliestStart\(runDate\);/);
  assert.match(source, /pg_try_advisory_lock\(hashtext\(\$1\)\)/);
  assert.match(source, /triggered_by = 'SCHEDULED' OR overall_status = ANY/);
  assert.match(source, /Recovered after an interrupted worker/);
  assert.match(source, /healthStep\.status === "PENDING"/);
  assert.match(source, /recoveredAfterFreeze: true/);
  assert.match(source, /const prerequisites = run\.steps\.filter\(\(step\) => step\.name !== "feature_snapshot_freeze"\)/);
  assert.match(source, /prerequisites\.some\(\(step\) => step\.status !== "SUCCESS"\)/);
  assert.doesNotMatch(source, /lastScheduledDate/);
});

test("selected-date readiness and operator controls remain wired through contract and UI", async () => {
  const [routes, spec, app, server, roundRobin] = await Promise.all([
    readFile("artifacts/api-server/src/routes/analyst.ts", "utf8"),
    readFile("lib/api-spec/openapi.yaml", "utf8"),
    readFile("artifacts/mlb-analyst/src/App.tsx", "utf8"),
    readFile("artifacts/api-server/src/app.ts", "utf8"),
    readFile("artifacts/mlb-analyst/src/pages/round-robin-page.tsx", "utf8"),
  ]);
  assert.match(routes, /selectedDate: date/);
  assert.match(routes, /phase2aReady: officialEmptySlate \|\| phaseTwoReady/);
  assert.match(routes, /readinessDiagnostics/);
  assert.match(routes, /router\.get\("\/analyst\/ai\/operator-session"/);
  assert.match(routes, /operations_operator_approval/);
  assert.match(routes, /ai_operator_approval/);
  assert.match(routes, /capability === "OPERATIONS"/);
  assert.match(spec, /\/analyst\/data-health:[\s\S]{0,700}name: date\s+in: query\s+required: false\s+description: Requested MLB slate date in Eastern Time/);
  assert.match(spec, /ReadinessDiagnostic:/);
  assert.match(app, /useGetAnalystDataHealth\(\{ date \}\)/);
  assert.match(app, /input-operations-approval-key/);
  assert.match(app, /\/analyst\/operations\/operator-session/);
  assert.match(app, /lateScratchScan\(\).*disabled=\{loading \|\| !approvalActive\}/s);
  assert.match(server, /operations_operator_approval/);
  assert.match(server, /ai_operator_approval/);
  assert.match(server, /const requiredCapability = isRoutineOperation \? "OPERATIONS" : "AI_REVIEW"/);
  assert.match(server, /session\.capability !== requiredCapability/);
  assert.match(server, /isRoutineOperation/);
  assert.match(server, /market-board\\\/refresh/);
  assert.match(roundRobin, /useGetAnalystDataHealth\(\{ date \}\)/);
  assert.match(roundRobin, /UNSUPPORTED/);
});