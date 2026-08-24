/**
 * Current-date readiness regression coverage.
 *
 * A blocked health contract must make operational consumers audit-only without
 * deleting their evidence or surfacing model-derived probability signals.
 */
import assert from "node:assert/strict";
import test from "node:test";

const BASE = "http://127.0.0.1:8080/api/analyst";

test("current readiness is shared by health, research, and market board consumers", async () => {
  const [healthResponse, researchResponse, boardResponse, summaryResponse] = await Promise.all([
    fetch(`${BASE}/data-health`),
    fetch(`${BASE}/market-research`),
    fetch(`${BASE}/market-board`),
    fetch(`${BASE}/market-board/game-summary`),
  ]);
  assert.equal(healthResponse.status, 200);
  assert.equal(researchResponse.status, 200);
  assert.equal(boardResponse.status, 200);
  assert.equal(summaryResponse.status, 200);

  const [health, research, board, summary] = await Promise.all([
    healthResponse.json(),
    researchResponse.json(),
    boardResponse.json(),
    summaryResponse.json(),
  ]);
  for (const payload of [health, research, board, summary]) {
    assert.ok(payload.readiness, "every operational consumer must include readiness");
    assert.match(payload.readiness.status, /^(READY|PARTIAL|BLOCKED|AUDIT_ONLY)$/);
    assert.equal(typeof payload.readiness.usable, "boolean");
    assert.ok(payload.readiness.reason.length > 0);
    assert.match(payload.readiness.currentDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  for (const source of health.sources) {
    assert.ok("effectiveDate" in source);
    assert.ok("ageMinutes" in source);
    assert.ok("isCurrentDate" in source);
  }

  if (!health.readiness.usable) {
    assert.equal(research.selectableCandidateCount, 0, "blocked health must not leave a selectable research row");
    for (const candidate of research.candidates) {
      assert.equal(candidate.operationalState, "AUDIT_ONLY");
      assert.equal(candidate.selectable, false);
      assert.ok(candidate.auditReason);
    }
    for (const entry of board.entries) {
      assert.equal(entry.confidenceBasis, "RESEARCH_ONLY");
      assert.equal(entry.calibratedProbability, null);
      assert.equal(entry.modelPrediction, null);
    }
    for (const game of summary.games) {
      for (const entry of Object.values(game.topCandidates)) {
        assert.equal(entry.confidenceBasis, "RESEARCH_ONLY");
        assert.equal(entry.calibratedProbability, null);
        assert.equal(entry.modelPrediction, null);
      }
    }
  }
});

test("historical board filters are explicitly audit-only", async () => {
  const historicalDate = "2026-08-23";
  const [healthResponse, researchResponse, boardResponse, summaryResponse, roundRobinResponse] = await Promise.all([
    fetch(`${BASE}/data-health?date=${historicalDate}`),
    fetch(`${BASE}/market-research?date=${historicalDate}`),
    fetch(`${BASE}/market-board?date=${historicalDate}`),
    fetch(`${BASE}/market-board/game-summary?date=${historicalDate}`),
    fetch(`${BASE}/round-robin/comparison?date=${historicalDate}&board=RR1`),
  ]);
  for (const response of [healthResponse, researchResponse, boardResponse, summaryResponse, roundRobinResponse]) {
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.readiness.requestedDate, historicalDate);
    assert.equal(payload.readiness.status, "AUDIT_ONLY");
    assert.equal(payload.readiness.usable, false);
  }
});