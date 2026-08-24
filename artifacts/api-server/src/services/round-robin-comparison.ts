export type RoundRobinBoardId = "RR1" | "RR2" | "RR3" | "RR4" | "RR5";
export type RoundRobinSide = "AWAY" | "HOME";
export type RoundRobinMarket = "TB" | "XBH" | "WALK" | "HR" | "H_R_RBI";

export type RoundRobinNoPairCause =
  | "MISSING_FANTASYPROS_LINEUP"
  | "MISSING_MARKET_CANDIDATES"
  | "STARTER_UNCERTAINTY"
  | "STALE_OR_INCOMPLETE_RESEARCH"
  | "IDENTITY_CONFLICT"
  | "NO_LEGAL_SAME_TEAM_PAIR"
  | "EXACT_TIE";
export type RoundRobinAvailabilityStatus =
  | "AVAILABLE"
  | "NO_MARKET_CANDIDATES"
  | "MISSING_STARTER"
  | "STALE_OR_INCOMPLETE_RESEARCH"
  | "UNRESOLVED_IDENTITY"
  | "NO_LEGAL_CONSTRUCTION";
export type RoundRobinCandidate = {
  candidateId: string;
  gamePk: number;
  playerId: number;
  playerName: string;
  market: RoundRobinMarket;
  researchRank: number | null;
  researchState: "STRONG" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "BLOCKED";
  side: RoundRobinSide;
  team: string;
  selectable: boolean;
  selectionBlockReason: string | null;
  lineupState: "POSTED" | "CONFIRMED" | "PROJECTED" | "UNKNOWN";
  starterState: string;
  bvpStatus: string;
  bvpEvidence: unknown | null;
  arsenalStatus: string;
  evidenceFreshness: "CURRENT" | "STALE" | "INCOMPLETE";
  evidenceFreshnessDetail?: string | null;
  primaryMechanism: string | null;
  opportunityEvidence: Record<string, unknown>;
  starterMatchupEvidence: Record<string, unknown>;
  bullpenPathEvidence: Record<string, unknown>;
  parkEvidence: Record<string, unknown>;
  counterEvidence: Record<string, unknown>;
  sourceLineage?: Record<string, unknown>;
  sampleDenominators?: Record<string, unknown>;
};

export type RoundRobinConstruction = {
  constructionType: "TB_TB" | "TB_WALK" | "XBH_H_R_RBI" | "XBH_WALK";
  constructionLabel: string;
  side: RoundRobinSide;
  legs: RoundRobinCandidate[];
  stateTotal: number;
  rankTotal: number;
  evidenceSummary: string;
  legCases: Array<{
    candidateId: string;
    caseFor: string;
    counterCase: string;
    missingOrStale: string;
  }>;
  sharedMechanism: string;
  geometry: string | null;
  runnerUpComparison: string | null;
  rejectedAlternatives: string[];
  /**
   * Whether both legs carry a complete, fresh, distinct projected 7th/8th/9th
   * bullpen path. This is a ranking input and a disclosure, never a veto.
   */
  bullpenPathComplete: boolean;
  /** Stated caveat when the bullpen path is not complete. Null when it is. */
  bullpenCaveat: string | null;
  /** True when this construction was chosen from an exactly tied set. */
  tieBroken: boolean;
  /** The constructions this one tied with on evidence, before the tiebreak. */
  tiedWith: string[];
};

export type RoundRobinSideComparison = {
  side: RoundRobinSide;
  team: string;
  evaluatedEligibleHitters: number;
  evaluatedIneligibleHitters: number;
  consideredConstructionTypes: RoundRobinConstruction["constructionType"][];
  bestConstruction: RoundRobinConstruction | null;
  availabilityStatus: RoundRobinAvailabilityStatus;
  availabilityDetail: string | null;
  unavailableReason: string | null;
  noPairCauses: RoundRobinNoPairCause[];
  rejectedAlternatives: string[];
  /**
   * Bullpen states on this side that are not a complete fresh path. Stated so
   * the operator sees them; they never remove a candidate from selection.
   */
  bullpenDisclosures: string[];
};

export type RoundRobinGameComparison = {
  gamePk: number;
  away: RoundRobinSideComparison;
  home: RoundRobinSideComparison;
  selectedSide: RoundRobinSide | null;
  selectedConstruction: RoundRobinConstruction | null;
  comparisonStatus: "SELECTED" | "NO_COMPARISON" | "VALID_TIE";
  comparisonReason: string;
  lineupState: string;
  lineupSource: string;
  starterState: string;
  evidenceGaps: string[];
  noPairCauses: RoundRobinNoPairCause[];
};

export type RoundRobinGameContext = {
  lineupState?: string;
  lineupSource?: string;
  starterState?: string;
  evidenceGaps?: string[];
};
const STATE_WEIGHT: Record<RoundRobinCandidate["researchState"], number> = {
  STRONG: 4,
  POSITIVE: 3,
  NEUTRAL: 2,
  NEGATIVE: 1,
  BLOCKED: 0,
};

function compareCandidate(a: RoundRobinCandidate, b: RoundRobinCandidate) {
  const state = STATE_WEIGHT[b.researchState] - STATE_WEIGHT[a.researchState];
  if (state) return state;
  const rank = (a.researchRank ?? Number.MAX_SAFE_INTEGER) - (b.researchRank ?? Number.MAX_SAFE_INTEGER);
  if (rank) return rank;
  return a.playerName.localeCompare(b.playerName);
}

/**
 * Bullpen path disclosure.
 *
 * RANK, DON'T GATE. This used to be a hard eligibility filter: any candidate
 * without a complete, distinct, fresh projected 7th/8th/9th arm path was
 * removed from selection entirely, which meant a single missing reliever
 * observation returned NO_LEGAL_CONSTRUCTION for a whole game even when both
 * hitters and the starting pitcher matchup were fully researched. A
 * third-order input was vetoing a first-order decision: for a 2+ total bases
 * prop the starter and the hitter's own profile dominate, and the projected
 * eighth-inning arm does not.
 *
 * Nothing about the bullpen makes a candidate ineligible any more. If a
 * specific bullpen state is ever believed to be disqualifying, it must be
 * justified with settled data before being reinstated, not assumed.
 */
export type BullpenPathDisclosure = {
  status: "CURRENT" | "STALE" | "MISSING" | "ROLE_INCOMPLETE";
  complete: boolean;
  reason: string | null;
};

export function bullpenPathDisclosure(candidate: RoundRobinCandidate): BullpenPathDisclosure {
  const status = candidate.bullpenPathEvidence.status;
  const reason = candidate.bullpenPathEvidence.reason;
  const readableReason = typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "No usable projected 7th/8th/9th bullpen path was recorded.";

  if (status === "CURRENT") {
    const rolePath = candidate.bullpenPathEvidence.rolePath;
    const requiredSlots = new Set(["7TH", "8TH", "9TH"]);
    const completeDistinctPath = Array.isArray(rolePath)
      && rolePath.length === 3
      && rolePath.every((arm) =>
        arm !== null
          && typeof arm === "object"
          && "slot" in arm
          && "playerId" in arm
          && typeof arm.slot === "string"
          && requiredSlots.has(arm.slot)
          && typeof arm.playerId === "number"
          && Number.isInteger(arm.playerId),
      )
      && new Set(rolePath.map((arm) => arm.slot)).size === 3
      && new Set(rolePath.map((arm) => arm.playerId)).size === 3;
    if (completeDistinctPath) return { status: "CURRENT", complete: true, reason: null };
    return {
      status: "ROLE_INCOMPLETE",
      complete: false,
      reason: "CURRENT bullpen evidence is missing a complete, distinct projected 7th/8th/9th arm path.",
    };
  }
  if (status === "STALE") return { status: "STALE", complete: false, reason: readableReason };
  if (status === "MISSING" || status === "ROLE_INCOMPLETE") {
    return { status: status as "MISSING" | "ROLE_INCOMPLETE", complete: false, reason: readableReason };
  }
  // Candidate rows created before the role-path contract stored only a generic
  // bullpen average. That is disclosed, not disqualifying.
  return {
    status: "MISSING",
    complete: false,
    reason: "Bullpen path status is missing; only generic bullpen evidence is recorded for this candidate.",
  };
}

function pair(
  side: RoundRobinSide,
  constructionType: RoundRobinConstruction["constructionType"],
  constructionLabel: string,
  first: RoundRobinCandidate,
  second: RoundRobinCandidate,
): RoundRobinConstruction {
  const legs = [first, second].sort(compareCandidate);
  const stateTotal = legs.reduce((total, leg) => total + STATE_WEIGHT[leg.researchState], 0);
  const rankTotal = legs.reduce((total, leg) => total + (leg.researchRank ?? 10_000), 0);
  // POSTED is a real state with a producer: data-foundation writes it from the
  // MLB Stats API game feed, and the lineup source precedence in
  // lineup-sources.ts now lets it reach here. It used to be declared on this
  // type with nothing ever producing it, and pair() branched on only two of the
  // four states.
  const lineupEvidence = legs.every((leg) => leg.lineupState === "POSTED")
    ? "MLB posted lineup cards"
    : legs.every((leg) => leg.lineupState === "CONFIRMED")
      ? "FantasyPros confirmed lineups"
      : legs.every((leg) => leg.lineupState === "PROJECTED")
        ? "FantasyPros projected lineups"
        : `mixed lineup states (${[...new Set(legs.map((leg) => leg.lineupState))].sort().join(", ")})`;
  const confirmedStarter = legs.every((leg) => leg.starterState === "CONFIRMED");
  const arsenalAvailable = legs.filter((leg) => leg.arsenalStatus === "AVAILABLE").length;
  const bvpAvailable = legs.filter((leg) => leg.bvpStatus === "AVAILABLE").length;
  const mechanismNames = legs.map((leg) => leg.primaryMechanism).filter(Boolean);
  const sharedMechanism = mechanismNames.length === 2 && mechanismNames[0] === mechanismNames[1]
    ? `Shared mechanism: ${mechanismNames[0]}`
    : "Shared mechanism: complementary market evidence across both legs";
  const bullpenByLeg = new Map(legs.map((leg) => [leg.candidateId, bullpenPathDisclosure(leg)]));
  const bullpenPathComplete = legs.every((leg) => bullpenByLeg.get(leg.candidateId)!.complete);
  const bullpenCaveat = bullpenPathComplete
    ? null
    : `Bullpen path incomplete: ${[...new Set(legs
      .map((leg) => bullpenByLeg.get(leg.candidateId)!)
      .filter((disclosure) => !disclosure.complete)
      .map((disclosure) => `${disclosure.status} - ${disclosure.reason}`))].join(" ")}`;
  const legCases = legs.map((leg) => ({
    candidateId: leg.candidateId,
    caseFor: `${leg.playerName}: ${leg.primaryMechanism ?? "market-specific evidence"} with ordinal rank ${leg.researchRank ?? "unranked"}.`,
    counterCase: Object.keys(leg.counterEvidence).length
      ? `Counter-case: ${Object.keys(leg.counterEvidence).join(", ")}.`
      : "Counter-case: none recorded.",
    missingOrStale: leg.evidenceFreshness === "CURRENT"
      ? "No stale evidence flag."
      : `${leg.evidenceFreshness} evidence: ${leg.selectionBlockReason ?? "review required"}.`,
    // The bullpen state is stated on every surfaced pair rather than being the
    // reason no pair exists.
    bullpenPath: bullpenByLeg.get(leg.candidateId)!.complete
      ? "Complete projected 7th/8th/9th path."
      : `${bullpenByLeg.get(leg.candidateId)!.status}: ${bullpenByLeg.get(leg.candidateId)!.reason}`,
  }));
  const [firstLeg, secondLeg] = legs;
  const firstOrder = typeof firstLeg.opportunityEvidence.battingOrder === "number"
    ? firstLeg.opportunityEvidence.battingOrder
    : null;
  const secondOrder = typeof secondLeg.opportunityEvidence.battingOrder === "number"
    ? secondLeg.opportunityEvidence.battingOrder
    : null;
  const orderText = firstOrder && secondOrder ? ` projected batting order ${firstOrder} + ${secondOrder}` : "";
  const geometry = constructionType === "TB_TB"
    ? `Two distinct 2+ TB hitters from the same offense; no repeated player.${orderText}`
    : constructionType === "TB_WALK"
      ? `Distinct 2+ TB and walk legs from the same offense; lineup opportunity is kept separate.${orderText}`
      : constructionType === "XBH_H_R_RBI"
        ? `Distinct XBH and H+R+RBI legs from the same offense; the production path is not counted twice.${orderText}`
        : `Distinct XBH and walk legs from the same offense; contact and patience paths remain separate.${orderText}`;
  return {
    constructionType,
    constructionLabel,
    side,
    legs,
    stateTotal,
    rankTotal,
    evidenceSummary: [
      lineupEvidence,
      confirmedStarter ? "confirmed starters" : "starter context",
      `${arsenalAvailable}/2 arsenal comparisons`,
      `${bvpAvailable}/2 named-pair contexts`,
      bullpenPathComplete ? "complete bullpen path" : "bullpen path incomplete",
    ].join(" · "),
    legCases,
    sharedMechanism,
    geometry,
    runnerUpComparison: null,
    rejectedAlternatives: [],
    bullpenPathComplete,
    bullpenCaveat,
    tieBroken: false,
    tiedWith: [],
  };
}

/** A stable, human-readable identity for one construction. */
function constructionIdentity(construction: RoundRobinConstruction) {
  return `${construction.constructionLabel}: ${construction.legs.map((leg) => leg.playerName).join(" + ")}`;
}

/**
 * The evidence comparator. Returns 0 for a genuine tie, which is what lets
 * decision() surface VALID_TIE across the two sides rather than silently
 * preferring one. Do not add a cosmetic tiebreak here: that would make the
 * cross-side tie unreachable and quietly delete the surfaced-ties contract.
 *
 * Bullpen path completeness is a term here, at the bottom of the order. That
 * is the correct weight for it: it separates two otherwise identical
 * constructions and nothing more.
 */
function compareConstruction(a: RoundRobinConstruction, b: RoundRobinConstruction) {
  if (a.stateTotal !== b.stateTotal) return b.stateTotal - a.stateTotal;
  if (a.rankTotal !== b.rankTotal) return a.rankTotal - b.rankTotal;
  // A submitted card is the most authoritative lineup there is, so POSTED ranks
  // above CONFIRMED. It scored zero here while it was an unproduced state.
  const lineupFreshness = (lineupState: string) =>
    lineupState === "POSTED" ? 3
      : lineupState === "CONFIRMED" ? 2
        : lineupState === "PROJECTED" ? 1
          : 0;
  const freshnessA = a.legs.reduce((total, leg) => total + lineupFreshness(leg.lineupState), 0);
  const freshnessB = b.legs.reduce((total, leg) => total + lineupFreshness(leg.lineupState), 0);
  if (freshnessA !== freshnessB) return freshnessB - freshnessA;
  const bullpenA = a.bullpenPathComplete ? 1 : 0;
  const bullpenB = b.bullpenPathComplete ? 1 : 0;
  if (bullpenA !== bullpenB) return bullpenB - bullpenA;
  return 0;
}

/**
 * The within-side ordering. Identical to the evidence comparator, then an
 * explicit alphabetical tiebreak on the combined leg names, which is the same
 * tiebreak tb-engine's assignCompetitionRanks already uses.
 *
 * The tiebreak lives here rather than in compareConstruction so that a genuine
 * evidence tie is still visible as one, and so the choice among tied
 * constructions is a stated rule rather than whichever pair the nested loops in
 * uniquePairs happened to build first.
 */
function compareConstructionDeterministic(a: RoundRobinConstruction, b: RoundRobinConstruction) {
  const evidence = compareConstruction(a, b);
  if (evidence) return evidence;
  return constructionIdentity(a).localeCompare(constructionIdentity(b));
}

export type BestConstructionResult = {
  /** Every construction that tied on evidence at the top. Never fewer than one when any exist. */
  tied: RoundRobinConstruction[];
  /** The single construction chosen, with the applied tiebreak recorded on it. */
  winner: RoundRobinConstruction | null;
  /** The full ordering, used to derive rejected alternatives without mutating the input. */
  ordered: RoundRobinConstruction[];
};

/**
 * Returns the tied set explicitly rather than an arbitrary member of it.
 *
 * The previous implementation sorted the caller's array in place and took
 * element zero, so a tie was resolved by whichever pair the nested loops built
 * first, and rejectedAlternatives worked only because that in-place mutation
 * happened to leave the array sorted.
 */
function best(pairs: RoundRobinConstruction[]): BestConstructionResult {
  if (!pairs.length) return { tied: [], winner: null, ordered: [] };
  const ordered = [...pairs].sort(compareConstructionDeterministic);
  const tied = ordered.filter((construction) => compareConstruction(construction, ordered[0]) === 0);
  const winner = ordered[0];
  winner.tieBroken = tied.length > 1;
  winner.tiedWith = tied.slice(1).map(constructionIdentity);
  return { tied, winner, ordered };
}

function uniquePairs(
  left: RoundRobinCandidate[],
  right: RoundRobinCandidate[],
  side: RoundRobinSide,
  constructionType: RoundRobinConstruction["constructionType"],
  constructionLabel: string,
) {
  const output: RoundRobinConstruction[] = [];
  for (const first of left) {
    for (const second of right) {
      if (first.playerId === second.playerId) continue;
      // Same-market arrays are compared against themselves. Canonicalize before
      // evidence sorting so each unordered pair appears exactly once.
      if (left === right && first.candidateId >= second.candidateId) continue;
      if (first.team !== second.team) continue;
      output.push(pair(side, constructionType, constructionLabel, first, second));
    }
  }
  return output;
}

function pairCandidates(board: RoundRobinBoardId, side: RoundRobinSide, eligible: RoundRobinCandidate[]) {
  const own = eligible.filter((candidate) => candidate.side === side);
  const ownByMarket = (market: RoundRobinMarket) => own.filter((candidate) => candidate.market === market);
  const tb = ownByMarket("TB");
  const tbSame = uniquePairs(tb, tb, side, "TB_TB", "Same-team TB + TB");
  const tbWalk = uniquePairs(tb, ownByMarket("WALK"), side, "TB_WALK", "Same-team TB + Walk");
  const xbhHrrbi = uniquePairs(ownByMarket("XBH"), ownByMarket("H_R_RBI"), side, "XBH_H_R_RBI", "Same-team XBH + H+R+RBI");
  const xbhWalk = uniquePairs(ownByMarket("XBH"), ownByMarket("WALK"), side, "XBH_WALK", "Same-team XBH + Walk");
  if (board === "RR1") return tbSame;
  if (board === "RR2") return tbWalk;
  if (board === "RR3") return xbhHrrbi;
  if (board === "RR4") return xbhWalk;
  return [...tbSame, ...tbWalk, ...xbhHrrbi, ...xbhWalk];
}

function sideResult(board: RoundRobinBoardId, side: RoundRobinSide, team: string, candidates: RoundRobinCandidate[]): RoundRobinSideComparison {
  const own = candidates.filter((candidate) => candidate.side === side);
  // Bullpen state is no longer part of eligibility. It is computed here only so
  // the incomplete cases can be disclosed on the surfaced pair.
  const ownBullpenDisclosures = own
    .map((candidate) => bullpenPathDisclosure(candidate))
    .filter((disclosure) => !disclosure.complete);
  const eligible = candidates.filter((candidate) =>
    candidate.selectable
      && candidate.starterState !== "UNKNOWN"
      && candidate.starterState !== "TBD",
  );
  const constructions = pairCandidates(board, side, eligible);
  const { winner: bestConstruction, ordered } = best(constructions);
  const causes: RoundRobinNoPairCause[] = [];
  if (!bestConstruction) {
    if (!own.length) causes.push("MISSING_MARKET_CANDIDATES");
    if (own.some((candidate) => ["UNKNOWN", "TBD"].includes(candidate.starterState))) causes.push("STARTER_UNCERTAINTY");
    // STALE_OR_INCOMPLETE_RESEARCH is no longer reachable from bullpen state
    // alone. Only the candidate's own selection block reason can produce it.
    if (own.some((candidate) => candidate.selectionBlockReason === "STALE" || candidate.selectionBlockReason === "INCOMPLETE_EVIDENCE")) {
      causes.push("STALE_OR_INCOMPLETE_RESEARCH");
    }
    if (own.some((candidate) => candidate.selectionBlockReason === "UNRESOLVED_IDENTITY")) causes.push("IDENTITY_CONFLICT");
    if (!causes.length) causes.push("NO_LEGAL_SAME_TEAM_PAIR");
  }
  const unavailableReason = !bestConstruction
      ? own.length === 0
        ? "No projected or posted hitters were found for this team."
        : own.some((candidate) => candidate.evidenceFreshness !== "CURRENT" && candidate.evidenceFreshnessDetail)
          ? `No complete legal pair remains because ${own.filter((candidate) => candidate.evidenceFreshness !== "CURRENT").map((candidate) => candidate.evidenceFreshnessDetail).filter(Boolean).join(" ")}`
          : "No complete legal pair remains after identity, freshness, starter, and evidence safety gates."
      : null;
  const availabilityStatus: RoundRobinAvailabilityStatus = bestConstruction
    ? "AVAILABLE"
    : causes.includes("MISSING_MARKET_CANDIDATES") ? "NO_MARKET_CANDIDATES"
      : causes.includes("STARTER_UNCERTAINTY") ? "MISSING_STARTER"
        : causes.includes("IDENTITY_CONFLICT") ? "UNRESOLVED_IDENTITY"
          : causes.includes("STALE_OR_INCOMPLETE_RESEARCH") ? "STALE_OR_INCOMPLETE_RESEARCH"
            : "NO_LEGAL_CONSTRUCTION";
  // Disclosed on an available side as a caveat, never as a reason for absence.
  const availabilityDetail = bestConstruction
    ? bestConstruction.bullpenCaveat
    : unavailableReason;
  return {
    side,
    team,
    evaluatedEligibleHitters: eligible.filter((candidate) => candidate.side === side).length,
    evaluatedIneligibleHitters: own.filter((candidate) =>
      !candidate.selectable
        || candidate.starterState === "UNKNOWN"
        || candidate.starterState === "TBD",
    ).length,
    consideredConstructionTypes: [...new Set(constructions.map((construction) => construction.constructionType))],
    bestConstruction,
    availabilityStatus,
    availabilityDetail,
    unavailableReason,
    noPairCauses: causes,
    // Derived from an explicitly sorted copy rather than from a sort side
    // effect on the caller's array.
    rejectedAlternatives: ordered.slice(1).map((construction) => `${construction.constructionLabel}: retained as runner-up audit alternative.`),
    bullpenDisclosures: [...new Set(ownBullpenDisclosures.map(
      (disclosure) => `${disclosure.status}: ${disclosure.reason}`,
    ))],
  };
}

function decision(away: RoundRobinSideComparison, home: RoundRobinSideComparison) {
  if (!away.bestConstruction && !home.bestConstruction) {
    return { selectedSide: null, selectedConstruction: null, comparisonStatus: "NO_COMPARISON" as const, comparisonReason: `No selected side. Away: ${away.unavailableReason} Home: ${home.unavailableReason}.` };
  }
  if (!away.bestConstruction) {
    return { selectedSide: "HOME" as const, selectedConstruction: home.bestConstruction, comparisonStatus: "SELECTED" as const, comparisonReason: `Home wins because away is unavailable: ${away.unavailableReason}` };
  }
  if (!home.bestConstruction) {
    return { selectedSide: "AWAY" as const, selectedConstruction: away.bestConstruction, comparisonStatus: "SELECTED" as const, comparisonReason: `Away wins because home is unavailable: ${home.unavailableReason}` };
  }
  const order = compareConstruction(away.bestConstruction, home.bestConstruction);
  if (order === 0) {
    return {
      selectedSide: null,
      selectedConstruction: null,
      comparisonStatus: "VALID_TIE" as const,
      comparisonReason: "EXACT_TIE: both sides have the same evidence tier, combined ordinal rank, and lineup freshness. No side is silently preferred.",
    };
  }
  const winner = order < 0 ? away.bestConstruction : home.bestConstruction;
  const loser = order < 0 ? home.bestConstruction : away.bestConstruction;
  return {
    selectedSide: winner.side,
    selectedConstruction: winner,
    comparisonStatus: "SELECTED" as const,
    comparisonReason: `${winner.side === "AWAY" ? away.team : home.team} wins: evidence tier ${winner.stateTotal} vs ${loser.stateTotal}; combined ordinal rank ${winner.rankTotal} vs ${loser.rankTotal}.`,
  };
}

export function compareRoundRobinGame(
  board: RoundRobinBoardId,
  gamePk: number,
  awayTeam: string,
  homeTeam: string,
  candidates: RoundRobinCandidate[],
  context: RoundRobinGameContext = {},
): RoundRobinGameComparison {
  const away = sideResult(board, "AWAY", awayTeam, candidates);
  const home = sideResult(board, "HOME", homeTeam, candidates);
  const selected = decision(away, home);
  const noPairCauses = [...new Set([...away.noPairCauses, ...home.noPairCauses])];
  if (context.lineupSource?.split(",").includes("MISSING")) noPairCauses.push("MISSING_FANTASYPROS_LINEUP");
  if (selected.comparisonReason.startsWith("EXACT_TIE")) noPairCauses.push("EXACT_TIE");
  return {
    gamePk,
    away,
    home,
    ...selected,
    lineupState: context.lineupState ?? "UNKNOWN",
    lineupSource: context.lineupSource ?? "UNKNOWN",
    starterState: context.starterState ?? "UNKNOWN",
    evidenceGaps: context.evidenceGaps ?? [],
    noPairCauses: [...new Set(noPairCauses)],
  };
}
