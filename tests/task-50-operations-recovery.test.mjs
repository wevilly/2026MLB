import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

/**
 * The whole analyst route surface as one string.
 *
 * These assertions are about the route surface, not about which file holds it.
 * Task 5.2 split the 2,405-line routes/analyst.ts into domain modules and left
 * this file reading a path that is now only a mount barrel, so every assertion
 * against it silently stopped being checked. This test was in no script, so
 * nothing reported that. Reading the directory keeps the assertions true across
 * any future re-split.
 */
async function analystRoutes() {
  const dir = "artifacts/api-server/src/routes/analyst";
  const names = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  const modules = await Promise.all(names.map((name) => readFile(`${dir}/${name}`, "utf8")));
  return [await readFile("artifacts/api-server/src/routes/analyst.ts", "utf8"), ...modules].join("\n");
}

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
  // The freeze gate accepts WARNING prerequisites (warning-tolerant steps
  // legitimately finish as WARNING); only the health check must be SUCCESS.
  assert.match(source, /prerequisites\.some\(\(step\) => step\.status !== "SUCCESS" && step\.status !== "WARNING"\)/);
  assert.doesNotMatch(source, /lastScheduledDate/);
});

test("selected-date readiness and operator controls remain wired through contract and UI", async () => {
  const [routes, spec, app, server, roundRobin] = await Promise.all([
    analystRoutes(),
    readFile("lib/api-spec/openapi.yaml", "utf8"),
    readFile("artifacts/mlb-analyst/src/App.tsx", "utf8"),
    readFile("artifacts/api-server/src/app.ts", "utf8"),
    readFile("artifacts/mlb-analyst/src/pages/round-robin-page.tsx", "utf8"),
  ]);
  assert.match(routes, /selectedDate: date/);
  // Changed by 7b1171a "Expand data foundation service and refactor analyst
  // routes" (Replit Agent, 2026-08-24), which this assertion never ran to
  // notice because the file was in no test script.
  //
  // phase2aReady asserted research coverage (phaseTwoReady: handedness and
  // park) and now asserts that games and baseline candidates exist. Those are
  // different claims. phaseTwoReady still gates optionalEnrichmentReady, so
  // research coverage is still checked; phase2aReady no longer claims it.
  //
  // The same commit removed officialEmptySlate, and the slate the count reads
  // is populated by FantasyPros on the scheduled path: the daily pipeline's
  // only required steps are fantasypros_ingest and fantasypros_baseline, and
  // ingestMlbOfficial is not among them. Both are tracked as audit S18 and
  // S19 rather than changed here, because restoring either is a decision about
  // what the readiness contract should assert, not a test fix.
  assert.match(routes, /phase2aReady: baselineReady/);

  // The slate count is source-agnostic: it counts games rows whoever wrote
  // them. Pinned so that if the query ever starts filtering by source, or
  // stops counting games at all, this fails rather than drifting. Which
  // sources may write those rows is audit S18.
  assert.match(routes, /AS games FROM games WHERE game_date = \$1/);
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
test("the queued freeze executes under the same gate that queued it", async () => {
  // The main pipeline queues the freeze once health_check is SUCCESS, with
  // warning-tolerant steps allowed to persist as WARNING. The scheduler's
  // executeDueFreeze re-check previously demanded SUCCESS from every step,
  // so every queued freeze on a real run (which always carries WARNING
  // steps, e.g. disclosed provider absences) hung PENDING forever and the
  // slate never left "latest workflow is running".
  const orchestration = await readFile("artifacts/api-server/src/services/orchestration.ts", "utf8");
  assert.match(
    orchestration,
    /const health = run\.steps\.find\(\(step\) => step\.name === "health_check"\);\s+if \(!freeze \|\| health\?\.status !== "SUCCESS"\) return;/,
    "the health check must remain the freeze authority in the scheduler path",
  );
  assert.match(
    orchestration,
    /prerequisites\.some\(\(step\) => step\.status !== "SUCCESS" && step\.status !== "WARNING"\)/,
    "warning-tolerant prerequisites must not park the freeze forever",
  );
});
