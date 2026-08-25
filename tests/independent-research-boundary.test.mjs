import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");

test("FantasyPros is retained as reference lineage and cannot write market candidates", async () => {
  const baseline = await read("artifacts/api-server/src/services/fantasypros-baseline.ts");

  assert.match(baseline, /INSERT INTO fantasypros_reference_ranks/);
  assert.doesNotMatch(baseline, /INSERT INTO market_research_candidates/);
  assert.match(baseline, /comparison-only and never create, sort, or overwrite a research candidate/i);
});

test("daily research orchestration does not train or promote models", async () => {
  const orchestration = await read("artifacts/api-server/src/services/orchestration.ts");

  assert.match(orchestration, /slate_matchup_refresh/);
  assert.doesNotMatch(orchestration, /model_training/);
  assert.doesNotMatch(orchestration, /trainAndValidateMarkets/);
});

test("H+R+RBI has an independent rank rather than inheriting the TB rank", async () => {
  const engine = await read("artifacts/api-server/src/services/hrrbi-engine.ts");

  assert.match(engine, /RANK\(\) OVER \(ORDER BY hrrbi_score DESC, player_id\) AS independent_rank/);
  assert.match(engine, /r\.independent_rank/);
  assert.doesNotMatch(engine, /tb\.research_rank/);
  assert.doesNotMatch(engine, /tb\.research_state/);
  assert.match(engine, /BvP is secondary context only/);
});

test("the board refresh and public contract keep the same research-only boundary", async () => {
  const [board, contract] = await Promise.all([
    read("artifacts/api-server/src/services/daily-market-board.ts"),
    read("lib/api-spec/openapi.yaml"),
  ]);

  assert.match(board, /mrc\.research_state NOT IN/);
  assert.doesNotMatch(board, /mrc\.market <> 'HITS_RUNS_RBI_2_PLUS'/);
  assert.doesNotMatch(contract, /modelPrediction|calibratedProbability|confidenceLabel|confidenceBasis/);
});