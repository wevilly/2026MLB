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

type BullpenPathIssue = {
  status: "STALE" | "MISSING" | "ROLE_INCOMPLETE";
  reason: string;
};

function bullpenPathIssue(candidate: RoundRobinCandidate): BullpenPathIssue | null {
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
    if (completeDistinctPath) return null;
    return {
      status: "ROLE_INCOMPLETE",
      reason: "CURRENT bullpen evidence is missing a complete, distinct projected 7th/8th/9th arm path.",
    };
  }
  if (status === "STALE") return { status, reason: readableReason };
  if (status === "MISSING" || status === "ROLE_INCOMPLETE") {
    return { status, reason: readableReason };
  }
  // Candidate rows created before the role-path contract stored only a generic
  // bullpen average. They must not silently remain usable after this safety gate.
  return {
    status: "MISSING",
    reason: "Bullpen path status is missing; generic bullpen evidence cannot be used for Round Robin selection.",
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
  const lineupEvidence = legs.every((leg) => leg.lineupState === "CONFIRMED")
    ? "FantasyPros confirmed lineups"
    : legs.every((leg) => leg.lineupState === "PROJECTED")
      ? "FantasyPros projected lineups"
      : "FantasyPros mixed confirmed/projected lineups";
  const confirmedStarter = legs.every((leg) => leg.starterState === "CONFIRMED");
  const arsenalAvailable = legs.filter((leg) => leg.arsenalStatus === "AVAILABLE").length;
  const bvpAvailable = legs.filter((leg) => leg.bvpStatus === "AVAILABLE").length;
  const mechanismNames = legs.map((leg) => leg.primaryMechanism).filter(Boolean);
  const sharedMechanism = mechanismNames.length === 2 && mechanismNames[0] === mechanismNames[1]
    ? `Shared mechanism: ${mechanismNames[0]}`
    : "Shared mechanism: complementary market evidence across both legs";
  const legCases = legs.map((leg) => ({
    candidateId: leg.candidateId,
    caseFor: `${leg.playerName}: ${leg.primaryMechanism ?? "market-specific evidence"} with ordinal rank ${leg.researchRank ?? "unranked"}.`,
    counterCase: Object.keys(leg.counterEvidence).length
      ? `Counter-case: ${Object.keys(leg.counterEvidence).join(", ")}.`
      : "Counter-case: none recorded.",
    missingOrStale: leg.evidenceFreshness === "CURRENT"
      ? "No stale evidence flag."
      : `${leg.evidenceFreshness} evidence: ${leg.selectionBlockReason ?? "review required"}.`,
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
    evidenceSummary: `${lineupEvidence} · ${confirmedStarter ? "confirmed starters" : "starter context"} · ${arsenalAvailable}/2 arsenal comparisons · ${bvpAvailable}/2 named-pair contexts`,
    legCases,
    sharedMechanism,
    geometry,
    runnerUpComparison: null,
    rejectedAlternatives: [],
  };
}

function compareConstruction(a: RoundRobinConstruction, b: RoundRobinConstruction) {
  if (a.stateTotal !== b.stateTotal) return b.stateTotal - a.stateTotal;
  if (a.rankTotal !== b.rankTotal) return a.rankTotal - b.rankTotal;
  const lineupFreshness = (lineupState: string) =>
    lineupState === "CONFIRMED" ? 2 : lineupState === "PROJECTED" ? 1 : 0;
  const freshnessA = a.legs.reduce((total, leg) => total + lineupFreshness(leg.lineupState), 0);
  const freshnessB = b.legs.reduce((total, leg) => total + lineupFreshness(leg.lineupState), 0);
  if (freshnessA !== freshnessB) return freshnessB - freshnessA;
  return 0;
}

function best(pairs: RoundRobinConstruction[]) {
  return pairs.sort(compareConstruction)[0] ?? null;
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
  const ownBullpenIssues = own
    .map((candidate) => ({ candidate, issue: bullpenPathIssue(candidate) }))
    .filter((item): item is { candidate: RoundRobinCandidate; issue: BullpenPathIssue } => item.issue !== null);
  const eligible = candidates.filter((candidate) =>
    candidate.selectable
      && candidate.starterState !== "UNKNOWN"
      && candidate.starterState !== "TBD"
      && bullpenPathIssue(candidate) === null,
  );
  const constructions = pairCandidates(board, side, eligible);
  const bestConstruction = best(constructions);
  const causes: RoundRobinNoPairCause[] = [];
  if (!bestConstruction) {
    if (!own.length) causes.push("MISSING_MARKET_CANDIDATES");
    if (own.some((candidate) => ["UNKNOWN", "TBD"].includes(candidate.starterState))) causes.push("STARTER_UNCERTAINTY");
    if (own.some((candidate) => candidate.selectionBlockReason === "STALE" || candidate.selectionBlockReason === "INCOMPLETE_EVIDENCE" || bullpenPathIssue(candidate) !== null)) {
      causes.push("STALE_OR_INCOMPLETE_RESEARCH");
    }
    if (own.some((candidate) => candidate.selectionBlockReason === "UNRESOLVED_IDENTITY")) causes.push("IDENTITY_CONFLICT");
    if (!causes.length) causes.push("NO_LEGAL_SAME_TEAM_PAIR");
  }
  const bullpenReason = ownBullpenIssues.length > 0
    ? [...new Set(ownBullpenIssues.map((item) =>
      `${item.issue.status === "STALE" ? "Stale" : "Incomplete"} bullpen path: ${item.issue.reason}`,
    ))].join(" ")
    : null;
  const unavailableReason = !bestConstruction
      ? own.length === 0
        ? "No projected or posted hitters were found for this team."
        : bullpenReason
          ? `No complete legal pair remains because ${bullpenReason}`
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
  return {
    side,
    team,
    evaluatedEligibleHitters: eligible.filter((candidate) => candidate.side === side).length,
    evaluatedIneligibleHitters: own.filter((candidate) =>
      !candidate.selectable
        || candidate.starterState === "UNKNOWN"
        || candidate.starterState === "TBD"
        || bullpenPathIssue(candidate) !== null,
    ).length,
    consideredConstructionTypes: [...new Set(constructions.map((construction) => construction.constructionType))],
    bestConstruction,
    availabilityStatus,
    availabilityDetail: unavailableReason,
    unavailableReason,
    noPairCauses: causes,
    rejectedAlternatives: constructions.slice(1).map((construction) => `${construction.constructionLabel}: retained as runner-up audit alternative.`),
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
