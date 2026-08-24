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
    lineupState: overrides.lineupState ?? "PROJECTED",
    starterState: overrides.starterState ?? "CONFIRMED",
    bvpStatus: "AVAILABLE",
    bvpEvidence: null,
    arsenalStatus: "AVAILABLE",
    evidenceFreshness: "CURRENT",
    evidenceFreshnessDetail: null,
    primaryMechanism: "Current aggregate evidence",
    opportunityEvidence: {},
    starterMatchupEvidence: {},
    bullpenPathEvidence: {
      status: "CURRENT",
      rolePath: [
        { slot: "7TH", playerId: 701, role: "SETUP" },
        { slot: "8TH", playerId: 801, role: "PRIMARY_SETUP" },
        { slot: "9TH", playerId: 901, role: "CLOSER" },
      ],
    },
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

test("confirmed FantasyPros lineups break an otherwise exact projected-lineup tie", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-tb", side: "AWAY", playerId: 1, market: "TB", lineupState: "CONFIRMED" }),
    candidate({ candidateId: "away-walk", side: "AWAY", playerId: 2, market: "WALK", lineupState: "CONFIRMED" }),
    candidate({ candidateId: "home-tb", side: "HOME", team: "HOME", playerId: 3, market: "TB", lineupState: "PROJECTED" }),
    candidate({ candidateId: "home-walk", side: "HOME", team: "HOME", playerId: 4, market: "WALK", lineupState: "PROJECTED" }),
  ]);
  assert.equal(result.selectedSide, "AWAY");
  assert.match(result.away.bestConstruction?.evidenceSummary ?? "", /FantasyPros confirmed lineups/);
  assert.match(result.home.bestConstruction?.evidenceSummary ?? "", /FantasyPros projected lineups/);
});

test("RR1 rejects a cross-team TB pair when it is the only available construction", () => {
  const result = compareRoundRobinGame("RR1", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-tb", side: "AWAY", playerId: 1, market: "TB" }),
    candidate({ candidateId: "home-tb", side: "HOME", team: "HOME", playerId: 2, market: "TB" }),
  ]);
  assert.equal(result.away.bestConstruction, null);
  assert.equal(result.home.bestConstruction, null);
  assert.ok(result.away.noPairCauses.includes("NO_LEGAL_SAME_TEAM_PAIR"));
});

test("same-market pairs are retained when evidence order disagrees with candidate ID order", () => {
  const result = compareRoundRobinGame("RR1", 1, "AWAY", "HOME", [
    candidate({ candidateId: "z-best", side: "AWAY", playerId: 1, market: "TB", researchState: "STRONG", researchRank: 1 }),
    candidate({ candidateId: "a-second", side: "AWAY", playerId: 2, market: "TB", researchState: "POSITIVE", researchRank: 2 }),
  ]);
  assert.equal(result.away.bestConstruction?.constructionLabel, "Same-team TB + TB");
  assert.equal(result.away.bestConstruction?.legs.length, 2);
});

test("RR5 selects only among the four legal same-team boards", () => {
  const result = compareRoundRobinGame("RR5", 1, "AWAY", "HOME", [
    candidate({ candidateId: "tb-1", side: "AWAY", playerId: 1, market: "TB" }),
    candidate({ candidateId: "tb-2", side: "AWAY", playerId: 2, market: "TB" }),
    candidate({ candidateId: "walk", side: "AWAY", playerId: 3, market: "WALK" }),
    candidate({ candidateId: "xbh", side: "AWAY", playerId: 4, market: "XBH" }),
    candidate({ candidateId: "hrrbi", side: "AWAY", playerId: 5, market: "H_R_RBI" }),
  ]);
  assert.deepEqual(result.away.consideredConstructionTypes.sort(), ["TB_TB", "TB_WALK", "XBH_H_R_RBI", "XBH_WALK"]);
});

for (const [board, markets] of [
  ["RR2", ["TB", "WALK"]],
  ["RR3", ["XBH", "H_R_RBI"]],
  ["RR4", ["XBH", "WALK"]],
  ["RR5", ["TB", "WALK", "XBH", "H_R_RBI"]],
] as const) {
  test(`${board} cannot form a legal construction from one player's mixed-market rows`, () => {
    const result = compareRoundRobinGame(board, 1, "AWAY", "HOME", markets.map((market, index) =>
      candidate({ candidateId: `${board}-${market}`, playerId: 1, market, researchRank: index + 1 }),
    ));
    assert.equal(result.away.bestConstruction, null);
    assert.ok(result.away.noPairCauses.includes("NO_LEGAL_SAME_TEAM_PAIR"));
  });
}

test("unsafe rows remain evaluated but cannot enter a selected construction", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "blocked-tb", side: "AWAY", playerId: 1, market: "TB", selectable: false, selectionBlockReason: "STALE", evidenceFreshness: "STALE" }),
    candidate({ candidateId: "walk", side: "AWAY", playerId: 2, market: "WALK" }),
  ]);
  assert.equal(result.away.evaluatedIneligibleHitters, 1);
  assert.equal(result.away.bestConstruction, null);
  assert.equal(result.selectedSide, null);
});

/**
 * Task 2.2. Bullpen state is a ranked disclosure, not a veto.
 *
 * These cases used to assert the opposite: that any bullpen state short of a
 * complete fresh 7th/8th/9th path removed the candidate from selection
 * entirely and returned no pair for the game. That was a third-order input
 * vetoing a first-order decision, and it is the behaviour the remediation plan
 * removes. Each case now asserts that the pair IS surfaced and that the
 * bullpen state is stated on it.
 */
for (const [status, reason, expected] of [
  ["STALE", "Projected 9th arm has stale source freshness.", /STALE.*stale source freshness/],
  ["MISSING", "No leverage map exists for this bullpen.", /MISSING.*No leverage map exists/],
  ["ROLE_INCOMPLETE", "Projected 8th arm is unavailable.", /ROLE_INCOMPLETE.*Projected 8th arm is unavailable/],
] as const) {
  test(`Round Robin surfaces a pair with a stated caveat for a ${status.toLowerCase()} bullpen path`, () => {
    const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
      candidate({ candidateId: `${status}-tb`, playerId: 1, market: "TB", bullpenPathEvidence: { status, reason } }),
      candidate({ candidateId: `${status}-walk`, playerId: 2, market: "WALK", bullpenPathEvidence: { status, reason } }),
    ]);
    assert.equal(result.selectedSide, "AWAY");
    assert.notEqual(result.away.bestConstruction, null);
    assert.equal(result.away.availabilityStatus, "AVAILABLE");
    assert.equal(result.away.unavailableReason, null);
    assert.equal(result.away.evaluatedIneligibleHitters, 0);
    assert.equal(result.away.bestConstruction!.bullpenPathComplete, false);
    assert.match(result.away.bestConstruction!.bullpenCaveat ?? "", expected);
    assert.match(result.away.bestConstruction!.evidenceSummary, /bullpen path incomplete/);
    for (const legCase of result.away.bestConstruction!.legCases) {
      assert.match((legCase as { bullpenPath: string }).bullpenPath, expected);
    }
    assert.ok(result.away.bullpenDisclosures.some((disclosure) => expected.test(disclosure)));
  });
}

test("a legacy generic bullpen payload is disclosed, not disqualifying", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "legacy-tb", playerId: 1, market: "TB", bullpenPathEvidence: {} }),
    candidate({ candidateId: "legacy-walk", playerId: 2, market: "WALK", bullpenPathEvidence: {} }),
  ]);
  assert.equal(result.selectedSide, "AWAY");
  assert.match(result.away.bestConstruction?.bullpenCaveat ?? "", /only generic bullpen evidence is recorded/);
});

test("a malformed CURRENT bullpen payload is disclosed, not disqualifying", () => {
  const malformedCurrent = { status: "CURRENT", rolePath: [{ slot: "9TH", playerId: 901, role: "CLOSER" }] };
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "malformed-tb", playerId: 1, market: "TB", bullpenPathEvidence: malformedCurrent }),
    candidate({ candidateId: "malformed-walk", playerId: 2, market: "WALK", bullpenPathEvidence: malformedCurrent }),
  ]);
  assert.equal(result.selectedSide, "AWAY");
  assert.match(result.away.bestConstruction?.bullpenCaveat ?? "", /complete, distinct projected 7th\/8th\/9th arm path/);
});

test("a game with fully researched hitters and no bullpen leverage map at all still returns a pair", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({
      candidateId: "no-bullpen-tb", playerId: 1, market: "TB", researchState: "STRONG",
      starterState: "CONFIRMED", lineupState: "CONFIRMED",
      bullpenPathEvidence: { status: "MISSING", reason: "No leverage map exists for this bullpen." },
    }),
    candidate({
      candidateId: "no-bullpen-walk", playerId: 2, market: "WALK", researchState: "STRONG",
      starterState: "CONFIRMED", lineupState: "CONFIRMED",
      bullpenPathEvidence: { status: "MISSING", reason: "No leverage map exists for this bullpen." },
    }),
  ]);
  assert.notEqual(result.away.bestConstruction, null);
  assert.notEqual(result.away.availabilityStatus, "NO_LEGAL_CONSTRUCTION");
  assert.notEqual(result.away.availabilityStatus, "STALE_OR_INCOMPLETE_RESEARCH");
  assert.ok(!result.noPairCauses.includes("STALE_OR_INCOMPLETE_RESEARCH"));
  assert.equal(result.away.bestConstruction!.bullpenPathComplete, false);
  assert.ok(result.away.availabilityDetail?.includes("Bullpen path incomplete"));
});

test("bullpen completeness separates two otherwise identical constructions", () => {
  const complete = {
    status: "CURRENT",
    rolePath: [
      { slot: "7TH", playerId: 701, role: "SETUP" },
      { slot: "8TH", playerId: 801, role: "PRIMARY_SETUP" },
      { slot: "9TH", playerId: 901, role: "CLOSER" },
    ],
  };
  const incomplete = { status: "MISSING", reason: "No leverage map exists for this bullpen." };
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-tb", playerId: 1, market: "TB", side: "AWAY", team: "AWAY", bullpenPathEvidence: incomplete }),
    candidate({ candidateId: "away-walk", playerId: 2, market: "WALK", side: "AWAY", team: "AWAY", bullpenPathEvidence: incomplete }),
    candidate({ candidateId: "home-tb", playerId: 3, market: "TB", side: "HOME", team: "HOME", bullpenPathEvidence: complete }),
    candidate({ candidateId: "home-walk", playerId: 4, market: "WALK", side: "HOME", team: "HOME", bullpenPathEvidence: complete }),
  ]);
  assert.equal(result.comparisonStatus, "SELECTED");
  assert.equal(result.selectedSide, "HOME");
});

/** Task 2.4. Within-side ties are broken by a stated rule and reported. */
test("a within-side tie is broken deterministically and reported", () => {
  const build = () => compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "z-tb", playerId: 1, playerName: "Zeta Hitter", market: "TB" }),
    candidate({ candidateId: "a-tb", playerId: 3, playerName: "Alpha Hitter", market: "TB" }),
    candidate({ candidateId: "z-walk", playerId: 2, playerName: "Zephyr Walker", market: "WALK" }),
    candidate({ candidateId: "a-walk", playerId: 4, playerName: "Able Walker", market: "WALK" }),
  ]);
  const first = build();
  const second = build();
  const winner = first.away.bestConstruction!;
  assert.deepEqual(
    winner.legs.map((leg) => leg.playerName),
    second.away.bestConstruction!.legs.map((leg) => leg.playerName),
    "the same winner on repeated runs",
  );
  assert.equal(winner.tieBroken, true, "the operator must be told a coin flip occurred");
  assert.ok(winner.tiedWith.length > 0);
});

test("a non-tied side reports no tie and keeps its rejected alternatives", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "strong-tb", playerId: 1, market: "TB", researchState: "STRONG", researchRank: 1 }),
    candidate({ candidateId: "strong-walk", playerId: 2, market: "WALK", researchState: "STRONG", researchRank: 1 }),
    candidate({ candidateId: "weak-walk", playerId: 3, market: "WALK", researchState: "NEGATIVE", researchRank: 40 }),
  ]);
  const winner = result.away.bestConstruction!;
  assert.equal(winner.tieBroken, false);
  assert.deepEqual(winner.tiedWith, []);
  assert.equal(result.away.rejectedAlternatives.length, 1);
  assert.ok(winner.legs.some((leg) => leg.candidateId === "strong-walk"));
});

test("missing market research remains distinct from a route-level missing lineup signal", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [], {
    lineupSource: "FANTASYPROS,MISSING",
    evidenceGaps: ["Missing selected lineup snapshot for one or both teams"],
  });
  assert.equal(result.away.availabilityStatus, "NO_MARKET_CANDIDATES");
  assert.ok(result.noPairCauses.includes("MISSING_FANTASYPROS_LINEUP"));
  assert.ok(result.evidenceGaps.some((gap) => gap.includes("Missing selected lineup")));
  assert.equal(result.comparisonStatus, "NO_COMPARISON");
});

test("identity, starter, and stale research gates retain their specific causes", () => {
  const identity = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "identity-tb", playerId: 1, selectable: false, selectionBlockReason: "UNRESOLVED_IDENTITY" }),
  ]);
  assert.equal(identity.away.availabilityStatus, "UNRESOLVED_IDENTITY");

  const starter = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "starter-tb", playerId: 1, selectable: false, selectionBlockReason: "BLOCKED", starterState: "TBD" }),
  ]);
  assert.equal(starter.away.availabilityStatus, "MISSING_STARTER");

  const stale = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({
      candidateId: "stale-tb",
      playerId: 1,
      selectable: false,
      selectionBlockReason: "STALE",
      evidenceFreshness: "STALE",
      evidenceFreshnessDetail: "Bullpen ledger is stale.",
    }),
  ]);
  assert.equal(stale.away.availabilityStatus, "STALE_OR_INCOMPLETE_RESEARCH");
  assert.match(stale.away.availabilityDetail ?? "", /Bullpen ledger is stale/);
});

test("exact comparisons are reported as valid ties without selecting a side", () => {
  const result = compareRoundRobinGame("RR2", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-tb", side: "AWAY", playerId: 1, market: "TB", researchRank: 1 }),
    candidate({ candidateId: "away-walk", side: "AWAY", playerId: 2, market: "WALK", researchRank: 2 }),
    candidate({ candidateId: "home-tb", side: "HOME", team: "HOME", playerId: 3, market: "TB", researchRank: 1 }),
    candidate({ candidateId: "home-walk", side: "HOME", team: "HOME", playerId: 4, market: "WALK", researchRank: 2 }),
  ]);
  assert.equal(result.selectedSide, null);
  assert.equal(result.comparisonStatus, "VALID_TIE");
  assert.match(result.comparisonReason, /EXACT_TIE/);
});

test("different construction labels do not break an otherwise exact comparison tie", () => {
  const result = compareRoundRobinGame("RR5", 1, "AWAY", "HOME", [
    candidate({ candidateId: "away-tb-1", side: "AWAY", playerId: 1, market: "TB", researchRank: 2 }),
    candidate({ candidateId: "away-tb-2", side: "AWAY", playerId: 2, market: "TB", researchRank: 3 }),
    candidate({ candidateId: "home-tb", side: "HOME", team: "HOME", playerId: 3, market: "TB", researchRank: 4 }),
    candidate({ candidateId: "home-walk", side: "HOME", team: "HOME", playerId: 4, market: "WALK", researchRank: 1 }),
  ]);
  assert.equal(result.away.bestConstruction?.constructionLabel, "Same-team TB + TB");
  assert.equal(result.home.bestConstruction?.constructionLabel, "Same-team TB + Walk");
  assert.equal(result.selectedSide, null);
  assert.equal(result.comparisonStatus, "VALID_TIE");
});
