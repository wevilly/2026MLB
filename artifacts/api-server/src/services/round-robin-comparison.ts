export type RoundRobinBoardId = "RR1" | "RR2" | "RR3" | "RR4" | "RR5";
export type RoundRobinSide = "AWAY" | "HOME";
export type RoundRobinMarket = "TB" | "XBH" | "WALK" | "HR";

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
  lineupState: "POSTED" | "PROJECTED" | "UNKNOWN";
  starterState: string;
  bvpStatus: string;
  bvpEvidence: unknown | null;
  arsenalStatus: string;
  evidenceFreshness: "CURRENT" | "STALE" | "INCOMPLETE";
  primaryMechanism: string | null;
  opportunityEvidence: Record<string, unknown>;
  starterMatchupEvidence: Record<string, unknown>;
  bullpenPathEvidence: Record<string, unknown>;
  parkEvidence: Record<string, unknown>;
  counterEvidence: Record<string, unknown>;
};

export type RoundRobinConstruction = {
  constructionType: "TB_TB" | "TB_WALK" | "XBH_WALK" | "HR_HR";
  constructionLabel: string;
  side: RoundRobinSide;
  legs: RoundRobinCandidate[];
  stateTotal: number;
  rankTotal: number;
  evidenceSummary: string;
};

export type RoundRobinSideComparison = {
  side: RoundRobinSide;
  team: string;
  evaluatedEligibleHitters: number;
  evaluatedIneligibleHitters: number;
  consideredConstructionTypes: RoundRobinConstruction["constructionType"][];
  bestConstruction: RoundRobinConstruction | null;
  unavailableReason: string | null;
};

export type RoundRobinGameComparison = {
  gamePk: number;
  away: RoundRobinSideComparison;
  home: RoundRobinSideComparison;
  selectedSide: RoundRobinSide | null;
  selectedConstruction: RoundRobinConstruction | null;
  comparisonReason: string;
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
  const posted = legs.every((leg) => leg.lineupState === "POSTED");
  const confirmedStarter = legs.every((leg) => leg.starterState === "CONFIRMED");
  const arsenalAvailable = legs.filter((leg) => leg.arsenalStatus === "AVAILABLE").length;
  const bvpAvailable = legs.filter((leg) => leg.bvpStatus === "AVAILABLE").length;
  return {
    constructionType,
    constructionLabel,
    side,
    legs,
    stateTotal,
    rankTotal,
    evidenceSummary: `${posted ? "posted lineups" : "projected lineups"} · ${confirmedStarter ? "confirmed starters" : "starter context"} · ${arsenalAvailable}/2 arsenal comparisons · ${bvpAvailable}/2 named-pair contexts`,
  };
}

function compareConstruction(a: RoundRobinConstruction, b: RoundRobinConstruction) {
  if (a.stateTotal !== b.stateTotal) return b.stateTotal - a.stateTotal;
  if (a.rankTotal !== b.rankTotal) return a.rankTotal - b.rankTotal;
  const freshnessA = a.legs.filter((leg) => leg.lineupState === "POSTED").length;
  const freshnessB = b.legs.filter((leg) => leg.lineupState === "POSTED").length;
  if (freshnessA !== freshnessB) return freshnessB - freshnessA;
  return a.constructionLabel.localeCompare(b.constructionLabel);
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
  requireSameTeam: boolean,
) {
  const output: RoundRobinConstruction[] = [];
  for (const first of left) {
    for (const second of right) {
      if (first.playerId === second.playerId) continue;
      // Same-market arrays are compared against themselves. Canonicalize before
      // evidence sorting so each unordered pair appears exactly once.
      if (left === right && first.candidateId >= second.candidateId) continue;
      if (requireSameTeam && first.team !== second.team) continue;
      output.push(pair(side, constructionType, constructionLabel, first, second));
    }
  }
  return output;
}

function pairCandidates(board: RoundRobinBoardId, side: RoundRobinSide, eligible: RoundRobinCandidate[]) {
  const own = eligible.filter((candidate) => candidate.side === side);
  const other = eligible.filter((candidate) => candidate.side !== side);
  const ownByMarket = (market: RoundRobinMarket) => own.filter((candidate) => candidate.market === market);
  const allByMarket = (market: RoundRobinMarket) => eligible.filter((candidate) => candidate.market === market);
  const tb = ownByMarket("TB");
  const allTb = allByMarket("TB");
  const tbSame = uniquePairs(tb, tb, side, "TB_TB", "Same-team TB + TB", true);
  const tbCross = uniquePairs(tb, allTb.filter((candidate) => candidate.side !== side), side, "TB_TB", "Cross-team TB + TB", false);
  const tbWalk = uniquePairs(tb, ownByMarket("WALK"), side, "TB_WALK", "Same-team TB + Walk", true);
  const xbhWalk = uniquePairs(ownByMarket("XBH"), ownByMarket("WALK"), side, "XBH_WALK", "Same-team XBH + Walk", true);
  const hrHr = uniquePairs(ownByMarket("HR"), ownByMarket("HR"), side, "HR_HR", "Same-team HR + HR", true);
  if (board === "RR1") return [...tbSame, ...tbCross];
  if (board === "RR2") return tbWalk;
  if (board === "RR3") return [];
  if (board === "RR4") return xbhWalk;
  return [...tbSame, ...tbCross, ...tbWalk, ...xbhWalk, ...hrHr];
}

function sideResult(board: RoundRobinBoardId, side: RoundRobinSide, team: string, candidates: RoundRobinCandidate[]): RoundRobinSideComparison {
  const own = candidates.filter((candidate) => candidate.side === side);
  const eligible = candidates.filter((candidate) => candidate.selectable && candidate.starterState !== "UNKNOWN" && candidate.starterState !== "TBD");
  const constructions = pairCandidates(board, side, eligible);
  const bestConstruction = best(constructions);
  const unavailableReason = board === "RR3"
    ? "2+ H+R+RBI is unsupported, so no legal RR3 pair can be constructed."
    : !bestConstruction
      ? own.length === 0
        ? "No projected or posted hitters were found for this team."
        : "No complete legal pair remains after identity, freshness, starter, and evidence safety gates."
      : null;
  return {
    side,
    team,
    evaluatedEligibleHitters: eligible.filter((candidate) => candidate.side === side).length,
    evaluatedIneligibleHitters: own.filter((candidate) => !candidate.selectable || candidate.starterState === "UNKNOWN" || candidate.starterState === "TBD").length,
    consideredConstructionTypes: [...new Set(constructions.map((construction) => construction.constructionType))],
    bestConstruction,
    unavailableReason,
  };
}

function decision(away: RoundRobinSideComparison, home: RoundRobinSideComparison) {
  if (!away.bestConstruction && !home.bestConstruction) {
    return { selectedSide: null, selectedConstruction: null, comparisonReason: "Neither team has a complete legal construction after the current safety gates." };
  }
  if (!away.bestConstruction) {
    return { selectedSide: "HOME" as const, selectedConstruction: home.bestConstruction, comparisonReason: `Home wins because away is unavailable: ${away.unavailableReason}` };
  }
  if (!home.bestConstruction) {
    return { selectedSide: "AWAY" as const, selectedConstruction: away.bestConstruction, comparisonReason: `Away wins because home is unavailable: ${home.unavailableReason}` };
  }
  const order = compareConstruction(away.bestConstruction, home.bestConstruction);
  if (order === 0) {
    return { selectedSide: null, selectedConstruction: null, comparisonReason: "Both sides have the same evidence tier, combined ordinal rank, and lineup freshness. No side is silently preferred." };
  }
  const winner = order < 0 ? away.bestConstruction : home.bestConstruction;
  const loser = order < 0 ? home.bestConstruction : away.bestConstruction;
  return {
    selectedSide: winner.side,
    selectedConstruction: winner,
    comparisonReason: `${winner.side === "AWAY" ? away.team : home.team} wins: evidence tier ${winner.stateTotal} vs ${loser.stateTotal}; combined ordinal rank ${winner.rankTotal} vs ${loser.rankTotal}.`,
  };
}

export function compareRoundRobinGame(
  board: RoundRobinBoardId,
  gamePk: number,
  awayTeam: string,
  homeTeam: string,
  candidates: RoundRobinCandidate[],
): RoundRobinGameComparison {
  const away = sideResult(board, "AWAY", awayTeam, candidates);
  const home = sideResult(board, "HOME", homeTeam, candidates);
  const selected = decision(away, home);
  return { gamePk, away, home, ...selected };
}