/**
 * Tasks 3.1, 3.2 and 3.3 acceptance for the pure settlement rules.
 *
 * The transactional settle path needs a database and a live game feed and is
 * covered by the live acceptance suite. The grading rules, the walk definition
 * and the correction taxonomy are pure and are asserted here.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "../artifacts/api-server/node_modules/esbuild/lib/main.js";

const STUB = "export const pool = { query() { throw new Error('no database in this test'); } };\nexport const db = {};\n";

const settlement = (async () => {
  const result = await build({
    entryPoints: ["artifacts/api-server/src/services/settlement.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "settlement-stubs",
      setup(pluginBuild: any) {
        pluginBuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "settle-stub" }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "settle-stub" }, () => ({ contents: STUB, loader: "js" }));
      },
    }],
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
})();

describe("Task 3.2 the walk definition is stated, not buried", () => {
  test("the active policy names itself and admits it is an assumption", async () => {
    const { WALK_SETTLEMENT_POLICY, walkDefinitionLabel } = await settlement;
    assert.equal(typeof WALK_SETTLEMENT_POLICY.countIntentionalWalks, "boolean");
    assert.equal(typeof WALK_SETTLEMENT_POLICY.countHitByPitch, "boolean");
    assert.equal(WALK_SETTLEMENT_POLICY.assumed, true, "the policy has not been confirmed with the operator");
    assert.match(WALK_SETTLEMENT_POLICY.statement, /has not been\s+confirmed|has not been confirmed/);
    assert.equal(walkDefinitionLabel(), "BB+IBB (assumed)");
  });

  test("the label changes with the policy, so a re-grade is visible on the row", async () => {
    const { walkDefinitionLabel } = await settlement;
    assert.equal(
      walkDefinitionLabel({ countIntentionalWalks: false, countHitByPitch: true, assumed: false, statement: "" }),
      "BB-IBB+HBP",
    );
  });

  test("the components are persisted regardless of which definition is active", () => {
    const source = readFileSync("artifacts/api-server/src/services/settlement.ts", "utf8");
    const insert = source.slice(source.indexOf("INSERT INTO historical_outcomes"));
    for (const column of ["walks", "intentional_walks", "hit_by_pitch", "walk_definition"]) {
      assert.ok(insert.includes(column), `${column} must be persisted`);
    }
  });
});

describe("Task 3.2 total bases are cross-checked, not silently ignored", () => {
  test("the parsed reported field is compared against the recomputed value", () => {
    const source = readFileSync("artifacts/api-server/src/services/settlement.ts", "utf8");
    assert.ok(source.includes("reportedTotalBases"), "the reported field must be parsed");
    assert.ok(/Total bases disagree/.test(source), "a disagreement must be reported");
    assert.ok(/DISPUTED/.test(source), "a disagreement must not settle as though one value were right");
  });

  test("a disagreement is excluded from training by the settled-state filter", () => {
    for (const file of [
      "artifacts/api-server/src/services/model-training.ts",
      "artifacts/api-server/src/services/walk-forward-validation.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      assert.ok(source.includes("settlement_state = 'SETTLED'"), `${file} must filter to SETTLED`);
      assert.ok(source.includes("NOT ho.settled_without_snapshot"), `${file} must exclude snapshot-absent rows`);
    }
  });
});

describe("Task 3.3 every correction reason is reachable", () => {
  test("a postponed game that later completed is a resumption", async () => {
    const { classifyCorrection } = await settlement;
    assert.equal(classifyCorrection({
      priorState: "POSTPONED", newState: "SETTLED",
      priorHadPlateAppearances: false, newHasPlateAppearances: true,
      statLineChanged: true, lateScratch: false,
    }), "GAME_RESUMPTION");
  });

  test("a changed stat line on an already final game is an official stat correction", async () => {
    const { classifyCorrection } = await settlement;
    assert.equal(classifyCorrection({
      priorState: "SETTLED", newState: "SETTLED",
      priorHadPlateAppearances: true, newHasPlateAppearances: true,
      statLineChanged: true, lateScratch: false,
    }), "OFFICIAL_STAT_CORRECTION");
  });

  test("a player who lost his appearances was scratched", async () => {
    const { classifyCorrection } = await settlement;
    assert.equal(classifyCorrection({
      priorState: "SETTLED", newState: "NO_ACTION",
      priorHadPlateAppearances: true, newHasPlateAppearances: false,
      statLineChanged: true, lateScratch: false,
    }), "LATE_SCRATCH");
  });

  test("an explicit late scratch signal wins", async () => {
    const { classifyCorrection } = await settlement;
    assert.equal(classifyCorrection({
      priorState: "SETTLED", newState: "SETTLED",
      priorHadPlateAppearances: true, newHasPlateAppearances: true,
      statLineChanged: false, lateScratch: true,
    }), "LATE_SCRATCH");
  });

  test("anything else remains an ingest failure", async () => {
    const { classifyCorrection } = await settlement;
    assert.equal(classifyCorrection({
      priorState: "DISPUTED", newState: "SETTLED",
      priorHadPlateAppearances: true, newHasPlateAppearances: true,
      statLineChanged: false, lateScratch: false,
    }), "DATA_INGEST_FAILURE");
  });

  test("the taxonomy is no longer a constant", () => {
    const source = readFileSync("artifacts/api-server/src/services/settlement.ts", "utf8");
    assert.ok(
      !/const taxonomy = correctionOf \? "DATA_INGEST_FAILURE" : null/.test(source),
      "the hardcoded taxonomy must be gone",
    );
    assert.ok(source.includes("classifyCorrection({"), "the taxonomy must be classified from the transition");
  });

  test("the classified reason reaches createMarketPostmortem", () => {
    const source = readFileSync("artifacts/api-server/src/services/orchestration.ts", "utf8");
    assert.ok(
      source.includes("COALESCE(ho.process_error_taxonomy::text"),
      "the outcome's own taxonomy must be preferred over an unrelated source",
    );
  });

  test("both new taxonomy values exist in the schema and the migration", () => {
    const schema = readFileSync("lib/db/src/schema/foundation.ts", "utf8");
    const migration = readFileSync("lib/db/scripts/pre-push-migrations.mjs", "utf8");
    for (const value of ["GAME_RESUMPTION", "OFFICIAL_STAT_CORRECTION"]) {
      assert.ok(schema.includes(`"${value}"`), `${value} must be declared in the schema`);
      assert.ok(migration.includes(`'${value}'`), `${value} must be added by the migration`);
    }
  });
});

describe("Task 3.1 the settlement universe includes the board", () => {
  const source = readFileSync("artifacts/api-server/src/services/settlement.ts", "utf8");

  test("the loop iterates the union, not only frozen snapshots", () => {
    assert.ok(source.includes("FROM daily_market_board"), "the board must be consulted");
    assert.ok(source.includes("for (const [playerId, markets] of universe)"), "the loop must iterate the union");
    assert.ok(!source.includes("for (const [frozenPlayerId, markets] of frozenPlayers)"), "the old loop must be gone");
  });

  test("a board candidate with no snapshot is flagged rather than skipped", () => {
    assert.ok(source.includes("settledWithoutSnapshot"), "the flag must exist");
    assert.ok(source.includes("settled_without_snapshot"), "the flag must be persisted");
  });

  test("the reconciliation report names every candidate that could not settle", () => {
    assert.ok(source.includes("unsettleable"), "the report must list unsettleable candidates");
    assert.ok(/reason:\s*SHORT_MARKETS/.test(source), "each entry must carry a reason");
    assert.ok(source.includes("boardCandidates"), "the report must count board candidates");
  });

  test("an unsettleable board candidate blocks the nightly SUCCESS status", () => {
    const orchestration = readFileSync("artifacts/api-server/src/services/orchestration.ts", "utf8");
    const nightly = orchestration.slice(orchestration.indexOf("export async function runNightlySettlement"));
    assert.ok(nightly.includes("result.reconciliation?.unsettleable"), "the check must read the report");
    assert.ok(
      nightly.indexOf("could not be settled for") < nightly.indexOf("status = 'SUCCESS'"),
      "the check must run before SUCCESS is written",
    );
  });
});
