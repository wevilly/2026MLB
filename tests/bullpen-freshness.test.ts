/**
 * Tasks 3.4 and 3.5 acceptance.
 *
 * source_freshness was written as new Date().toISOString() and then checked by
 * isCurrentBullpenTimestamp as if it described the age of the upstream MLB
 * data. It was computed_at under a second name, so the gate always passed
 * regardless of how stale the feed was: a tautology.
 *
 * Three bare catch blocks meant a complete MLB Stats API outage produced an
 * ingest run marked SUCCESS with zero rows.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { bundleService } from "./helpers/bundle.ts";


const bullpen = bundleService("artifacts/api-server/src/services/bullpen-foundation.ts");

describe("Task 3.4 no data at all is not the same as no appearances", () => {
  test("a team with no observation in the window is UNKNOWN, not AVAILABLE", async () => {
    const { computeHeuristicAvailability } = await bullpen;
    assert.equal(computeHeuristicAvailability({
      d1Pitches: null, d2Pitches: null, d3Pitches: null, multiInningYesterday: false,
      d1Appeared: false, d2Appeared: false, d3Appeared: false,
      teamWindowObserved: false,
    }), "UNKNOWN");
  });

  test("a rested reliever on an observed bullpen is AVAILABLE", async () => {
    const { computeHeuristicAvailability } = await bullpen;
    assert.equal(computeHeuristicAvailability({
      d1Pitches: null, d2Pitches: null, d3Pitches: null, multiInningYesterday: false,
      d1Appeared: false, d2Appeared: false, d3Appeared: false,
      teamWindowObserved: true,
    }), "AVAILABLE");
  });

  test("an appearance with an unknown pitch count is not one pitch", async () => {
    const { computeHeuristicAvailability } = await bullpen;
    // Appeared on D-1 and D-2 with counts unknown: two consecutive days, so
    // DOUBTFUL. The pitch counts stay null rather than being invented as 1.
    assert.equal(computeHeuristicAvailability({
      d1Pitches: null, d2Pitches: null, d3Pitches: null, multiInningYesterday: false,
      d1Appeared: true, d2Appeared: true, d3Appeared: false,
      teamWindowObserved: true,
    }), "DOUBTFUL");
  });

  test("the historical cases answer identically when the new fields are absent", async () => {
    const { computeHeuristicAvailability } = await bullpen;
    assert.equal(computeHeuristicAvailability({ d1Pitches: 10, d2Pitches: 8, d3Pitches: 5, multiInningYesterday: false }), "OUT");
    assert.equal(computeHeuristicAvailability({ d1Pitches: 40, d2Pitches: null, d3Pitches: null, multiInningYesterday: false }), "DOUBTFUL");
    assert.equal(computeHeuristicAvailability({ d1Pitches: null, d2Pitches: 12, d3Pitches: null, multiInningYesterday: false }), "LIKELY_AVAILABLE");
    assert.equal(computeHeuristicAvailability({ d1Pitches: null, d2Pitches: null, d3Pitches: null, multiInningYesterday: false }), "UNKNOWN");
  });
});

describe("Task 3.4 freshness reflects the upstream observation", () => {
  const source = readFileSync("artifacts/api-server/src/services/bullpen-foundation.ts", "utf8");

  test("source_freshness is no longer now()", () => {
    const compute = source.slice(
      source.indexOf("async function computeTeamAvailability"),
      source.indexOf("async function buildTeamLeverageMap"),
    );
    const code = compute
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    assert.ok(
      !/new Date\(\)\.toISOString\(\)/.test(code),
      "source_freshness must not be written as the current time",
    );
    assert.ok(compute.includes("max(recorded_at)"), "it must come from the appearance log's retrieval time");
    assert.ok(compute.includes("sourceObservationGameDate"), "the game date of the observation must be recorded");
  });

  test("an unobserved window yields a null freshness and an UNKNOWN state", () => {
    const compute = source.slice(source.indexOf("async function computeTeamAvailability"));
    assert.ok(compute.includes("const teamWindowObserved = sourceFreshness !== null"),
      "the observed flag must be derived from the freshness value");
    assert.ok(compute.includes("teamWindowObserved,"), "the flag must reach the heuristic");
  });

  test("an honest freshness signal cannot newly veto a pair, per task 2.2", () => {
    // Bullpen state must not reach missing_stale_evidence, which
    // getMarketResearchSelectionEligibility treats as a blocking gap.
    for (const engine of ["tb-engine", "walk-engine", "xbh-engine", "hr-engine"]) {
      const engineSource = readFileSync(`artifacts/api-server/src/services/${engine}.ts`, "utf8");
      assert.ok(
        !/missingData\.push\(`Bullpen/.test(engineSource),
        `${engine} must not write bullpen state into the blocking evidence field`,
      );
    }
    const rr = readFileSync("artifacts/api-server/src/services/round-robin-comparison.ts", "utf8");
    const eligible = rr.slice(rr.indexOf("const eligible = candidates.filter"), rr.indexOf("const constructions ="));
    assert.ok(!eligible.includes("bullpen"), "bullpen state must not be part of eligibility");
  });
});

describe("Task 3.5 a swallowed error is never a success", () => {
  const source = readFileSync("artifacts/api-server/src/services/bullpen-foundation.ts", "utf8");

  test("no bare catch remains in the ingest path", () => {
    const ingest = source.slice(source.indexOf("async function ingestActiveRosters"), source.indexOf("export function computeHeuristicAvailability"));
    assert.ok(!/\}\s*catch\s*\{/.test(ingest), "every catch must bind and record its error");
    assert.ok((ingest.match(/recordFailure\(/g) ?? []).length >= 5, "each failure path must be counted");
  });

  test("the teams endpoint failing is fatal, one roster failing is partial", () => {
    assert.ok(source.includes('recordFailure(failures, "teams"'), "a teams failure must be recorded");
    assert.ok(/recordFailure\(failures, "teams",[^)]*true\)/.test(source), "a teams failure must be fatal");
    assert.ok(source.includes("recordFailure(failures, `roster:${teamId}`, error)"), "a roster failure must be partial");
  });

  test("refreshBullpen returns a status and never SUCCESS on an empty real slate", () => {
    const refresh = source.slice(source.indexOf("export async function refreshBullpen"));
    assert.ok(refresh.includes("const emptyDespiteSlate = expectedGames > 0 && appearancesNormalized === 0"),
      "the expected-volume check must exist");
    assert.ok(/status: "SUCCESS" \| "PARTIAL" \| "FAILED" = fatal \|\| emptyDespiteSlate/.test(refresh),
      "a fatal failure or an empty real slate must be FAILED");
    assert.ok(refresh.includes('? "PARTIAL"'), "a sub-fetch failure must be PARTIAL");
    assert.ok(refresh.includes("await finishRun(runId, status,"), "the run status must be the computed one");
    assert.ok(!refresh.includes('await finishRun(runId, "SUCCESS"'), "SUCCESS must never be hardcoded");
  });
});

describe("Task 3.5 orchestration and settlement retries", () => {
  const source = readFileSync("artifacts/api-server/src/services/orchestration.ts", "utf8");

  test("an empty result on a real slate is a WARNING, not a clean pass", () => {
    assert.ok(source.includes("const emptyOnRealSlate = produced === 0 && expectedSlateWork > 0"),
      "the distinction must exist");
    assert.ok(source.includes("produced 0 with ${expectedSlateWork} scheduled game(s)"),
      "expected versus actual counts must be recorded in the step detail");
    assert.ok(source.includes("scheduledGameCount(slateDate)"), "the slate denominator must be read");
  });

  test("a step that reports its own PARTIAL or FAILED status is believed", () => {
    assert.ok(source.includes('if (reported === "FAILED")'), "a self-reported failure must fail the step");
    assert.ok(source.includes('reported === "PARTIAL"'), "a self-reported partial must warn");
  });

  test("settlement retries have a ceiling and a terminal state", () => {
    assert.ok(source.includes("export const SETTLEMENT_MAX_ATTEMPTS"), "the ceiling must be a named constant");
    assert.ok(source.includes("prior.attempts >= SETTLEMENT_MAX_ATTEMPTS"), "the ceiling must be enforced");
    assert.ok(source.includes("terminal: true"), "a ceilinged date must reach a terminal state");
    assert.ok(/WHEN attempts >= \$3 THEN NULL/.test(source), "no next attempt is scheduled past the ceiling");
    assert.ok(source.includes("settlement.nightly_terminal"), "reaching the ceiling must be audited distinctly");
  });

  test("a terminal date is no longer picked up as due", () => {
    const due = source.slice(source.indexOf("export async function processDueSettlementRuns"));
    assert.ok(due.includes("attempts < $1"), "the due query must respect the ceiling");
    assert.ok(due.includes("next_attempt_at IS NOT NULL AND next_attempt_at <= now()"),
      "a null next attempt must mean terminal, not due now");
  });
});
