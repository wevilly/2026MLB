/**
 * Task 1.5 acceptance for the promotion gate.
 *
 * The transactional promotion itself needs a database and is covered by the
 * live acceptance suite. Every condition that decides whether a version may be
 * promoted is pure, and is asserted here: an operator must be told which single
 * condition failed, not simply told no.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "../artifacts/api-server/node_modules/esbuild/lib/main.js";
import {
  CALIBRATION_ECE_THRESHOLD,
  MIN_FOLD_COUNT,
  SHARPNESS_MIN_STD_DEV,
} from "../artifacts/api-server/src/services/model-math.ts";

const STUBS: Record<string, string> = {
  "@workspace/db": "export const pool = { query() { throw new Error('no database in this test'); } };\nexport const db = {};\n",
};

const stubPlugin = {
  name: "promotion-stubs",
  setup(pluginBuild: any) {
    pluginBuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({
      path: "@workspace/db",
      namespace: "promotion-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "promotion-stub" }, (args: any) => ({
      contents: STUBS[args.path],
      loader: "js",
    }));
  },
};

const loaded = (async () => {
  const result = await build({
    entryPoints: ["artifacts/api-server/src/services/model-promotion.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [stubPlugin],
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
})();

/** A version that satisfies every promotion condition. */
function promotable(overrides: Record<string, unknown> = {}) {
  return {
    version_id: "tb-ready",
    market: "TOTAL_BASES_2_PLUS",
    status: "CANDIDATE",
    walk_forward_acceptance_id: "11111111-1111-1111-1111-111111111111",
    calibration_slope: "1.104",
    calibration_intercept: "-0.213",
    run_status: "PASS",
    run_fold_count: MIN_FOLD_COUNT,
    run_benchmark_beat: true,
    run_calibration_passed: true,
    run_expected_calibration_error: String(CALIBRATION_ECE_THRESHOLD - 0.01),
    run_prediction_std_dev: String(SHARPNESS_MIN_STD_DEV + 0.05),
    run_brier_skill_score: "0.043",
    ...overrides,
  };
}

describe("Task 1.5 the promotion gate", () => {
  test("a version meeting every condition is promotable", async () => {
    const { promotionRefusalFor } = await loaded;
    assert.equal(promotionRefusalFor(promotable()), null);
  });

  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ["a version that is not a CANDIDATE", { status: "DRAFT" }, "VERSION_NOT_CANDIDATE"],
    ["a version with no acceptance record", { walk_forward_acceptance_id: null }, "NO_WALK_FORWARD_ACCEPTANCE"],
    ["an acceptance pointing at no run", { run_status: null }, "WALK_FORWARD_RUN_MISSING"],
    ["a run that did not pass", { run_status: "FAIL" }, "WALK_FORWARD_RUN_NOT_PASS"],
    ["a run with too few folds", { run_fold_count: MIN_FOLD_COUNT - 1 }, "FOLD_COUNT_BELOW_MINIMUM"],
    [
      "a run above the calibration error threshold",
      { run_expected_calibration_error: String(CALIBRATION_ECE_THRESHOLD + 0.001) },
      "EXPECTED_CALIBRATION_ERROR_ABOVE_THRESHOLD",
    ],
    [
      "a run with an unrecorded calibration error",
      { run_expected_calibration_error: null },
      "EXPECTED_CALIBRATION_ERROR_ABOVE_THRESHOLD",
    ],
    [
      "a run that failed the sharpness guard",
      { run_prediction_std_dev: String(SHARPNESS_MIN_STD_DEV) },
      "SHARPNESS_GUARD_NOT_MET",
    ],
    ["a run that did not beat its benchmark", { run_benchmark_beat: false }, "BENCHMARK_MARGIN_NOT_MET"],
    ["a version with no calibration slope", { calibration_slope: null }, "CALIBRATION_PARAMETERS_MISSING"],
    ["a version with no calibration intercept", { calibration_intercept: null }, "CALIBRATION_PARAMETERS_MISSING"],
    ["a version for an unmodelled market", { market: "HITS_RUNS_RBI_2_PLUS" }, "UNKNOWN_MARKET"],
  ];

  for (const [label, overrides, reason] of refusals) {
    test(`${label} is refused with ${reason}`, async () => {
      const { promotionRefusalFor } = await loaded;
      const refusal = promotionRefusalFor(promotable(overrides));
      assert.notEqual(refusal, null, `${label} should have been refused`);
      assert.equal(refusal.reason, reason);
      assert.ok(refusal.message.length > 0, "a refusal must state why");
    });
  }
});

describe("Task 1.5 promotion is not reachable from the pipeline", () => {
  test("orchestration trains and validates but never promotes", () => {
    const source = readFileSync("artifacts/api-server/src/services/orchestration.ts", "utf8");
    assert.ok(source.includes("model_training"), "the pipeline must train and validate");
    assert.ok(!source.includes("promoteModelVersion"), "the pipeline must never promote");
  });

  test("ACTIVE is written in exactly one production code path", () => {
    const files = [
      "artifacts/api-server/src/services/model-promotion.ts",
      "artifacts/api-server/src/services/model-training.ts",
      "artifacts/api-server/src/services/walk-forward-validation.ts",
      "artifacts/api-server/src/services/daily-market-board.ts",
      "artifacts/api-server/src/services/orchestration.ts",
    ];
    const writers = files.filter((file) => /SET status = 'ACTIVE'/.test(readFileSync(file, "utf8")));
    assert.deepEqual(writers, ["artifacts/api-server/src/services/model-promotion.ts"]);
  });

  test("exactly one ACTIVE model per market is enforced by the database", () => {
    const source = readFileSync("lib/db/scripts/apply-immutability.mjs", "utf8");
    assert.ok(
      /CREATE UNIQUE INDEX IF NOT EXISTS model_versions_one_active_per_market_idx[\s\S]*?ON model_versions \(market\)[\s\S]*?WHERE status = 'ACTIVE'/.test(source),
      "the partial unique index must exist",
    );
  });
});
