export type RoundRobinBoardId = "RR1" | "RR2" | "RR3" | "RR4" | "RR5";
export type RoundRobinSide = "AWAY" | "HOME";
export type RoundRobinMarket = "TB" | "XBH" | "WALK" | "HR";

export type RoundRobinAvailabilityStatus =
  | "AVAILABLE"
  | "NO_LINEUP"
  | "UNRESOLVED_IDENTITY"
  | "MISSING_STARTER"
  | "STALE_OR_INCOMPLETE_RESEARCH"
  | "NO_MARKET_CANDIDATES"
  | "NO_LEGAL_CONSTRUCTION"
  | "UNSUPPORTED_BOARD";
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
  evidenceFreshnessDetail: string | null;
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
  availabilityStatus: RoundRobinAvailabilityStatus;
  availabilityDetail: string | null;
  unavailableReason: string | null;
};

export type RoundRobinGameComparison = {
  gamePk: number;
  away: RoundRobinSideComparison;
  home: RoundRobinSideComparison;
  selectedSide: RoundRobinSide | null;
  selectedConstruction: RoundRobinConstruction | null;
  comparisonStatus: RoundRobinComparisonStatus;
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
    evidenceSummary: `${posted ? "posted lineups" : "projected lineups"} · ${confirmedStarter ? "confirmed starters" : "starter context"} · 2/2 current bullpen role paths · ${arsenalAvailable}/2 arsenal comparisons · ${bvpAvailable}/2 named-pair contexts`,
  };
}

function compareConstruction(a: RoundRobinConstruction, b: RoundRobinConstruction) {
  if (a.stateTotal !== b.stateTotal) return b.stateTotal - a.stateTotal;
  if (a.rankTotal !== b.rankTotal) return a.rankTotal - b.rankTotal;
  const freshnessA = a.legs.filter((leg) => leg.lineupState === "POSTED").length;
  const freshnessB = b.legs.filter((leg) => leg.lineupState === "POSTED").length;
  if (freshnessA !== freshnessB) return freshnessB - freshnessA;
  return 0;
}

function compareConstructionWithinSide(a: RoundRobinConstruction, b: RoundRobinConstruction) {
  const comparison = compareConstruction(a, b);
  if (comparison) return comparison;
  return a.constructionLabel.localeCompare(b.constructionLabel);
}
function best(pairs: RoundRobinConstruction[]) {
  return pairs.sort(compareConstructionWithinSide)[0] ?? null;
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

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
function bullpenSummary(issues: BullpenPathIssue[]) {
  return [...new Set(issues.map((issue) =>
    `${issue.status === "STALE" ? "Stale" : "Incomplete"} bullpen path: ${issue.reason}`,
  ))].join(" ");
}

function sideResult(
  board: RoundRobinBoardId,
  side: RoundRobinSide,
  team: string,
  candidates: RoundRobinCandidate[],
  suppliedContext?: RoundRobinSideContext,
): RoundRobinSideComparison {
  const own = candidates.filter((candidate) => candidate.side === side);
  const context = suppliedContext ?? defaultContext(own);
  const ownBullpenIssues = own
    .map((candidate) => bullpenPathIssue(candidate))
    .filter((issue): issue is BullpenPathIssue => issue !== null);
  const eligible = candidates.filter((candidate) =>
    candidate.selectable
      && candidate.starterState !== "UNKNOWN"
      && candidate.starterState !== "TBD"
      && bullpenPathIssue(candidate) === null,
  );
  const constructions = pairCandidates(board, side, eligible);
  const bestConstruction = best(constructions);
  const unavailable = bestConstruction ? null : unavailableDiagnostic(board, own, context, ownBullpenIssues);
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
    availabilityStatus: unavailable?.availabilityStatus ?? "AVAILABLE",
    availabilityDetail: unavailable?.availabilityDetail ?? null,
    unavailableReason: unavailable?.availabilityDetail ?? null,
  };
}

function decision(away: RoundRobinSideComparison, home: RoundRobinSideComparison) {
  if (!away.bestConstruction && !home.bestConstruction) {
    return {
      selectedSide: null,
      selectedConstruction: null,
      comparisonStatus: "NO_COMPARISON" as const,
      comparisonReason: `Neither team has a legal construction. Away: ${away.availabilityDetail} Home: ${home.availabilityDetail}`,
    };
  }
  if (!away.bestConstruction) {
    return {
      selectedSide: "HOME" as const,
      selectedConstruction: home.bestConstruction,
      comparisonStatus: "SELECTED" as const,
      comparisonReason: `Home wins because away is unavailable: ${away.availabilityDetail}`,
    };
  }
  if (!home.bestConstruction) {
    return {
      selectedSide: "AWAY" as const,
      selectedConstruction: away.bestConstruction,
      comparisonStatus: "SELECTED" as const,
      comparisonReason: `Away wins because home is unavailable: ${home.availabilityDetail}`,
    };
  }
  const order = compareConstruction(away.bestConstruction, home.bestConstruction);
  if (order === 0) {
    return {
      selectedSide: null,
      selectedConstruction: null,
      comparisonStatus: "VALID_TIE" as const,
      comparisonReason: "Valid comparison tie: both sides have the same evidence tier, combined ordinal rank, and lineup freshness. No side is silently preferred.",
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
  contexts?: Partial<Record<RoundRobinSide, RoundRobinSideContext>>,
): RoundRobinGameComparison {
  const away = sideResult(board, "AWAY", awayTeam, candidates, contexts?.AWAY);
  const home = sideResult(board, "HOME", homeTeam, candidates, contexts?.HOME);
  const selected = decision(away, home);
  return { gamePk, away, home, ...selected };
}

export type RoundRobinSideContext = {
  lineup: {
    present: boolean;
    state: "POSTED" | "PROJECTED" | "UNKNOWN";
    source: string | null;
    observedAt: string | null;
    hitterCount: number;
  };
  research: {
    usable: boolean;
    readinessStatus: string;
    readinessReason: string | null;
    observedAt: string | null;
  };
};

function contextDetail(context: RoundRobinSideContext) {
  const lineup = context.lineup;
  const observed = lineup.observedAt ? ` observed ${lineup.observedAt}` : "";
  const source = lineup.source ?? "not found";
  return `Lineup ${lineup.state} from ${source}${observed}; ${lineup.hitterCount} mapped hitter${lineup.hitterCount === 1 ? "" : "s"}.`;
}

function blockSummary(candidates: RoundRobinCandidate[]) {
  const counts = countBy(candidates
    .filter((candidate) => !candidate.selectable || ["UNKNOWN", "TBD"].includes(candidate.starterState))
    .map((candidate) => {
      if (["UNKNOWN", "TBD"].includes(candidate.starterState)) return "missing or unknown starter";
      if (candidate.selectionBlockReason === "UNRESOLVED_IDENTITY") return "unresolved identity";
      if (candidate.selectionBlockReason === "STALE") return "stale research";
      if (candidate.selectionBlockReason === "INCOMPLETE_EVIDENCE") return "incomplete research";
      return candidate.selectionBlockReason?.replaceAll("_", " ").toLowerCase() ?? "safety-blocked research";
    }));
  const entries = Object.entries(counts).map(([reason, count]) => `${count} ${reason}`);
  return entries.length ? ` Safety gates: ${entries.join("; ")}.` : "";
}

function freshnessDetail(candidates: RoundRobinCandidate[]) {
  const details = [...new Set(candidates
    .map((candidate) => candidate.evidenceFreshnessDetail?.trim())
    .filter((detail): detail is string => Boolean(detail)))];
  return details.length ? ` Evidence detail: ${details.slice(0, 3).join(" · ")}.` : "";
}

function defaultContext(own: RoundRobinCandidate[]): RoundRobinSideContext {
  return {
    // The comparison service may be exercised without route-provided lineage.
    // In that case an empty candidate set is unknown research, not proof that a
    // lineup is absent.
    lineup: {
      present: true,
      state: own[0]?.lineupState ?? "UNKNOWN",
      source: null,
      observedAt: null,
      hitterCount: own.length,
    },
    research: {
      usable: true,
      readinessStatus: "UNKNOWN",
      readinessReason: null,
      observedAt: null,
    },
  };
}

export type RoundRobinComparisonStatus = "SELECTED" | "NO_COMPARISON" | "VALID_TIE";

function unavailableDiagnostic(
  board: RoundRobinBoardId,
  own: RoundRobinCandidate[],
  context: RoundRobinSideContext,
  bullpenIssues: BullpenPathIssue[],
) {
  if (board === "RR3") {
    return {
      availabilityStatus: "UNSUPPORTED_BOARD" as const,
      availabilityDetail: "2+ H+R+RBI is unsupported, so no legal RR3 pair can be constructed.",
    };
  }

  if (!context.lineup.present) {
    return {
      availabilityStatus: "NO_LINEUP" as const,
      availabilityDetail: `No projected or posted lineup is available. ${contextDetail(context)}`,
    };
  }

  if (!own.length) {
    if (!context.research.usable) {
      return {
        availabilityStatus: "STALE_OR_INCOMPLETE_RESEARCH" as const,
        availabilityDetail: `No market candidates can be evaluated because research is not current or complete. ${researchDetail(context)}`,
      };
    }
    return {
      availabilityStatus: "NO_MARKET_CANDIDATES" as const,
      availabilityDetail: `No market candidates were produced for this lineup. ${contextDetail(context)}`,
    };
  }

  const unresolvedIdentity = own.filter((candidate) => candidate.selectionBlockReason === "UNRESOLVED_IDENTITY");
  if (unresolvedIdentity.length === own.length) {
    return {
      availabilityStatus: "UNRESOLVED_IDENTITY" as const,
      availabilityDetail: `${own.length} market candidate${own.length === 1 ? "" : "s"} cannot be used because identity is unresolved.${blockSummary(own)}`,
    };
  }

  const missingStarter = own.filter((candidate) => ["UNKNOWN", "TBD"].includes(candidate.starterState));
  if (missingStarter.length === own.length) {
    const states = [...new Set(missingStarter.map((candidate) => candidate.starterState))].join(", ");
    return {
      availabilityStatus: "MISSING_STARTER" as const,
      availabilityDetail: `${own.length} market candidate${own.length === 1 ? "" : "s"} cannot be used because the opposing starter is ${states}.${blockSummary(own)}`,
    };
  }

  const staleOrIncomplete = own.filter((candidate) =>
    candidate.evidenceFreshness !== "CURRENT"
    || candidate.selectionBlockReason === "STALE"
    || candidate.selectionBlockReason === "INCOMPLETE_EVIDENCE",
  );
  if (!context.research.usable || staleOrIncomplete.length === own.length) {
    return {
      availabilityStatus: "STALE_OR_INCOMPLETE_RESEARCH" as const,
      availabilityDetail: !context.research.usable
        ? `Research is not current or complete for selection. ${researchDetail(context)}${blockSummary(own)}`
        : `${staleOrIncomplete.length} market candidate${staleOrIncomplete.length === 1 ? "" : "s"} have stale or incomplete research.${blockSummary(own)}${freshnessDetail(staleOrIncomplete)}`,
    };
  }

  if (bullpenIssues.length === own.length) {
    return {
      availabilityStatus: "STALE_OR_INCOMPLETE_RESEARCH" as const,
      availabilityDetail: `${own.length} market candidate${own.length === 1 ? "" : "s"} cannot be used because ${bullpenSummary(bullpenIssues)}`,
    };
  }

  return {
    availabilityStatus: "NO_LEGAL_CONSTRUCTION" as const,
    availabilityDetail: `${own.length} market candidate${own.length === 1 ? "" : "s"} were audited, but none form a legal ${board} construction.${blockSummary(own)}${bullpenIssues.length ? ` ${bullpenSummary(bullpenIssues)}` : ""}`,
  };
}

function researchDetail(context: RoundRobinSideContext) {
  const observed = context.research.observedAt ? ` observed ${context.research.observedAt}` : "";
  const gate = context.research.readinessReason ?? "the current-date research health gate is not usable";
  return `Research readiness ${context.research.readinessStatus}${observed}: ${gate}`;
}
