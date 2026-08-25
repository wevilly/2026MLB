/**
 * The Round Robin Excel export.
 *
 * Two things are being guarded here. First, that the workbook is a real .xlsx
 * package Excel can open: a readable zip, the parts the format requires, and
 * the rows inside them. Second, and more important, that flattening the boards
 * into a grid does not quietly drop the three contracts the comparison layer
 * exists to keep: the losing side is retained, ties are surfaced rather than
 * collapsed, and no betting value is ever written.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { compareRoundRobinGame, type RoundRobinCandidate } from "../artifacts/api-server/src/services/round-robin-comparison.ts";
import type {
  buildRoundRobinWorkbook as BuildWorkbook,
  buildRoundRobinWorkbookSheets as BuildSheets,
  describeEvidence as DescribeEvidence,
  RoundRobinWorkbookInput,
} from "../artifacts/api-server/src/services/round-robin-workbook.ts";
import type { columnLetter as ColumnLetter, writeXlsx as WriteXlsx } from "../artifacts/api-server/src/services/xlsx-workbook.ts";
import { bundleService } from "./helpers/bundle.ts";

// The api-server sources use extensionless relative imports, which bare node
// does not resolve. Both modules are pure, so bundling them is enough.
const workbookModule = bundleService("artifacts/api-server/src/services/round-robin-workbook.ts") as Promise<{
  buildRoundRobinWorkbook: typeof BuildWorkbook;
  buildRoundRobinWorkbookSheets: typeof BuildSheets;
  describeEvidence: typeof DescribeEvidence;
}>;
const xlsxModule = bundleService("artifacts/api-server/src/services/xlsx-workbook.ts") as Promise<{
  columnLetter: typeof ColumnLetter;
  writeXlsx: typeof WriteXlsx;
}>;

const SLATE_DATE = "2026-08-25";

function candidate(overrides: Partial<RoundRobinCandidate>): RoundRobinCandidate {
  const id = overrides.candidateId ?? `${overrides.side ?? "AWAY"}-${overrides.market ?? "TB"}-${overrides.playerId ?? 1}`;
  return {
    candidateId: id,
    gamePk: overrides.gamePk ?? 777001,
    playerId: overrides.playerId ?? 1,
    playerName: overrides.playerName ?? id,
    market: overrides.market ?? "TB",
    researchRank: overrides.researchRank ?? 1,
    researchState: overrides.researchState ?? "POSITIVE",
    side: overrides.side ?? "AWAY",
    team: overrides.team ?? (overrides.side === "HOME" ? "HOU" : "NYY"),
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
    opportunityEvidence: { lineupSlot: 2, projectedPlateAppearances: 4.3 },
    starterMatchupEvidence: { starterPlayerId: 5001, starterState: "CONFIRMED", sampleSize: 61 },
    bullpenPathEvidence: {
      status: "CURRENT",
      rolePath: [
        { slot: "7TH", playerId: 701, role: "SETUP" },
        { slot: "8TH", playerId: 801, role: "PRIMARY_SETUP" },
        { slot: "9TH", playerId: 901, role: "CLOSER" },
      ],
    },
    parkEvidence: { venue: "Yankee Stadium", sampleSize: 120 },
    counterEvidence: {},
    sourceLineage: { lineupSource: "FANTASYPROS", lineupState: "PROJECTED", starterSource: "FANTASYPROS" },
    sampleDenominators: { starter: 61, bullpen: 44, park: 120 },
    ...overrides,
  };
}

/** A slate with one clearly selected game and one exact tie. */
function boards(): RoundRobinWorkbookInput["boards"] {
  const selected = compareRoundRobinGame("RR2", 777001, "NYY", "HOU", [
    candidate({ candidateId: "away-tb", side: "AWAY", team: "NYY", playerId: 1, playerName: "Away Slugger", market: "TB", researchState: "STRONG", researchRank: 1 }),
    candidate({ candidateId: "away-walk", side: "AWAY", team: "NYY", playerId: 2, playerName: "Away Patient", market: "WALK", researchState: "POSITIVE", researchRank: 2 }),
    candidate({ candidateId: "home-tb", side: "HOME", team: "HOU", playerId: 3, playerName: "Home Slugger", market: "TB", researchState: "NEUTRAL", researchRank: 8 }),
    candidate({ candidateId: "home-walk", side: "HOME", team: "HOU", playerId: 4, playerName: "Home Patient", market: "WALK", researchState: "NEUTRAL", researchRank: 9 }),
  ], { lineupState: "PROJECTED,PROJECTED", lineupSource: "FANTASYPROS,FANTASYPROS", starterState: "CONFIRMED", evidenceGaps: [] });

  const tied = compareRoundRobinGame("RR2", 777002, "BOS", "TOR", [
    candidate({ gamePk: 777002, candidateId: "bos-tb", side: "AWAY", team: "BOS", playerId: 11, playerName: "Boston Slugger", market: "TB", researchState: "POSITIVE", researchRank: 3 }),
    candidate({ gamePk: 777002, candidateId: "bos-walk", side: "AWAY", team: "BOS", playerId: 12, playerName: "Boston Patient", market: "WALK", researchState: "POSITIVE", researchRank: 4 }),
    candidate({ gamePk: 777002, candidateId: "tor-tb", side: "HOME", team: "TOR", playerId: 13, playerName: "Toronto Slugger", market: "TB", researchState: "POSITIVE", researchRank: 3 }),
    candidate({ gamePk: 777002, candidateId: "tor-walk", side: "HOME", team: "TOR", playerId: 14, playerName: "Toronto Patient", market: "WALK", researchState: "POSITIVE", researchRank: 4 }),
  ], { lineupState: "PROJECTED,PROJECTED", lineupSource: "FANTASYPROS,FANTASYPROS", starterState: "CONFIRMED", evidenceGaps: [] });

  return [{ board: "RR2", games: [selected, tied] }];
}

function workbookInput(): RoundRobinWorkbookInput {
  return {
    slateDate: SLATE_DATE,
    generatedAt: "2026-08-25T18:00:00.000Z",
    boards: boards(),
    readiness: {
      status: "READY",
      usable: true,
      reason: "Slate ingest is complete.",
      reasons: ["FantasyPros ingest complete"],
      currentDate: SLATE_DATE,
      requestedDate: SLATE_DATE,
      isCurrentDate: true,
      observedAt: "2026-08-25T18:00:00.000Z",
    },
    prohibitedFields: ["odds", "price", "expectedValue"],
  };
}

/** Walks the local file headers of the zip, which carry their own sizes. */
function readZip(buffer: Buffer) {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, inflateRawSync(data).toString("utf8"));
    offset = dataStart + compressedSize;
  }
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50, "end of central directory record is missing");
  return entries;
}

async function sheet(name: string) {
  const { buildRoundRobinWorkbookSheets } = await workbookModule;
  const found = buildRoundRobinWorkbookSheets(workbookInput()).find((entry) => entry.name === name);
  assert.ok(found, `expected a ${name} sheet`);
  return found;
}

async function cell(sheetName: string, rowIndex: number, header: string) {
  const target = await sheet(sheetName);
  const column = target.headers.indexOf(header);
  assert.ok(column >= 0, `expected a ${header} column on ${sheetName}`);
  return target.rows[rowIndex]?.[column];
}

test("the workbook carries every surface an operator reads", async () => {
  const { buildRoundRobinWorkbookSheets } = await workbookModule;
  const names = buildRoundRobinWorkbookSheets(workbookInput()).map((entry) => entry.name);
  assert.deepEqual(names, ["Read me", "Selections", "Legs", "Sides considered", "Games", "Board summary"]);
});

test("a selected game reports the construction and both legs on one row", async () => {
  assert.equal(await cell("Selections", 0, "Game PK"), 777001);
  assert.equal(await cell("Selections", 0, "Comparison status"), "SELECTED");
  assert.equal(await cell("Selections", 0, "Selected side"), "AWAY");
  assert.equal(await cell("Selections", 0, "Selected team"), "NYY");
  assert.equal(await cell("Selections", 0, "Construction type"), "TB_WALK");
  assert.equal(await cell("Selections", 0, "Leg 1 player"), "Away Slugger");
  assert.equal(await cell("Selections", 0, "Leg 1 market"), "2+ Total Bases");
  assert.equal(await cell("Selections", 0, "Leg 2 player"), "Away Patient");
  assert.equal(await cell("Selections", 0, "Leg 2 market"), "1+ Batter Walk");
});

test("the losing side is retained, not dropped for being unselected", async () => {
  const sides = await sheet("Sides considered");
  const gameColumn = sides.headers.indexOf("Game PK");
  const sideColumn = sides.headers.indexOf("Side");
  const selectedColumn = sides.headers.indexOf("Selected");
  const legsColumn = sides.headers.indexOf("Best construction legs");
  const home = sides.rows.find((row) => row[gameColumn] === 777001 && row[sideColumn] === "HOME");
  assert.ok(home, "expected the home side of the selected game to be on the sheet");
  assert.equal(home[selectedColumn], false);
  assert.match(String(home[legsColumn]), /Home Slugger/);
});

test("an exact tie is surfaced with no selected construction", async () => {
  assert.equal(await cell("Selections", 1, "Comparison status"), "VALID_TIE");
  assert.equal(await cell("Selections", 1, "Selected side"), "");
  assert.equal(await cell("Selections", 1, "Construction type"), "");

  const sides = await sheet("Sides considered");
  const gameColumn = sides.headers.indexOf("Game PK");
  assert.equal(sides.rows.filter((row) => row[gameColumn] === 777002).length, 2, "both sides of a tie stay on the sheet");

  const summary = await sheet("Board summary");
  assert.equal(summary.rows[0][summary.headers.indexOf("Valid ties")], 1);
  assert.equal(summary.rows[0][summary.headers.indexOf("Selected")], 1);
});

test("every leg of a selected construction carries its evidence", async () => {
  const legs = await sheet("Legs");
  assert.equal(legs.rows.length, 2, "only the selected construction contributes legs");
  const first = legs.rows[0];
  assert.equal(first[legs.headers.indexOf("Player")], "Away Slugger");
  assert.equal(first[legs.headers.indexOf("Research state")], "STRONG");
  assert.equal(first[legs.headers.indexOf("Selectable")], true);
  assert.match(String(first[legs.headers.indexOf("Opportunity evidence")]), /lineupSlot: 2/);
  assert.match(String(first[legs.headers.indexOf("Bullpen path evidence")]), /CLOSER/);
  assert.match(String(first[legs.headers.indexOf("Source lineage")]), /FANTASYPROS/);
});

test("nested evidence flattens into one readable cell", async () => {
  const { describeEvidence } = await workbookModule;
  assert.equal(describeEvidence({ a: 1, b: "two" }), "a: 1; b: two");
  assert.equal(describeEvidence([{ slot: "9TH" }, { slot: "8TH" }]), "slot: 9TH; slot: 8TH");
  assert.equal(describeEvidence(null), "");
  assert.equal(describeEvidence({ empty: null }), "");
});

test("the workbook is a zip Excel can open", async () => {
  const { buildRoundRobinWorkbook } = await workbookModule;
  const { workbook, filename } = buildRoundRobinWorkbook(workbookInput());
  assert.equal(filename, `mlb-round-robins-${SLATE_DATE}-RR2.xlsx`);
  assert.equal(workbook.subarray(0, 2).toString("utf8"), "PK");

  const entries = readZip(workbook);
  for (const required of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(entries.has(required), `expected ${required} in the package`);
  }
  assert.equal([...entries.keys()].filter((name) => name.startsWith("xl/worksheets/")).length, 6);
  assert.match(entries.get("xl/workbook.xml") ?? "", /name="Selections"/);
  assert.match(entries.get("xl/worksheets/sheet2.xml") ?? "", /Away Slugger/);
  assert.match(entries.get("xl/worksheets/sheet2.xml") ?? "", /<pane ySplit="1"/);
});

test("the same rows always produce the same bytes", async () => {
  const { buildRoundRobinWorkbook } = await workbookModule;
  const first = buildRoundRobinWorkbook(workbookInput()).workbook;
  const second = buildRoundRobinWorkbook(workbookInput()).workbook;
  assert.ok(first.equals(second));
});

test("no betting value reaches the workbook", async () => {
  const { buildRoundRobinWorkbook } = await workbookModule;
  const { workbook } = buildRoundRobinWorkbook(workbookInput());
  // Sheet 1 is the Read me, whose whole job is to state which of these the
  // platform permanently excludes. The data sheets are the ones under guard.
  const sheets = [...readZip(workbook)]
    .filter(([name]) => name.startsWith("xl/worksheets/") && name !== "xl/worksheets/sheet1.xml")
    .map(([, xml]) => xml)
    .join("\n")
    .toLowerCase();
  for (const forbidden of ["payout", "implied probability", "expected value", "closing line", "vig", "bankroll", "moneyline"]) {
    assert.ok(!sheets.includes(forbidden), `the workbook must never carry ${forbidden}`);
  }
});

test("cells that would break the format are handled rather than emitted", async () => {
  const { writeXlsx } = await xlsxModule;
  const bytes = writeXlsx([{
    name: "Sheet:with/illegal*chars and a name far past the Excel limit",
    headers: ["Text", "Number", "Flag"],
    rows: [["a & b < c", 42, true], ["x".repeat(40_000), Number.NaN, false]],
  }]);
  const entries = readZip(bytes);
  const sheetName = /name="([^"]+)"/.exec(entries.get("xl/workbook.xml") ?? "")?.[1] ?? "";
  assert.ok(sheetName.length <= 31, "sheet names are truncated to what Excel accepts");
  assert.ok(!/[\\/?*[\]:]/.test(sheetName), "illegal sheet name characters are removed");

  const sheetXml = entries.get("xl/worksheets/sheet1.xml") ?? "";
  assert.match(sheetXml, /a &amp; b &lt; c/);
  assert.match(sheetXml, /\[truncated\]/);
  assert.match(sheetXml, /NaN/);
});

test("column references keep going past Z", async () => {
  const { columnLetter } = await xlsxModule;
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(51), "AZ");
  assert.equal(columnLetter(52), "BA");
});
