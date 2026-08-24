/**
 * Task 1.3 acceptance.
 *
 * The probability the walk-forward validator measures and the probability the
 * daily market board serves must be the same number for the same feature
 * vector. Before this change the validator scored fold-local refits and the
 * board scored the frozen artifact, and the two arithmetic paths were written
 * out separately in two files.
 *
 * The board service is bundled rather than imported directly because the
 * api-server sources use extensionless relative imports, which the build
 * resolves and bare node does not. See tests/helpers/bundle.ts.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { bundleService } from "./helpers/bundle.ts";
import {
  MODEL_ALGORITHM,
  MODEL_ARTIFACT_SCHEMA_VERSION,
  applyCalibration,
  scoreArtifact,
  trainableVector,
  type ModelArtifact,
} from "../artifacts/api-server/src/services/model-math.ts";

const loadBundled = () => bundleService("artifacts/api-server/src/services/daily-market-board.ts");

const CALIBRATION_SLOPE = 1.184;
const CALIBRATION_INTERCEPT = -0.271;

const artifact: ModelArtifact = {
  schemaVersion: MODEL_ARTIFACT_SCHEMA_VERSION,
  market: "TB",
  algorithm: MODEL_ALGORITHM,
  featureSetHash: "parity-hash",
  featureNames: [
    "hitterFeatures.statcast.xslg.all",
    "hitterFeatures.statcast.iso.all",
    "pitcherFeatures.pitcher.statcast.xslg_allowed.all",
    "parkFeatures.park.hr_factor.all",
  ],
  coefficients: {
    "hitterFeatures.statcast.xslg.all": 0.71,
    "hitterFeatures.statcast.iso.all": 0.22,
    "pitcherFeatures.pitcher.statcast.xslg_allowed.all": -0.44,
    "parkFeatures.park.hr_factor.all": 0.13,
  },
  intercept: -0.35,
  featureMeans: {
    "hitterFeatures.statcast.xslg.all": 0.412,
    "hitterFeatures.statcast.iso.all": 0.171,
    "pitcherFeatures.pitcher.statcast.xslg_allowed.all": 0.395,
    "parkFeatures.park.hr_factor.all": 1.0,
  },
  featureStdDevs: {
    "hitterFeatures.statcast.xslg.all": 0.061,
    "hitterFeatures.statcast.iso.all": 0.045,
    "pitcherFeatures.pitcher.statcast.xslg_allowed.all": 0.052,
    "parkFeatures.park.hr_factor.all": 0.14,
  },
  droppedFeatures: [],
  lambda: 1,
  target: "outcome_hit",
  link: "logit",
};

function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Sixty frozen feature vectors in the shape feature-store.ts writes. */
function makeRows(count: number) {
  const random = makeRandom(424242);
  return Array.from({ length: count }, (_, index) => ({
    market: "TB",
    slateDate: "2026-08-24",
    playerId: 600000 + index,
    gamePk: 770000 + index,
    candidateId: `candidate-${index}`,
    researchRank: index + 1,
    researchState: "POSITIVE",
    primaryMechanism: null,
    secondaryMechanism: null,
    opportunityEvidence: { battingOrder: 1 + (index % 9) },
    starterMatchupEvidence: {},
    bullpenPathEvidence: { rolePath: [{ slot: "8TH", playerId: 800000 + index }] },
    parkEvidence: {},
    recentVsSeasonVsCareer: {},
    counterEvidence: {},
    hitterFeatures: {
      "statcast.xslg.all": 0.30 + 0.25 * random(),
      "statcast.iso.all": 0.10 + 0.18 * random(),
    },
    pitcherFeatures: {
      "pitcher.statcast.xslg_allowed.all": 0.30 + 0.20 * random(),
    },
    parkFeatures: {
      "park.hr_factor.all": 0.80 + 0.60 * random(),
    },
  }));
}

describe("Task 1.3 validator and board agree", () => {
  test("sixty rows produce identical probabilities to six decimal places", async () => {
    const board = await loadBundled();
    const rows = makeRows(60);
    assert.equal(rows.length, 60);

    const model = {
      model: {
        versionId: "tb-parity",
        market: "TOTAL_BASES_2_PLUS",
        featureSetHash: artifact.featureSetHash,
        algorithm: artifact.algorithm,
        artifactKey: "k",
        artifactGeneration: "g",
        artifactContentHash: "h",
        calibrationSlope: CALIBRATION_SLOPE,
        calibrationIntercept: CALIBRATION_INTERCEPT,
      },
      artifact,
    };

    let compared = 0;
    for (const features of rows) {
      // What the board serves.
      const served = board.confidenceFor("TB", "POSITIVE", model, undefined, features);
      // What the validator measures: the same two shared functions, in the
      // same order, on the same frozen artifact.
      const measured = applyCalibration(
        scoreArtifact(artifact, trainableVector(features)).rawScore,
        CALIBRATION_SLOPE,
        CALIBRATION_INTERCEPT,
      );
      assert.notEqual(served.calibratedProbability, null);
      assert.equal(
        served.calibratedProbability,
        Number(measured.toFixed(6)),
        `row ${features.candidateId}: board ${served.calibratedProbability} vs validator ${measured}`,
      );
      compared += 1;
    }
    assert.equal(compared, 60);
  });

  test("the board reports the model declining rather than rejecting it", async () => {
    const board = await loadBundled();
    // A hitter well below the training mean against a pitcher well above it.
    const features = {
      hitterFeatures: { "statcast.xslg.all": 0.28, "statcast.iso.all": 0.06 },
      pitcherFeatures: { "pitcher.statcast.xslg_allowed.all": 0.30 },
      parkFeatures: { "park.hr_factor.all": 0.85 },
    };
    const model = {
      model: {
        versionId: "tb-parity", market: "TOTAL_BASES_2_PLUS",
        featureSetHash: artifact.featureSetHash, algorithm: artifact.algorithm,
        artifactKey: "k", artifactGeneration: "g", artifactContentHash: "h",
        calibrationSlope: CALIBRATION_SLOPE, calibrationIntercept: CALIBRATION_INTERCEPT,
      },
      artifact,
    };
    const result = board.confidenceFor("TB", "POSITIVE", model, undefined, features);
    assert.equal(result.confidenceBasis, "MODEL_DECLINED");
    assert.ok(result.calibratedProbability !== null, "a declined row still carries its probability");
    assert.ok(result.calibratedProbability < 0.55);
  });

  test("a failed artifact is ARTIFACT_INVALID, not a model that declined", async () => {
    const board = await loadBundled();
    const result = board.confidenceFor("TB", "POSITIVE", undefined, {
      versionId: "tb-corrupt", market: "TOTAL_BASES_2_PLUS",
      featureSetHash: "x", algorithm: "y", artifactKey: "k",
      artifactGeneration: "g", artifactContentHash: "h",
      calibrationSlope: 1, calibrationIntercept: 0,
    }, null);
    assert.equal(result.confidenceBasis, "ARTIFACT_INVALID");
    assert.equal(result.calibratedProbability, null);
    assert.equal(result.modelVersionId, "tb-corrupt");
  });

  test("a partial feature vector is INSUFFICIENT_FEATURES, never a zero imputed probability", async () => {
    const board = await loadBundled();
    const model = {
      model: {
        versionId: "tb-parity", market: "TOTAL_BASES_2_PLUS",
        featureSetHash: artifact.featureSetHash, algorithm: artifact.algorithm,
        artifactKey: "k", artifactGeneration: "g", artifactContentHash: "h",
        calibrationSlope: CALIBRATION_SLOPE, calibrationIntercept: CALIBRATION_INTERCEPT,
      },
      artifact,
    };
    const complete = {
      hitterFeatures: { "statcast.xslg.all": 0.44, "statcast.iso.all": 0.20 },
      pitcherFeatures: { "pitcher.statcast.xslg_allowed.all": 0.41 },
      parkFeatures: { "park.hr_factor.all": 1.05 },
    };
    const missingOne = {
      ...complete,
      hitterFeatures: { "statcast.iso.all": 0.20 },
    };
    const full = board.confidenceFor("TB", "POSITIVE", model, undefined, complete);
    const partial = board.confidenceFor("TB", "POSITIVE", model, undefined, missingOne);

    assert.equal(full.confidenceBasis === "MODEL_CONFIRMED" || full.confidenceBasis === "MODEL_DECLINED", true);
    assert.equal(full.featureCoverage, 1);
    assert.deepEqual(full.imputedFeatures, []);

    assert.notEqual(partial.confidenceBasis, full.confidenceBasis);
    assert.equal(partial.confidenceBasis, "INSUFFICIENT_FEATURES");
    assert.equal(partial.calibratedProbability, null);
    assert.deepEqual(partial.imputedFeatures, ["hitterFeatures.statcast.xslg.all"]);
    assert.equal(partial.featureCoverage, 0.75);
  });

  test("a feature key the model has never seen is recorded, not failed on", async () => {
    const board = await loadBundled();
    const model = {
      model: {
        versionId: "tb-parity", market: "TOTAL_BASES_2_PLUS",
        featureSetHash: artifact.featureSetHash, algorithm: artifact.algorithm,
        artifactKey: "k", artifactGeneration: "g", artifactContentHash: "h",
        calibrationSlope: CALIBRATION_SLOPE, calibrationIntercept: CALIBRATION_INTERCEPT,
      },
      artifact,
    };
    const result = board.confidenceFor("TB", "POSITIVE", model, undefined, {
      hitterFeatures: { "statcast.xslg.all": 0.44, "statcast.iso.all": 0.20, "statcast.brand_new.all": 9 },
      pitcherFeatures: { "pitcher.statcast.xslg_allowed.all": 0.41 },
      parkFeatures: { "park.hr_factor.all": 1.05 },
    });
    assert.deepEqual(result.unknownFeatures, ["hitterFeatures.statcast.brand_new.all"]);
    assert.notEqual(result.calibratedProbability, null);
  });
});

describe("Task 1.3 the arithmetic exists in exactly one place", () => {
  const SERVICES = "artifacts/api-server/src/services";
  const files = [
    "daily-market-board.ts",
    "walk-forward-validation.ts",
    "model-training.ts",
  ];

  test("no service other than model-math defines or inlines the logistic transform", () => {
    for (const file of files) {
      const source = readFileSync(`${SERVICES}/${file}`, "utf8");
      assert.ok(!/function sigmoid\s*\(/.test(source), `${file} defines its own sigmoid`);
      assert.ok(!/Math\.exp\(/.test(source), `${file} inlines an exponential`);
    }
    const math = readFileSync(`${SERVICES}/model-math.ts`, "utf8");
    assert.equal((math.match(/export function sigmoid\(/g) ?? []).length, 1);
  });

  test("the market threshold subtraction is gone rather than left as a no-op", () => {
    for (const file of [...files, "model-math.ts"]) {
      const source = readFileSync(`${SERVICES}/${file}`, "utf8");
      assert.ok(!/MARKET_THRESHOLDS/.test(source), `${file} still references MARKET_THRESHOLDS`);
    }
  });

  test("the feature flattener is declared once", () => {
    let declarations = 0;
    for (const file of [...files, "model-math.ts"]) {
      const source = readFileSync(`${SERVICES}/${file}`, "utf8");
      declarations += (source.match(/export function flattenNumbers\(|^function flattenNumbers\(/gm) ?? []).length;
    }
    assert.equal(declarations, 1);
  });
});
