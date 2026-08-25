/**
 * The Round Robin comparison boards, rendered as an Excel workbook.
 *
 * This is derived output. The platform remains the official record, and the
 * workbook carries nothing the comparison API does not already carry: no odds,
 * prices, expected value, closing line value, vig, stake sizes or implied
 * probabilities. It is a flattening, not a new surface.
 *
 * Three contracts from the comparison layer are preserved here rather than
 * being collapsed for the sake of a tidy grid:
 *
 * - The losing side is kept. "Sides considered" carries the away and the home
 *   construction for every game, whether or not it was selected.
 * - Ties are surfaced. A VALID_TIE game has no selected construction, and both
 *   sides' constructions are on the sheet with the tie recorded.
 * - Disclosures are disclosures. Bullpen caveats, evidence gaps, no-pair causes
 *   and rejected alternatives all get their own columns instead of vanishing.
 *
 * The builder is pure: it takes comparison output and returns sheets, so it can
 * be tested without a database.
 */
import { writeXlsx, type XlsxCell, type XlsxSheet } from "./xlsx-workbook";
import type {
  RoundRobinBoardId,
  RoundRobinCandidate,
  RoundRobinConstruction,
  RoundRobinGameComparison,
  RoundRobinSideComparison,
} from "./round-robin-comparison";

export type RoundRobinBoardExport = {
  board: RoundRobinBoardId;
  games: RoundRobinGameComparison[];
};

export type RoundRobinWorkbookInput = {
  slateDate: string;
  generatedAt: string;
  boards: RoundRobinBoardExport[];
  readiness: {
    status: string;
    usable: boolean;
    reason: string;
    reasons: string[];
    currentDate: string;
    requestedDate: string;
    isCurrentDate: boolean;
    observedAt: string;
  };
  prohibitedFields: string[];
};

export const BOARD_LABELS: Record<RoundRobinBoardId, string> = {
  RR1: "RR1: TB + TB",
  RR2: "RR2: TB + Walk",
  RR3: "RR3: XBH + H+R+RBI",
  RR4: "RR4: XBH + Walk",
  RR5: "RR5: strongest legal construction from RR1 through RR4",
};

const MARKET_LABELS: Record<RoundRobinCandidate["market"], string> = {
  TB: "2+ Total Bases",
  XBH: "1+ Extra Base Hit",
  WALK: "1+ Batter Walk",
  HR: "1+ Home Run",
  H_R_RBI: "2+ H+R+RBI",
};

/**
 * Renders a nested evidence object as one readable cell. Evidence is stored as
 * open JSON, so the alternative is either dropping it or exploding the column
 * count per slate. Neither is honest about what the platform holds.
 */
export function describeEvidence(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (depth > 3) return "[nested]";
    return value.map((entry) => describeEvidence(entry, depth + 1)).filter(Boolean).join("; ");
  }
  if (typeof value === "object") {
    if (depth > 3) return "[nested]";
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const rendered = describeEvidence(entry, depth + 1);
        return rendered === "" ? null : `${key}: ${rendered}`;
      })
      .filter((entry): entry is string => entry !== null)
      .join("; ");
  }
  return String(value);
}

function list(values: readonly string[] | undefined) {
  return values && values.length ? values.join(" | ") : "";
}

function marketLabel(market: RoundRobinCandidate["market"]) {
  return MARKET_LABELS[market] ?? market;
}

function legCase(construction: RoundRobinConstruction, candidateId: string) {
  return construction.legCases.find((entry) => entry.candidateId === candidateId) ?? null;
}

const READ_ME_HEADERS = ["Field", "Value"];

function readMeSheet(input: RoundRobinWorkbookInput): XlsxSheet {
  const totals = input.boards.map((board) => {
    const selected = board.games.filter((game) => game.comparisonStatus === "SELECTED").length;
    const tied = board.games.filter((game) => game.comparisonStatus === "VALID_TIE").length;
    return `${board.board}: ${board.games.length} games, ${selected} selected, ${tied} tied`;
  });
  const rows: XlsxCell[][] = [
    ["Slate date", input.slateDate],
    ["Generated at", input.generatedAt],
    ["Official record", "MLB Analyst Platform. This workbook is derived output."],
    ["What this is not", "No odds, prices, expected value, closing line value, vig, stake sizes or implied probabilities. FIRE, HALF, HOLD and NONE are confidence labels, not stake sizes."],
    ["Readiness status", input.readiness.status],
    ["Readiness usable", input.readiness.usable],
    ["Readiness reason", input.readiness.reason],
    ["Readiness detail", list(input.readiness.reasons)],
    ["Requested date", input.readiness.requestedDate],
    ["Current slate date", input.readiness.currentDate],
    ["Is current date", input.readiness.isCurrentDate],
    ["Readiness observed at", input.readiness.observedAt],
    ["Fields permanently excluded", list(input.prohibitedFields)],
    ["", ""],
    ["Sheet: Selections", "One row per board per game: the construction the comparison selected, with both legs side by side."],
    ["Sheet: Legs", "One row per leg of every selected construction, with the evidence behind it."],
    ["Sheet: Sides considered", "Away and home together, including the side that lost the comparison and the games with no selection."],
    ["Sheet: Games", "Game level status, lineup and starter state, evidence gaps and no-pair causes."],
    ["Sheet: Board summary", "Counts per board."],
    ["", ""],
    ...input.boards.map((board) => [BOARD_LABELS[board.board] ?? board.board, ""] as XlsxCell[]),
    ["", ""],
    ...totals.map((total) => ["Coverage", total] as XlsxCell[]),
  ];
  return { name: "Read me", headers: READ_ME_HEADERS, rows, columnWidths: [34, 96] };
}

const SELECTION_HEADERS = [
  "Board", "Slate date", "Game PK", "Away", "Home", "Comparison status", "Selected side", "Selected team",
  "Comparison reason", "Construction type", "Construction label", "Shared mechanism", "Geometry",
  "State total", "Rank total", "Tie broken", "Tied with", "Bullpen path complete", "Bullpen caveat",
  "Leg 1 player", "Leg 1 market", "Leg 1 research rank", "Leg 1 research state",
  "Leg 2 player", "Leg 2 market", "Leg 2 research rank", "Leg 2 research state",
  "Evidence summary", "Runner up comparison", "Rejected alternatives",
  "Lineup state", "Lineup source", "Starter state", "Evidence gaps", "No pair causes",
];

function selectionRow(
  board: RoundRobinBoardId,
  slateDate: string,
  game: RoundRobinGameComparison,
): XlsxCell[] {
  const construction = game.selectedConstruction;
  const [first, second] = construction?.legs ?? [];
  const selectedTeam = game.selectedSide === "AWAY"
    ? game.away.team
    : game.selectedSide === "HOME"
    ? game.home.team
    : "";
  return [
    board, slateDate, game.gamePk, game.away.team, game.home.team,
    game.comparisonStatus, game.selectedSide ?? "", selectedTeam, game.comparisonReason,
    construction?.constructionType ?? "", construction?.constructionLabel ?? "",
    construction?.sharedMechanism ?? "", construction?.geometry ?? "",
    construction?.stateTotal ?? null, construction?.rankTotal ?? null,
    construction ? construction.tieBroken : "", list(construction?.tiedWith),
    construction ? construction.bullpenPathComplete : "", construction?.bullpenCaveat ?? "",
    first?.playerName ?? "", first ? marketLabel(first.market) : "", first?.researchRank ?? null, first?.researchState ?? "",
    second?.playerName ?? "", second ? marketLabel(second.market) : "", second?.researchRank ?? null, second?.researchState ?? "",
    construction?.evidenceSummary ?? "", construction?.runnerUpComparison ?? "",
    list(construction?.rejectedAlternatives),
    game.lineupState, game.lineupSource, game.starterState,
    list(game.evidenceGaps), list(game.noPairCauses),
  ];
}

const LEG_HEADERS = [
  "Board", "Slate date", "Game PK", "Away", "Home", "Side", "Team", "Construction label", "Leg",
  "Player", "Player ID", "Candidate ID", "Market", "Research rank", "Research state",
  "Selectable", "Selection block reason", "Lineup state", "Starter state", "Primary mechanism",
  "Evidence freshness", "Evidence freshness detail", "Arsenal status", "Batter vs pitcher status",
  "Case for", "Counter case", "Missing or stale", "Opportunity evidence", "Starter matchup evidence",
  "Bullpen path evidence", "Park evidence", "Counter evidence", "Batter vs pitcher evidence",
  "Source lineage", "Sample denominators",
];

function legRows(
  board: RoundRobinBoardId,
  slateDate: string,
  game: RoundRobinGameComparison,
  construction: RoundRobinConstruction,
): XlsxCell[][] {
  return construction.legs.map((leg, index) => {
    const supporting = legCase(construction, leg.candidateId);
    return [
      board, slateDate, game.gamePk, game.away.team, game.home.team,
      construction.side, leg.team, construction.constructionLabel, index + 1,
      leg.playerName, leg.playerId, leg.candidateId, marketLabel(leg.market),
      leg.researchRank ?? null, leg.researchState,
      leg.selectable, leg.selectionBlockReason ?? "", leg.lineupState, leg.starterState,
      leg.primaryMechanism ?? "", leg.evidenceFreshness, leg.evidenceFreshnessDetail ?? "",
      leg.arsenalStatus, leg.bvpStatus,
      supporting?.caseFor ?? "", supporting?.counterCase ?? "", supporting?.missingOrStale ?? "",
      describeEvidence(leg.opportunityEvidence), describeEvidence(leg.starterMatchupEvidence),
      describeEvidence(leg.bullpenPathEvidence), describeEvidence(leg.parkEvidence),
      describeEvidence(leg.counterEvidence), describeEvidence(leg.bvpEvidence),
      describeEvidence(leg.sourceLineage), describeEvidence(leg.sampleDenominators),
    ];
  });
}

const SIDE_HEADERS = [
  "Board", "Slate date", "Game PK", "Away", "Home", "Side", "Team", "Selected",
  "Availability status", "Availability detail", "Unavailable reason",
  "Eligible hitters evaluated", "Ineligible hitters evaluated", "Considered construction types",
  "Best construction type", "Best construction label", "Best construction legs",
  "State total", "Rank total", "Shared mechanism", "Geometry", "Bullpen path complete",
  "Bullpen caveat", "Tie broken", "Tied with", "Evidence summary", "Runner up comparison",
  "Rejected alternatives", "Bullpen disclosures", "No pair causes",
];

function sideRow(
  board: RoundRobinBoardId,
  slateDate: string,
  game: RoundRobinGameComparison,
  comparison: RoundRobinSideComparison,
): XlsxCell[] {
  const construction = comparison.bestConstruction;
  return [
    board, slateDate, game.gamePk, game.away.team, game.home.team,
    comparison.side, comparison.team, game.selectedSide === comparison.side,
    comparison.availabilityStatus, comparison.availabilityDetail ?? "", comparison.unavailableReason ?? "",
    comparison.evaluatedEligibleHitters, comparison.evaluatedIneligibleHitters,
    list(comparison.consideredConstructionTypes),
    construction?.constructionType ?? "", construction?.constructionLabel ?? "",
    construction ? construction.legs.map((leg) => `${leg.playerName} (${marketLabel(leg.market)})`).join(" + ") : "",
    construction?.stateTotal ?? null, construction?.rankTotal ?? null,
    construction?.sharedMechanism ?? "", construction?.geometry ?? "",
    construction ? construction.bullpenPathComplete : "", construction?.bullpenCaveat ?? "",
    construction ? construction.tieBroken : "", list(construction?.tiedWith),
    construction?.evidenceSummary ?? "", construction?.runnerUpComparison ?? "",
    list(construction?.rejectedAlternatives ?? comparison.rejectedAlternatives),
    list(comparison.bullpenDisclosures), list(comparison.noPairCauses),
  ];
}

const GAME_HEADERS = [
  "Board", "Slate date", "Game PK", "Away", "Home", "Comparison status", "Selected side",
  "Comparison reason", "Lineup state", "Lineup source", "Starter state",
  "Away availability", "Home availability", "Evidence gaps", "No pair causes",
];

const SUMMARY_HEADERS = [
  "Board", "Board construction", "Games", "Selected", "Valid ties", "No comparison",
  "Constructions surfaced", "Legs surfaced", "Constructions with a bullpen caveat", "Games with evidence gaps",
];

/** Builds every sheet in the workbook, in the order an operator reads them. */
export function buildRoundRobinWorkbookSheets(input: RoundRobinWorkbookInput): XlsxSheet[] {
  const selections: XlsxCell[][] = [];
  const legs: XlsxCell[][] = [];
  const sides: XlsxCell[][] = [];
  const games: XlsxCell[][] = [];
  const summary: XlsxCell[][] = [];

  for (const board of input.boards) {
    let constructionCount = 0;
    let legCount = 0;
    let caveatCount = 0;
    for (const game of board.games) {
      selections.push(selectionRow(board.board, input.slateDate, game));
      if (game.selectedConstruction) {
        legs.push(...legRows(board.board, input.slateDate, game, game.selectedConstruction));
      }
      for (const comparison of [game.away, game.home]) {
        sides.push(sideRow(board.board, input.slateDate, game, comparison));
        if (comparison.bestConstruction) {
          constructionCount += 1;
          legCount += comparison.bestConstruction.legs.length;
          if (comparison.bestConstruction.bullpenCaveat) caveatCount += 1;
        }
      }
      games.push([
        board.board, input.slateDate, game.gamePk, game.away.team, game.home.team,
        game.comparisonStatus, game.selectedSide ?? "", game.comparisonReason,
        game.lineupState, game.lineupSource, game.starterState,
        game.away.availabilityStatus, game.home.availabilityStatus,
        list(game.evidenceGaps), list(game.noPairCauses),
      ]);
    }
    summary.push([
      board.board, BOARD_LABELS[board.board] ?? "", board.games.length,
      board.games.filter((game) => game.comparisonStatus === "SELECTED").length,
      board.games.filter((game) => game.comparisonStatus === "VALID_TIE").length,
      board.games.filter((game) => game.comparisonStatus === "NO_COMPARISON").length,
      constructionCount, legCount, caveatCount,
      board.games.filter((game) => game.evidenceGaps.length > 0).length,
    ]);
  }

  const wide = 44;
  return [
    readMeSheet(input),
    {
      name: "Selections",
      headers: SELECTION_HEADERS,
      rows: selections,
      columnWidths: SELECTION_HEADERS.map((header) =>
        header === "Comparison reason" || header === "Evidence summary" || header === "Runner up comparison"
        || header === "Rejected alternatives" || header === "Bullpen caveat" || header === "Evidence gaps"
          ? wide
          : 18),
    },
    {
      name: "Legs",
      headers: LEG_HEADERS,
      rows: legs,
      columnWidths: LEG_HEADERS.map((header) => (header.endsWith("evidence") || header === "Case for" || header === "Counter case" ? wide : 18)),
    },
    {
      name: "Sides considered",
      headers: SIDE_HEADERS,
      rows: sides,
      columnWidths: SIDE_HEADERS.map((header) =>
        header === "Evidence summary" || header === "Runner up comparison" || header === "Rejected alternatives"
        || header === "Bullpen disclosures" || header === "Best construction legs" || header === "Unavailable reason"
          ? wide
          : 18),
    },
    {
      name: "Games",
      headers: GAME_HEADERS,
      rows: games,
      columnWidths: GAME_HEADERS.map((header) => (header === "Comparison reason" || header === "Evidence gaps" ? wide : 18)),
    },
    { name: "Board summary", headers: SUMMARY_HEADERS, rows: summary, columnWidths: SUMMARY_HEADERS.map((header, index) => (index === 1 ? wide : 18)) },
  ];
}

/** The workbook bytes plus the filename the download should carry. */
export function buildRoundRobinWorkbook(input: RoundRobinWorkbookInput) {
  const boards = input.boards.map((board) => board.board).join("-");
  return {
    workbook: writeXlsx(buildRoundRobinWorkbookSheets(input)),
    filename: `mlb-round-robins-${input.slateDate}-${boards}.xlsx`,
  };
}
