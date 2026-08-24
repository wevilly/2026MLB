import assert from "node:assert/strict";
import test from "node:test";
import { compareRoundRobinGame, type RoundRobinCandidate } from "../artifacts/api-server/src/services/round-robin-comparison.ts";

function candidate(overrides: Partial<RoundRobinCandidate>): RoundRobinCandidate {
  const id = overrides.candidateId ?? `${overrides.side ?? "AWAY"}-${overrides.market ?? "TB"}-${overrides.playerId ?? 1}`;
  return {
    candidateId: id,
    gamePk: 1,
    playerId: overrides.playerId ?? 1,
    playerName: overrides.playerName ?? id,
    market: overrides.market ?? "TB",
    researchRank: overrides.researchRank ?? 1,
    researchState: overrides.researchState ?? "POSITIVE",
    side: overrides.side ?? "AWAY",
    team: overrides.team ?? (overrides.side === "HOME" ? "HOME" : "AWAY"),
    selectable: overrides.selectable ?? true,
    selectionBlockReason: overrides.selectionBlockReason ?? null,
    lineupState: overrides.lineupState ?? "POSTED",
    starterState: overrides.starterState ?? "CONFIRMED",
    bvpStatus: "AVAILABLE",
    bvpEvidence: null,
    arsenalStatus: "AVAILABLE",
    evidenceFreshness: "CURRENT",
    primaryMechanism: "Current aggregate evidence",
    opportunityEvidence: {},
    starterMatchupEvidence: {},
    bullpenPathEvidence: {},
    parkEvidence: {},
    counterEvidence: {},
    ...overrides,
  };
}

test("RR2 evaluates both sides and can select away", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-tb", side: "AWAY", playerId: 1, market: "TB", researchState: "STRONG", researchRank: 1 }),
    candidate({ candidateId: "away-walk", side: "AWAY", playerId: 2, market: "WALK", researchState: "POSITIVE", researchRank: 2 }),
    candidate({ candidateId: "home-tb", side: "HOME", team: "HOME", playerId: 3, market: "TB", researchState: "NEUTRAL", researchRank: 8 }),
    candidate({ candidateId: "home-walk", side: "HOME", team: "HOME", playerId: 4, market: "WALK", researchState: "NEUTRAL", researchRank: 9 }),
  ]);
  assert.equal(result.away.bestConstruction?.constructionType, "TB_WALK");
  assert.equal(result.home.bestConstruction?.constructionType, "TB_WALK");
  assert.equal(result.selectedSide, "AWAY");
});

test("RR4 can select home when its XBH and walk evidence is stronger", () => {
  const result = compareRoundRobinGame("RR4", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-xbh", side: "AWAY", playerId: 1, market: "XBH", researchState: "NEUTRAL", researchRank: 5 }),
    candidate({ candidateId: "away-walk", side: "AWAY", playerId: 2, market: "WALK", researchState: "NEUTRAL", researchRank: 5 }),
    candidate({ candidateId: "home-xbh", side: "HOME", team: "HOME", playerId: 3, market: "XBH", researchState: "STRONG", researchRank: 1 }),
    candidate({ candidateId: "home-walk", side: "HOME", team: "HOME", playerId: 4, market: "WALK", researchState: "POSITIVE", researchRank: 2 }),
  ]);
  assert.equal(result.selectedSide, "HOME");
  assert.equal(result.selectedConstruction?.constructionLabel, "Same-team XBH + Walk");
});

test("RR1 labels a side-anchored cross-team pair when it is the only legal construction", () => {
  const result = compareRoundRobinGame("RR1", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-tb", side: "AWAY", playerId: 1, market: "TB" }),
    candidate({ candidateId: "home-tb", side: "HOME", team: "HOME", playerId: 2, market: "TB" }),
  ]);
  assert.equal(result.away.bestConstruction?.constructionLabel, "Cross-team TB + TB");
  assert.equal(result.home.bestConstruction?.constructionLabel, "Cross-team TB + TB");
});

test("same-market pairs are retained when evidence order disagrees with candidate ID order", () => {
  const result = compareRoundRobinGame("RR1", 1, "AWAY", "HOME", [
    candidate({ candidateId: "z-best", side: "AWAY", playerId: 1, market: "TB", researchState: "STRONG", researchRank: 1 }),
    candidate({ candidateId: "a-second", side: "AWAY", playerId: 2, market: "TB", researchState: "POSITIVE", researchRank: 2 }),
  ]);
  assert.equal(result.away.bestConstruction?.constructionLabel, "Same-team TB + TB");
  assert.equal(result.away.bestConstruction?.legs.length, 2);
});

test("RR5 considers all four supported construction types", () => {
  const result = compareRoundRobinGame("RR5", 1, "AWAY", "HOME", [
    candidate({ candidateId: "tb-1", side: "AWAY", playerId: 1, market: "TB" }),
    candidate({ candidateId: "tb-2", side: "AWAY", playerId: 2, market: "TB" }),
    candidate({ candidateId: "walk", side: "AWAY", playerId: 3, market: "WALK" }),
    candidate({ candidateId: "xbh", side: "AWAY", playerId: 4, market: "XBH" }),
    candidate({ candidateId: "hr-1", side: "AWAY", playerId: 5, market: "HR" }),
    candidate({ candidateId: "hr-2", side: "AWAY", playerId: 6, market: "HR" }),
  ]);
  assert.deepEqual(result.away.consideredConstructionTypes.sort(), ["HR_HR", "TB_TB", "TB_WALK", "XBH_WALK"]);
});

test("unsafe rows remain evaluated but cannot enter a selected construction", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "blocked-tb", side: "AWAY", playerId: 1, market: "TB", selectable: false, selectionBlockReason: "STALE", evidenceFreshness: "STALE" }),
    candidate({ candidateId: "walk", side: "AWAY", playerId: 2, market: "WALK" }),
  ]);
  assert.equal(result.away.evaluatedIneligibleHitters, 1);
  assert.equal(result.away.bestConstruction, null);
  assert.equal(result.selectedSide, null);
});