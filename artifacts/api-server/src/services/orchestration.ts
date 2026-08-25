import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { ingestFantasyPros, ingestMlbOfficial } from "./data-foundation";
import { ingestResearch, researchHealth } from "./research-foundation";
import { refreshBatterPitcherSlate } from "./batter-pitcher-research";
import { refreshBullpen } from "./bullpen-foundation";
import { refreshWeather } from "./weather-foundation";
import { runTBEngine } from "./tb-engine";
import { runXBHEngine } from "./xbh-engine";
import { runWALKEngine } from "./walk-engine";
import { runHREngine } from "./hr-engine";
import { runHRRBIEngine } from "./hrrbi-engine";
import { runFantasyProsBaseline } from "./fantasypros-baseline";
import { captureSlateSnapshots, correctSnapshot } from "./feature-store";
import { populateDailyMarketBoard } from "./daily-market-board";
import { recordAuditEvent } from "./audit";
import { createMarketPostmortem, settleOfficialDate } from "./settlement";
import { invalidateCache } from "./cache";

export type OrchestrationTrigger = "SCHEDULED" | "OPERATOR";
export type RunStepStatus = "PENDING" | "RUNNING" | "SUCCESS" | "WARNING" | "FAILED" | "CANCELLED";
export type RunStep = {
  name: string;
  status: RunStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
};

const STEP_NAMES = [
  "fantasypros_ingest", "fantasypros_baseline", "research_refresh", "bullpen_refresh",
  "weather_refresh", "slate_matchup_refresh", "tb_engine", "xbh_engine", "walk_engine", "hr_engine", "hrrbi_engine", "market_board",
  "health_check", "feature_snapshot_freeze",
] as const;

const activeRuns = new Set<string>();
let schedulerStarted = false;

// A finished partial run is intentionally retryable: it may contain a valid
// FantasyPros baseline while optional research was unavailable. Only work that
// is still executing may block an operator-triggered refresh.
const QUALIFYING_RUN_STATUSES = ["RUNNING"] as const;

/** Games scheduled on the slate. The denominator for every expected-volume check. */
async function scheduledGameCount(slateDate: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM games WHERE game_date = $1`,
    [slateDate],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function currentEasternDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function currentEasternTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("hour")}:${value("minute")}`;
}

function dateOnly(value: unknown) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("date must use YYYY-MM-DD");
  return text;
}

function initialSteps(): RunStep[] {
  return STEP_NAMES.map((name) => ({ name, status: "PENDING", startedAt: null, finishedAt: null, detail: null }));
}

function markPendingSkipped(steps: RunStep[], detail: string) {
  const now = new Date().toISOString();
  for (const step of steps) {
    if (step.status === "PENDING") {
      step.status = "CANCELLED";
      step.finishedAt = now;
      step.detail = detail;
    }
  }
}

function scheduleFor(slateDate: string, earliestStart: string | null) {
  const cutoff = earliestStart ? new Date(new Date(earliestStart).getTime() - 90 * 60_000).toISOString() : null;
  return {
    timezone: "America/New_York",
    morningRefreshLocal: "08:00",
    snapshotFreezePolicy: "90_MINUTES_BEFORE_EARLIEST_FIRST_PITCH",
    earliestFirstPitchUtc: earliestStart,
    calculatedFreezeUtc: cutoff,
    slateDate,
  };
}

async function earliestStart(slateDate: string) {
  const result = await pool.query<{ start_time_utc: string | null }>(
    `SELECT start_time_utc::text FROM games WHERE game_date = $1
     ORDER BY start_time_utc NULLS LAST LIMIT 1`,
    [slateDate],
  );
  return result.rows[0]?.start_time_utc ?? null;
}

async function persistSteps(runId: string, steps: RunStep[]) {
  await pool.query(`UPDATE orchestration_runs SET steps = $2::jsonb WHERE run_id = $1`, [runId, JSON.stringify(steps)]);
}

async function cancellationRequested(runId: string) {
  const result = await pool.query<{ cancel_requested_at: string | null }>(
    `SELECT cancel_requested_at::text FROM orchestration_runs WHERE run_id = $1`,
    [runId],
  );
  return Boolean(result.rows[0]?.cancel_requested_at);
}

async function runRequiredStep(runId: string, slateDate: string, steps: RunStep[], name: string, action: () => Promise<unknown>) {
  const ran = await runStep(runId, steps, name, action);
  if (!ran) {
    markPendingSkipped(steps, "Skipped because the run was interrupted");
    await finaliseRun(runId, slateDate, steps, "CANCELLED");
    return false;
  }
  if (failed(steps)) {
    markPendingSkipped(steps, "Skipped because a required step failed");
    await finaliseRun(runId, slateDate, steps, "FAILED");
    return false;
  }
  return true;
}

function responseDetail(value: unknown) {
  if (value && typeof value === "object" && "error" in value && (value as { error?: unknown }).error) {
    throw new Error(String((value as { error: unknown }).error));
  }
  if (value && typeof value === "object") {
    const summary = JSON.stringify(value);
    return summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
  }
  return "completed";
}

/**
 * Counts a step reports that describe how much work it actually did.
 *
 * A step that "completed with warnings" and a step that returned an empty
 * result were previously indistinguishable in the ledger: everything after the
 * baseline runs warning-tolerant, so a step that produced nothing on a day with
 * a real slate looked exactly like a step that produced everything.
 */
const PRODUCED_COUNT_KEYS = [
  "candidatesWritten", "candidatesProcessed", "appearancesNormalized",
  "modeledRows", "candidatesFound", "normalized", "rowCount",
] as const;

function producedCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of PRODUCED_COUNT_KEYS) {
    const count = record[key];
    if (typeof count === "number" && Number.isFinite(count)) return count;
  }
  return null;
}

/** A step's own reported status, when it reports one. */
function reportedStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

async function runStep(
  runId: string,
  steps: RunStep[],
  name: string,
  action: () => Promise<unknown>,
  warning = false,
  expectedSlateWork = 0,
) {
  const step = steps.find((candidate) => candidate.name === name)!;
  // A restart resumes from the persisted ledger. Completed work is never rerun.
  if (step.status === "SUCCESS" || step.status === "WARNING" || step.status === "FAILED") return true;
  if (await cancellationRequested(runId)) {
    step.status = "CANCELLED";
    step.finishedAt = new Date().toISOString();
    step.detail = "Interrupted by operator";
    await persistSteps(runId, steps);
    return false;
  }
  step.status = "RUNNING";
  step.startedAt = new Date().toISOString();
  await persistSteps(runId, steps);
  try {
    const result = await action();
    const detail = responseDetail(result);
    const produced = producedCount(result);
    const reported = reportedStatus(result);
    // A step that returned an empty result on a day with a real slate is at
    // least a WARNING, even in a warning-tolerant position, and the expected
    // versus actual counts are recorded in the step detail.
    const emptyOnRealSlate = produced === 0 && expectedSlateWork > 0;
    if (reported === "FAILED") {
      step.status = "FAILED";
    } else if (warning || reported === "PARTIAL" || emptyOnRealSlate) {
      step.status = "WARNING";
    } else {
      step.status = "SUCCESS";
    }
    step.detail = emptyOnRealSlate
      ? `${detail} | produced 0 with ${expectedSlateWork} scheduled game(s) on this slate`
      : detail;
  } catch (error) {
    step.status = "FAILED";
    step.detail = error instanceof Error ? error.message : String(error);
  }
  step.finishedAt = new Date().toISOString();
  await persistSteps(runId, steps);
  return true;
}

function failed(steps: RunStep[]) {
  return steps.some((step) => step.status === "FAILED");
}

async function finaliseRun(runId: string, slateDate: string, steps: RunStep[], status: "PARTIAL" | "FAILED" | "CANCELLED") {
  await persistSteps(runId, steps);
  await pool.query(
    `UPDATE orchestration_runs SET overall_status = $2::orchestration_status, finished_at = now(),
       error_message = $3 WHERE run_id = $1`,
    [runId, status, steps.filter((step) => step.status === "FAILED").map((step) => `${step.name}: ${step.detail}`).join("; ") || null],
  );
  await recordAuditEvent({ action: `orchestration.${status.toLowerCase()}`, resourceType: "orchestration_run", resourceId: runId, metadata: { slateDate } });
}

async function executeRun(runId: string, slateDate: string) {
  const executionClient = await pool.connect();
  const executionLock = `orchestration-execution:${runId}`;
  const claimed = await executionClient.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
    [executionLock],
  );
  if (!claimed.rows[0]?.locked) {
    executionClient.release();
    return;
  }
  activeRuns.add(runId);
  const persisted = await queryOrchestrationRun(runId);
  if (persisted.overallStatus !== "RUNNING") {
    await executionClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [executionLock]).catch(() => undefined);
    executionClient.release();
    activeRuns.delete(runId);
    return;
  }
  const steps = persisted.steps.map((step) => step.status === "RUNNING"
    ? { ...step, status: "PENDING" as const, startedAt: null, detail: "Recovered after an interrupted worker." }
    : { ...step });
  await persistSteps(runId, steps);
  try {
    if (!await runRequiredStep(runId, slateDate, steps, "fantasypros_ingest", () => ingestFantasyPros(slateDate))) return;
    if (!await runRequiredStep(runId, slateDate, steps, "fantasypros_baseline", () => runFantasyProsBaseline(slateDate))) return;
    const postIngestStart = await earliestStart(slateDate);
    await pool.query(`UPDATE orchestration_runs SET schedule = schedule || $2::jsonb WHERE run_id = $1`, [runId, JSON.stringify(scheduleFor(slateDate, postIngestStart))]);
    // FantasyPros establishes only the projected slate and reference context.
    // Independent research below creates the actual ranks; a source outage is
    // surfaced as PARTIAL rather than silently replaced by projection ordering.
    // How much work this slate should have produced. A warning-tolerant step
    // that returns nothing on a day with real games is recorded as a WARNING
    // with the expected versus actual counts, not as a clean pass.
    const scheduledGames = await scheduledGameCount(slateDate);
    await runStep(runId, steps, "research_refresh", () => ingestResearch(slateDate), true, scheduledGames);
    await runStep(runId, steps, "bullpen_refresh", () => refreshBullpen(slateDate), true, scheduledGames);
    // Weather must land before the engines: they read the slate's observations
    // and score a bounded weather term from them.
    await runStep(runId, steps, "weather_refresh", () => refreshWeather(slateDate), true, scheduledGames);
    await runStep(runId, steps, "slate_matchup_refresh", () => refreshBatterPitcherSlate(slateDate), true, scheduledGames);
    await runStep(runId, steps, "tb_engine", () => runTBEngine(slateDate), true, scheduledGames);
    await runStep(runId, steps, "xbh_engine", () => runXBHEngine(slateDate), true, scheduledGames);
    await runStep(runId, steps, "walk_engine", () => runWALKEngine(slateDate), true, scheduledGames);
    await runStep(runId, steps, "hr_engine", () => runHREngine(slateDate), true, scheduledGames);
    await runStep(runId, steps, "hrrbi_engine", () => runHRRBIEngine(slateDate), true, scheduledGames);
    await runStep(runId, steps, "market_board", () => populateDailyMarketBoard(slateDate), true, scheduledGames);
    if (await cancellationRequested(runId)) {
      markPendingSkipped(steps, "Skipped because the run was interrupted");
      await finaliseRun(runId, slateDate, steps, "CANCELLED");
      return;
    }
    const healthStep = steps.find((step) => step.name === "health_check")!;
    if (healthStep.status === "PENDING") {
      healthStep.status = "RUNNING";
      healthStep.startedAt = new Date().toISOString();
      await persistSteps(runId, steps);
      try {
        const health = await researchHealth(slateDate);
        const issues = Number(health.identityQuarantines ?? 0) + Number(health.metricDefinitionConflicts ?? 0)
          + Number(health.staleWindows ?? 0) + Number(health.identityOrEligibilityGaps ?? 0);
        healthStep.status = issues ? "WARNING" : "SUCCESS";
        healthStep.detail = issues ? `${issues} research or identity health warning(s)` : "freshness and identity coverage passed";
      } catch (error) {
        healthStep.status = "FAILED";
        healthStep.detail = error instanceof Error ? error.message : String(error);
      }
      healthStep.finishedAt = new Date().toISOString();
      await persistSteps(runId, steps);
    }
    if (healthStep.status !== "SUCCESS") { markPendingSkipped(steps, "Freeze blocked by health gate"); await finaliseRun(runId, slateDate, steps, "PARTIAL"); return; }
    const run = await queryOrchestrationRun(runId);
    const cutoff = typeof run.schedule.calculatedFreezeUtc === "string" ? Date.parse(run.schedule.calculatedFreezeUtc) : NaN;
    if (!Number.isFinite(cutoff) || Date.now() < cutoff) {
      const freeze = steps.find((step) => step.name === "feature_snapshot_freeze")!;
      freeze.detail = Number.isFinite(cutoff) ? `Queued for ${new Date(cutoff).toISOString()}` : "No first-pitch time available; freeze cannot be scheduled.";
      if (!Number.isFinite(cutoff)) { freeze.status = "FAILED"; await finaliseRun(runId, slateDate, steps, "PARTIAL"); return; }
      await persistSteps(runId, steps);
      await recordAuditEvent({ action: "orchestration.freeze_queued", resourceType: "orchestration_run", resourceId: runId, metadata: { slateDate, cutoff: new Date(cutoff).toISOString() } });
      return;
    }
    await executeDueFreeze(runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, runId, slateDate }, "daily orchestration failed unexpectedly");
    await pool.query(
      `UPDATE orchestration_runs SET overall_status = 'FAILED', finished_at = now(), error_message = $2 WHERE run_id = $1`,
      [runId, message],
    );
  } finally {
    invalidateCache("");
    activeRuns.delete(runId);
    await executionClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [executionLock]).catch(() => undefined);
    executionClient.release();
  }
}

async function executeDueFreeze(runId: string) {
  const client = await pool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [`orchestration-freeze:${runId}`]);
    if (!locked.rows[0]?.locked) return;
    const run = await queryOrchestrationRun(runId);
    if (run.cancelRequestedAt) {
      markPendingSkipped(run.steps, "Skipped because the run was interrupted");
      await finaliseRun(runId, run.runDate, run.steps, "CANCELLED");
      return;
    }
    const freeze = run.steps.find((step) => step.name === "feature_snapshot_freeze");
    const prerequisites = run.steps.filter((step) => step.name !== "feature_snapshot_freeze");
    if (!freeze || prerequisites.some((step) => step.status !== "SUCCESS")) return;
    if (freeze.status === "SUCCESS") {
      await pool.query(`UPDATE orchestration_runs SET overall_status = 'COMPLETE', frozen_at = COALESCE(frozen_at, now()), finished_at = now(), error_message = NULL WHERE run_id = $1`, [runId]);
      await recordAuditEvent({ action: "orchestration.complete", resourceType: "orchestration_run", resourceId: runId, metadata: { slateDate: run.runDate, recoveredAfterFreeze: true } });
      return;
    }
    if (freeze.status !== "PENDING") return;
    await runStep(runId, run.steps, "feature_snapshot_freeze", async () => {
      const capture = await captureSlateSnapshots(run.runDate);
      if (capture.error || capture.snapshotErrors > 0) {
        throw new Error(capture.error ?? `${capture.snapshotErrors} snapshot capture error(s) prevented freeze`);
      }
      if (capture.candidatesFound > 0 && capture.snapshotsWritten + capture.snapshotsSkipped < capture.candidatesFound) {
        throw new Error("Feature snapshot capture was incomplete; freeze was not recorded");
      }
      return capture;
    });
    if (await cancellationRequested(runId)) {
      markPendingSkipped(run.steps, "Skipped because the run was interrupted");
      const completedFreeze = run.steps.find((step) => step.name === "feature_snapshot_freeze");
      if (completedFreeze?.status === "SUCCESS") {
        completedFreeze.status = "CANCELLED";
        completedFreeze.detail = "Snapshot capture completed after interruption; freeze was not recorded";
      }
      await finaliseRun(runId, run.runDate, run.steps, "CANCELLED");
      return;
    }
    const step = run.steps.find((item) => item.name === "feature_snapshot_freeze")!;
    const status = step.status === "SUCCESS" ? "COMPLETE" : "PARTIAL";
    await pool.query(`UPDATE orchestration_runs SET overall_status = $2::orchestration_status, frozen_at = CASE WHEN $2 = 'COMPLETE' THEN now() ELSE NULL END, finished_at = now(), error_message = $3 WHERE run_id = $1`, [runId, status, step.detail]);
    await recordAuditEvent({ action: `orchestration.${status.toLowerCase()}`, resourceType: "orchestration_run", resourceId: runId, metadata: { slateDate: run.runDate } });
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`orchestration-freeze:${runId}`]).catch(() => undefined);
    client.release();
  }
}

export async function launchOrchestrationRun(rawDate: unknown, triggeredBy: OrchestrationTrigger = "OPERATOR") {
  const runDate = dateOnly(rawDate);
  const start = await earliestStart(runDate);
  const insert = (client: { query: <T>(text: string, values?: unknown[]) => Promise<{ rows: T[] }> }) => client.query<{ run_id: string }>(
    `INSERT INTO orchestration_runs (run_date, triggered_by, overall_status, steps, schedule)
     VALUES ($1, $2::orchestration_trigger, 'RUNNING', $3::jsonb, $4::jsonb)
     RETURNING run_id`,
    [runDate, triggeredBy, JSON.stringify(initialSteps()), JSON.stringify(scheduleFor(runDate, start))],
  );
  const client = await pool.connect();
  let result: { rows: { run_id: string }[] };
  const lockKey = `orchestration-launch:${runDate}`;
  try {
    const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [lockKey]);
    if (!lock.rows[0]?.locked) {
      throw new Error(`Daily orchestration launch is already being claimed for ${runDate}`);
    }
    const existing = await client.query<{ run_id: string }>(
      triggeredBy === "SCHEDULED"
        ? `SELECT run_id FROM orchestration_runs
           WHERE run_date = $1
             AND (triggered_by = 'SCHEDULED' OR overall_status = ANY($2::orchestration_status[]))
           ORDER BY created_at DESC LIMIT 1`
        : `SELECT run_id FROM orchestration_runs
           WHERE run_date = $1 AND overall_status = ANY($2::orchestration_status[])
           ORDER BY created_at DESC LIMIT 1`,
      [runDate, QUALIFYING_RUN_STATUSES],
    );
    if (existing.rows[0]) {
      const run = await queryOrchestrationRun(existing.rows[0].run_id);
      if (run.overallStatus === "RUNNING") void executeRun(run.runId, run.runDate);
      return run;
    }
    result = await insert(client);
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => undefined);
    client.release();
  }
  const runId = result.rows[0].run_id;
  void executeRun(runId, runDate);
  await recordAuditEvent({ actor: triggeredBy === "OPERATOR" ? "OPERATOR" : "SCHEDULER", action: "orchestration.launched", resourceType: "orchestration_run", resourceId: runId, metadata: { runDate } });
  return queryOrchestrationRun(runId);
}

/**
 * Startup and interval recovery for the daily 08:00 ET run. The database-backed
 * launch claim makes this safe when several autoscale replicas wake at once.
 */
export async function catchUpScheduledOrchestration(now = new Date()) {
  const slateDate = currentEasternDate(now);
  const localTime = currentEasternTime(now);
  if (localTime < "08:00") return { slateDate, due: false, run: null };
  const run = await launchOrchestrationRun(slateDate, "SCHEDULED");
  return { slateDate, due: true, run };
}

export async function queryOrchestrationRun(runId: string) {
  const result = await pool.query<{
    run_id: string; run_date: string; triggered_by: OrchestrationTrigger; overall_status: string; steps: RunStep[];
    schedule: Record<string, unknown>; frozen_at: string | null; cancel_requested_at: string | null; error_message: string | null; created_at: string; finished_at: string | null;
  }>(
    `SELECT run_id, run_date::text, triggered_by, overall_status, steps, schedule, frozen_at::text,
            cancel_requested_at::text, error_message, created_at::text, finished_at::text
     FROM orchestration_runs WHERE run_id = $1`,
    [runId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Orchestration run not found");
  return {
    runId: row.run_id, runDate: row.run_date, triggeredBy: row.triggered_by, overallStatus: row.overall_status,
    steps: row.steps, schedule: row.schedule, frozenAt: row.frozen_at, cancelRequestedAt: row.cancel_requested_at,
    errorMessage: row.error_message, createdAt: row.created_at, finishedAt: row.finished_at,
  };
}

export async function queryOrchestrationRuns(rawDate?: unknown) {
  const date = rawDate == null ? null : dateOnly(rawDate);
  const result = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM orchestration_runs WHERE ($1::date IS NULL OR run_date = $1::date) ORDER BY created_at DESC LIMIT 100`,
    [date],
  );
  return Promise.all(result.rows.map((row) => queryOrchestrationRun(row.run_id)));
}

export async function interruptOrchestrationRun(runId: string) {
  const before = await queryOrchestrationRun(runId);
  if (before.overallStatus !== "RUNNING") return before;
  await pool.query(`UPDATE orchestration_runs SET cancel_requested_at = now() WHERE run_id = $1 AND overall_status = 'RUNNING'`, [runId]);
  const run = await queryOrchestrationRun(runId);
  if (run.overallStatus !== "RUNNING") return run;
  if (!run.steps.some((step) => step.status === "RUNNING")) {
    markPendingSkipped(run.steps, "Skipped because the run was interrupted");
    await finaliseRun(runId, run.runDate, run.steps, "CANCELLED");
    return queryOrchestrationRun(runId);
  }
  await recordAuditEvent({ actor: "OPERATOR", action: "orchestration.interrupt_requested", resourceType: "orchestration_run", resourceId: runId });
  return queryOrchestrationRun(runId);
}

export async function detectLateScratches(slateDate: string) {
  const result = await pool.query<{ snapshot_id: string; player_id: number; game_pk: number; market: string }>(
    `SELECT pfs.snapshot_id, pfs.player_id, pfs.game_pk::bigint AS game_pk, pfs.market
     FROM pregame_feature_snapshots pfs
     JOIN lineup_snapshots ls ON ls.game_pk = pfs.game_pk AND ls.state = 'SCRATCHED'
     JOIN lineup_entries le ON le.lineup_snapshot_id = ls.lineup_snapshot_id AND le.player_id = pfs.player_id
     WHERE pfs.slate_date = $1 AND pfs.correction_of IS NULL
       AND NOT EXISTS (SELECT 1 FROM pregame_feature_snapshots correction WHERE correction.correction_of = pfs.snapshot_id AND correction.correction_reason = 'LATE_SCRATCH')`,
    [dateOnly(slateDate)],
  );
  let corrections = 0;
  for (const row of result.rows) {
    await correctSnapshot(row.snapshot_id, "LATE_SCRATCH", "Automated post-freeze lineup scratch detected.", null);
    await pool.query(
      `UPDATE market_research_candidates
       SET research_state = 'BLOCKED', missing_stale_evidence = COALESCE(missing_stale_evidence || ' · ', '') || 'LATE_SCRATCH correction recorded'
       WHERE slate_date = $1 AND game_pk = $2 AND player_id = $3 AND market = $4`,
      [slateDate, row.game_pk, row.player_id, row.market],
    );
    corrections += 1;
  }
  if (corrections) await populateDailyMarketBoard(slateDate);
  return { slateDate, corrections, targetedRerun: corrections > 0 };
}

export async function automateSettlementDate(rawDate: unknown) {
  const slateDate = dateOnly(rawDate);
  const settlement = await settleOfficialDate(slateDate);
  const links = await pool.query<{ snapshot_id: string; outcome_id: string; process_error_taxonomy: string | null }>(
    // The outcome's own classified taxonomy first. It describes the settlement
    // transition that actually occurred; the snapshot's correction reason
    // describes a different event and was the only thing consulted before.
    `SELECT pfs.snapshot_id, ho.outcome_id,
            COALESCE(ho.process_error_taxonomy::text, pfs.correction_reason::text,
                     correction.correction_reason::text) AS process_error_taxonomy
     FROM pregame_feature_snapshots pfs
     JOIN historical_outcomes ho ON ho.player_id = pfs.player_id AND ho.game_pk = pfs.game_pk AND ho.market = pfs.market
      LEFT JOIN pregame_feature_snapshots correction
        ON correction.correction_of = pfs.snapshot_id AND correction.correction_reason = 'LATE_SCRATCH'
     WHERE pfs.slate_date = $1 AND ho.settlement_state = 'SETTLED'
       AND NOT EXISTS (SELECT 1 FROM historical_outcomes newer WHERE newer.correction_of = ho.outcome_id)
       AND NOT EXISTS (SELECT 1 FROM market_postmortems mp WHERE mp.snapshot_id = pfs.snapshot_id AND mp.outcome_id = ho.outcome_id)`,
    [slateDate],
  );
  let postmortemsCreated = 0;
  for (const link of links.rows) {
    await createMarketPostmortem({
      snapshotId: link.snapshot_id,
      outcomeId: link.outcome_id,
      notes: link.process_error_taxonomy
        ? `Automated from official MLB settlement. Process error taxonomy: ${link.process_error_taxonomy}.`
        : "Automated from official MLB settlement.",
      processErrorTaxonomy: link.process_error_taxonomy,
    });
    postmortemsCreated += 1;
  }
  await recordAuditEvent({
    action: "settlement.automated",
    resourceType: "slate",
    resourceId: slateDate,
    metadata: { outcomesWritten: settlement.outcomesWritten, postmortemsCreated },
  });
  return { ...settlement, postmortemsCreated, officialRecord: "MLB Analyst Platform" };
}

type SettlementAutomationRun = {
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  attempted: boolean;
  slateDate: string;
  nextAttemptAt: string | null;
  /** True once the retry ceiling is reached and the date will not be retried. */
  terminal?: boolean;
  attempts?: number;
};

/**
 * Maximum settlement attempts for one date.
 *
 * The retry was a fixed fifteen minutes with no ceiling and no terminal state,
 * so a date that could never settle retried forever, filling the audit log and
 * hiding the fact that it needed a human.
 */
export const SETTLEMENT_MAX_ATTEMPTS = 8;
type SettlementDependencies = {
  ingestOfficial: (slateDate: string) => Promise<unknown>;
  automate: (slateDate: string) => Promise<{
    gamesFound: number;
    gamesSettled: number;
    outcomesWritten: number;
    reconciliation?: {
      boardCandidates: number;
      settled: number;
      settledWithoutSnapshot: number;
      unsettleable: Array<{ playerId: number; market: string; reason: string; gamePk?: number }>;
    };
  }>;
};

const TERMINAL_GAME_STATES = ["Final", "Game Over", "Completed Early", "Postponed", "Suspended", "Cancelled", "Canceled", "No Decision"];

async function settlementIsComplete(slateDate: string, result: { gamesFound: number; gamesSettled: number }) {
  const games = await pool.query<{ scheduled_games: number; terminal_games: number }>(
    `SELECT count(*)::int AS scheduled_games,
            count(*) FILTER (WHERE game_status = ANY($2::text[]))::int AS terminal_games
     FROM games WHERE game_date = $1`,
    [slateDate, TERMINAL_GAME_STATES],
  );
  const scheduledGames = games.rows[0]?.scheduled_games ?? 0;
  const terminalGames = games.rows[0]?.terminal_games ?? 0;
  return {
    complete: scheduledGames === terminalGames && result.gamesFound === result.gamesSettled,
    scheduledGames,
    terminalGames,
  };
}

/**
 * Claims a durable settlement job, refreshes the prior slate from MLB, then
 * settles it. Failed jobs receive a bounded retry window; completed dates are
 * permanently skipped. Keeping the advisory lock for the attempt prevents
 * replicas from ingesting the same date concurrently.
 */
export async function runNightlySettlement(
  rawDate: unknown,
  dependencies: SettlementDependencies = {
    ingestOfficial: ingestMlbOfficial,
    automate: automateSettlementDate,
  },
): Promise<SettlementAutomationRun> {
  const slateDate = dateOnly(rawDate);
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [`settlement-automation:${slateDate}`],
    );
    if (!lock.rows[0]?.locked) return { slateDate, status: "RUNNING", attempted: false, nextAttemptAt: null };
    await client.query(
      `INSERT INTO settlement_automation_runs (slate_date, status, next_attempt_at)
       VALUES ($1, 'PENDING', now())
       ON CONFLICT (slate_date) DO NOTHING`,
      [slateDate],
    );
    const existing = await client.query<{
      status: SettlementAutomationRun["status"];
      next_attempt_at: string | null;
      attempts: number;
    }>(
      `SELECT status, next_attempt_at::text, attempts FROM settlement_automation_runs WHERE slate_date = $1`,
      [slateDate],
    );
    const prior = existing.rows[0];
    if (prior?.status === "SUCCESS") return { slateDate, status: "SUCCESS", attempted: false, nextAttemptAt: null };
    // Retry ceiling. The fixed fifteen-minute retry had no attempt limit and no
    // terminal state, so a permanently broken date retried forever.
    if (prior && prior.attempts >= SETTLEMENT_MAX_ATTEMPTS) {
      return {
        slateDate,
        status: "FAILED",
        attempted: false,
        nextAttemptAt: null,
        terminal: true,
        attempts: prior.attempts,
      };
    }
    if (prior?.status === "FAILED" && prior.next_attempt_at && Date.parse(prior.next_attempt_at) > Date.now()) {
      return { slateDate, status: "FAILED", attempted: false, nextAttemptAt: prior.next_attempt_at, attempts: prior.attempts };
    }
    await client.query(
      `UPDATE settlement_automation_runs
       SET status = 'RUNNING', attempts = attempts + 1, started_at = now(), finished_at = NULL,
           next_attempt_at = NULL, error_message = NULL, updated_at = now()
       WHERE slate_date = $1`,
      [slateDate],
    );
    try {
      await dependencies.ingestOfficial(slateDate);
      const result = await dependencies.automate(slateDate);
      const completeness = await settlementIsComplete(slateDate, result);
      if (!completeness.complete) {
        throw new Error(
          `Official settlement remains incomplete: ${completeness.terminalGames}/${completeness.scheduledGames} games terminal; `
          + `${result.gamesSettled}/${result.gamesFound} terminal games settled.`,
        );
      }
      // A board candidate that could not be settled at all blocks SUCCESS. It
      // used to pass unnoticed because settlement only ever looked at frozen
      // snapshots and the board was never consulted.
      const unsettleable = result.reconciliation?.unsettleable ?? [];
      if (unsettleable.length) {
        const named = unsettleable
          .slice(0, 5)
          .map((entry) => `player ${entry.playerId} ${entry.market}${entry.gamePk ? ` (game ${entry.gamePk})` : ""}: ${entry.reason}`)
          .join("; ");
        throw new Error(
          `${unsettleable.length} board candidate(s) could not be settled for ${slateDate}. ${named}`,
        );
      }
      await client.query(
        `UPDATE settlement_automation_runs
         SET status = 'SUCCESS', finished_at = now(), result = $2::jsonb, updated_at = now()
         WHERE slate_date = $1`,
        [slateDate, JSON.stringify(result)],
      );
      await recordAuditEvent({
        actor: "SCHEDULER",
        action: "settlement.nightly_completed",
        resourceType: "slate",
        resourceId: slateDate,
        metadata: {
          gamesFound: result.gamesFound,
          gamesSettled: result.gamesSettled,
          outcomesWritten: result.outcomesWritten,
          boardCandidates: result.reconciliation?.boardCandidates ?? null,
          settledWithoutSnapshot: result.reconciliation?.settledWithoutSnapshot ?? null,
        },
      });
      return { slateDate, status: "SUCCESS", attempted: true, nextAttemptAt: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Exponential backoff up to the ceiling, then a terminal state with no
      // next attempt at all.
      const failed = await client.query<{ next_attempt_at: string | null; attempts: number }>(
        `UPDATE settlement_automation_runs
         SET status = 'FAILED', finished_at = now(), error_message = $2,
             next_attempt_at = CASE
               WHEN attempts >= $3 THEN NULL
               ELSE now() + (interval '15 minutes' * power(2, least(attempts - 1, 4)))
             END,
             updated_at = now()
         WHERE slate_date = $1
         RETURNING next_attempt_at::text, attempts`,
        [slateDate, message, SETTLEMENT_MAX_ATTEMPTS],
      );
      const attempts = failed.rows[0]?.attempts ?? 0;
      const terminal = attempts >= SETTLEMENT_MAX_ATTEMPTS;
      await recordAuditEvent({
        actor: "SCHEDULER",
        action: terminal ? "settlement.nightly_terminal" : "settlement.nightly_failed",
        resourceType: "slate",
        resourceId: slateDate,
        metadata: {
          retryAt: failed.rows[0]?.next_attempt_at ?? null,
          attempts,
          maxAttempts: SETTLEMENT_MAX_ATTEMPTS,
          terminal,
          error: message,
        },
      });
      throw error;
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`settlement-automation:${slateDate}`]).catch(() => undefined);
    client.release();
  }
}

/** Process every overdue durable settlement record, including jobs stranded across midnight or a restart. */
export async function processDueSettlementRuns() {
  const due = await pool.query<{ slate_date: string }>(
    // A FAILED row with no next_attempt_at is terminal, not due immediately.
    // It used to mean "retry now", which is why a permanently broken date was
    // re-picked on every scheduler tick forever.
    `SELECT slate_date::text
     FROM settlement_automation_runs
     WHERE attempts < $1
       AND (
         status IN ('PENDING', 'RUNNING')
         OR (status = 'FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
       )
     ORDER BY slate_date ASC
     LIMIT 10`,
    [SETTLEMENT_MAX_ATTEMPTS],
  );
  const results = [];
  for (const row of due.rows) {
    try {
      results.push(await runNightlySettlement(row.slate_date));
    } catch (error) {
      logger.warn({ err: error, slateDate: row.slate_date }, "nightly settlement retry remains pending");
    }
  }
  return results;
}

export function startOrchestrationScheduler() {
  if (process.env.NODE_ENV !== "production" && process.env.ENABLE_ORCHESTRATION_SCHEDULER !== "true") return;
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = async () => {
    const now = new Date();
    const localDate = currentEasternDate(now);
    const localTime = currentEasternTime(now);
    await catchUpScheduledOrchestration(now);
    if (localTime >= "02:30") {
      const [year, month, day] = localDate.split("-").map(Number);
      const priorSlateDate = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
      try {
        await runNightlySettlement(priorSlateDate);
      } catch (error) {
        logger.warn({ err: error, slateDate: priorSlateDate }, "nightly settlement attempt remains retryable");
      }
    }
    await processDueSettlementRuns();
    const due = await pool.query<{ run_id: string }>(
      `SELECT run_id FROM orchestration_runs
       WHERE overall_status = 'RUNNING' AND (schedule->>'calculatedFreezeUtc')::timestamptz <= now()
       ORDER BY created_at LIMIT 10`,
    );
    for (const row of due.rows) await executeDueFreeze(row.run_id);
  };
  setInterval(() => void tick().catch((error) => logger.error({ err: error }, "orchestration scheduler tick failed")), 60_000).unref();
  void tick();
}