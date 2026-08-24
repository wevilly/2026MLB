/**
 * Task 1.1 and Task 1.2 fixtures.
 *
 * These are the synthetic fixtures the remediation plan requires:
 *   - a constant-at-base-rate model calibrates perfectly and must still FAIL
 *     on the sharpness guard
 *   - a saturated 0.99 / 0.01 model that is right 85 percent of the time must
 *     FAIL on expected calibration error
 *   - an honestly calibrated, well spread model must PASS
 *   - a two-perfectly-correlated-feature fixture must recover the true total
 *     effect rather than double it, which the previous fitter did not
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  CALIBRATION_ECE_THRESHOLD,
  MIN_FOLD_COUNT,
  MODEL_ALGORITHM,
  MODEL_ARTIFACT_SCHEMA_VERSION,
  ModelArtifactError,
  applyCalibration,
  evaluateCalibrationGate,
  expectedCalibrationError,
  fitLogisticModel,
  fitPlatt,
  fitRidgeModel,
  flattenNumbers,
  makeReliabilityCurve,
  parseModelArtifact,
  prepareDesignMatrix,
  scoreArtifact,
  selectTrainableFeatures,
  trainableVector,
  type ModelArtifact,
  type NumericVector,
} from "../artifacts/api-server/src/services/model-math.ts";

/** Deterministic generator. Fixtures must not depend on Math.random. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeNormal(seed: number) {
  const random = makeRandom(seed);
  return () => {
    const u1 = Math.max(1e-9, random());
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * The previous fitter: for each feature independently take the univariate
 * ordinary least squares slope and sum them all with an intercept.
 */
function legacySumOfMarginalSlopes(rows: Array<{ vector: NumericVector; target: number }>, names: string[]) {
  const means = new Map(names.map((name) => [
    name,
    rows.reduce((sum, row) => sum + (row.vector[name] ?? 0), 0) / rows.length,
  ]));
  const targetMean = rows.reduce((sum, row) => sum + row.target, 0) / rows.length;
  const coefficients: NumericVector = {};
  for (const name of names) {
    let numerator = 0;
    let denominator = 0;
    for (const row of rows) {
      const centered = (row.vector[name] ?? 0) - (means.get(name) ?? 0);
      numerator += centered * (row.target - targetMean);
      denominator += centered * centered;
    }
    coefficients[name] = denominator ? numerator / denominator : 0;
  }
  const intercept = targetMean - names.reduce((sum, name) => sum + coefficients[name] * (means.get(name) ?? 0), 0);
  return (vector: NumericVector) =>
    intercept + names.reduce((sum, name) => sum + coefficients[name] * (vector[name] ?? 0), 0);
}

function predictRidge(model: ReturnType<typeof fitRidgeModel>, vector: NumericVector) {
  return model.featureNames.reduce((sum, name) => {
    const sd = model.featureStdDevs[name];
    return sum + model.coefficients[name] * ((vector[name] - model.featureMeans[name]) / sd);
  }, model.intercept);
}

describe("Task 1.2 the fitter is a genuine multivariate fit", () => {
  const TRUE_EFFECT = 3;
  const normal = makeNormal(20260824);
  const rows = Array.from({ length: 400 }, () => {
    const x = normal();
    // Two perfectly correlated features carrying one underlying quantity.
    const vector: NumericVector = { "hitterFeatures.quality.a.all": x, "hitterFeatures.quality.b.all": x };
    return { vector, target: TRUE_EFFECT * x + 0.25 * normal() };
  });
  const names = ["hitterFeatures.quality.a.all", "hitterFeatures.quality.b.all"];

  test("the previous fitter doubles the true effect", () => {
    const legacy = legacySumOfMarginalSlopes(rows, names);
    const effect = legacy({ "hitterFeatures.quality.a.all": 1, "hitterFeatures.quality.b.all": 1 })
      - legacy({ "hitterFeatures.quality.a.all": 0, "hitterFeatures.quality.b.all": 0 });
    assert.ok(effect > 2 * TRUE_EFFECT - 0.5, `legacy effect ${effect} should be near ${2 * TRUE_EFFECT}`);
  });

  test("the replacement recovers the true total effect", () => {
    const model = fitRidgeModel(rows, names, { lambdaGrid: [0.01] });
    const effect = predictRidge(model, { "hitterFeatures.quality.a.all": 1, "hitterFeatures.quality.b.all": 1 })
      - predictRidge(model, { "hitterFeatures.quality.a.all": 0, "hitterFeatures.quality.b.all": 0 });
    assert.ok(Math.abs(effect - TRUE_EFFECT) < 0.25, `effect ${effect} should be near ${TRUE_EFFECT}`);
  });

  test("the redundant column is recorded as dropped, not emitted as a zero coefficient", () => {
    const model = fitRidgeModel(rows, names, { lambdaGrid: [0.01] });
    assert.equal(model.featureNames.length, 1);
    const dropped = model.droppedFeatures.map((entry) => entry.reason);
    assert.ok(dropped.includes("RANK_DEFICIENT"), `expected a rank deficiency, got ${JSON.stringify(dropped)}`);
    assert.ok(!("hitterFeatures.quality.b.all" in model.coefficients));
  });

  test("a zero variance feature is dropped with a stated reason", () => {
    const design = prepareDesignMatrix(
      [{ a: 1, b: 5 }, { a: 2, b: 5 }, { a: 3, b: 5 }],
      ["a", "b"],
    );
    assert.deepEqual(design.featureNames, ["a"]);
    assert.deepEqual(design.droppedFeatures, [{ name: "b", reason: "ZERO_VARIANCE" }]);
  });

  test("severely collinear but not identical columns are dropped by variance inflation factor", () => {
    const noise = makeNormal(7);
    const collinearRows = Array.from({ length: 300 }, () => {
      const x = noise();
      const vector: NumericVector = { a: x, b: x + 0.001 * noise(), c: noise() };
      return { vector, target: x + 0.1 * noise() };
    });
    const model = fitRidgeModel(collinearRows, ["a", "b", "c"], { lambdaGrid: [0.01] });
    assert.ok(model.droppedFeatures.some((entry) => entry.reason === "COLLINEAR"));
    assert.ok(model.featureNames.includes("c"));
  });

  test("predicted total bases stay inside a plausible range", () => {
    // A TB-shaped fixture: five collinear contact quality metrics and an
    // opportunity metric, against a total bases target that never exceeds 5.
    const value = makeNormal(1234);
    const trainRows = Array.from({ length: 600 }, () => {
      const quality = 0.35 + 0.06 * value();
      const vector: NumericVector = {
        "hitterFeatures.statcast.xslg.all": quality,
        "hitterFeatures.statcast.slg.all": quality * 1.02 + 0.004 * value(),
        "hitterFeatures.statcast.iso.all": quality * 0.55 + 0.004 * value(),
        "hitterFeatures.statcast.barrel_percent.all": quality * 25 + 0.3 * value(),
        "hitterFeatures.statcast.hard_hit_percent.all": quality * 110 + 1.2 * value(),
        "hitterFeatures.opportunity.plate_appearances.all": 4.1 + 0.4 * value(),
      };
      const expected = 12 * (quality - 0.35) + 1.1;
      const target = Math.max(0, Math.min(5, Math.round(expected + 0.9 * value())));
      return { vector, target };
    });
    const featureNames = Object.keys(trainRows[0].vector);
    const model = fitRidgeModel(trainRows, featureNames);
    const predictions = trainRows.map((row) => predictRidge(model, row.vector)).sort((a, b) => a - b);
    const p99 = predictions[Math.floor(predictions.length * 0.99)];
    assert.ok(p99 < 6, `99th percentile prediction ${p99} must be below 6 total bases`);

    const legacy = legacySumOfMarginalSlopes(trainRows, featureNames);
    const legacyPredictions = trainRows.map((row) => legacy(row.vector)).sort((a, b) => a - b);
    const legacyP99 = legacyPredictions[Math.floor(legacyPredictions.length * 0.99)];
    assert.ok(legacyP99 > 6, `the previous fitter should inflate past 6, got ${legacyP99}`);
  });

  test("the logistic fitter learns a binary outcome", () => {
    const noise = makeNormal(99);
    const rowsBinary = Array.from({ length: 800 }, () => {
      const x = noise();
      const vector: NumericVector = { "hitterFeatures.a.all": x, "hitterFeatures.b.all": noise() };
      return { vector, label: 1 / (1 + Math.exp(-(1.2 * x - 0.4))) > Math.abs(noise()) % 1 };
    });
    const model = fitLogisticModel(rowsBinary, ["hitterFeatures.a.all", "hitterFeatures.b.all"]);
    assert.ok(model.converged);
    assert.ok(Math.abs(model.coefficients["hitterFeatures.a.all"]) > Math.abs(model.coefficients["hitterFeatures.b.all"]));
  });
});

describe("Task 1.2 the training feature allowlist", () => {
  const frozenVector = {
    market: "TB",
    slateDate: "2026-08-24",
    playerId: 592450,
    gamePk: 776543,
    candidateId: "abc",
    researchRank: 3,
    opportunityEvidence: { battingOrder: 2, expectedPlateAppearances: 4.4 },
    bullpenPathEvidence: { rolePath: [{ slot: "8TH", playerId: 801 }] },
    counterEvidence: { flags: 2 },
    hitterFeatures: { "statcast.iso.all": 0.21, "statcast.iso.L": 0.19 },
    pitcherFeatures: { "pitcher.statcast.xslg_allowed.all": 0.38 },
    parkFeatures: { "park.hr_factor.all": 1.32 },
  };

  test("identifiers, ordinals and counts never reach the model", () => {
    const flat = flattenNumbers(frozenVector);
    assert.ok("playerId" in flat && "gamePk" in flat && "researchRank" in flat);
    assert.ok("bullpenPathEvidence.rolePath[0].playerId" in flat);

    const allowed = Object.keys(selectTrainableFeatures(flat)).sort();
    assert.deepEqual(allowed, [
      "hitterFeatures.statcast.iso.L",
      "hitterFeatures.statcast.iso.all",
      "parkFeatures.park.hr_factor.all",
      "pitcherFeatures.pitcher.statcast.xslg_allowed.all",
    ]);
    for (const key of allowed) {
      assert.ok(!/playerId|gamePk|researchRank|candidateId/.test(key));
    }
  });

  test("trainableVector composes the flatten and the allowlist", () => {
    assert.deepEqual(trainableVector(frozenVector), selectTrainableFeatures(flattenNumbers(frozenVector)));
  });
});

describe("Task 1.1 the calibration gate", () => {
  const BASE_RATE = 0.38;
  const foldCount = MIN_FOLD_COUNT;

  function benchmark(labels: boolean[], rate: number) {
    return labels.map(() => rate);
  }

  test("a constant at the true base rate calibrates perfectly and fails on sharpness", () => {
    const random = makeRandom(11);
    const labels = Array.from({ length: 2000 }, () => random() < BASE_RATE);
    const observed = labels.filter(Boolean).length / labels.length;
    const probabilities = labels.map(() => observed);
    const gate = evaluateCalibrationGate({
      probabilities,
      labels,
      benchmarkProbabilities: benchmark(labels, observed),
      foldCount,
      hasLearnedSignal: true,
    });
    assert.ok(gate.expectedCalibrationError < 0.01, `ECE ${gate.expectedCalibrationError} should be near zero`);
    assert.ok(gate.ecePassed);
    assert.equal(gate.sharpnessPassed, false);
    assert.equal(gate.passed, false);
    assert.ok(gate.failureReasons.includes("PREDICTIONS_NOT_SHARP_ENOUGH"));
  });

  test("a saturated model that is right 85 percent of the time fails on expected calibration error", () => {
    const random = makeRandom(12);
    const labels: boolean[] = [];
    const probabilities: number[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const label = random() < BASE_RATE;
      const correct = random() < 0.85;
      labels.push(label);
      probabilities.push(correct === label ? 0.99 : 0.01);
    }
    const gate = evaluateCalibrationGate({
      probabilities,
      labels,
      benchmarkProbabilities: benchmark(labels, BASE_RATE),
      foldCount,
      hasLearnedSignal: true,
    });
    assert.ok(
      gate.expectedCalibrationError > CALIBRATION_ECE_THRESHOLD,
      `ECE ${gate.expectedCalibrationError} should exceed ${CALIBRATION_ECE_THRESHOLD}`,
    );
    assert.equal(gate.ecePassed, false);
    assert.equal(gate.passed, false);

    // The metric the previous gate used passes this model, which is the defect.
    const legacyError = probabilities.reduce(
      (sum, probability, index) => sum + Math.abs(probability - (labels[index] ? 1 : 0)), 0,
    ) / probabilities.length;
    assert.ok(legacyError <= 0.2, `the old metric scores ${legacyError} and passes its 0.2 threshold`);
  });

  test("an honestly calibrated, well spread model passes", () => {
    const random = makeRandom(13);
    const probabilities: number[] = [];
    const labels: boolean[] = [];
    for (let index = 0; index < 4000; index += 1) {
      const probability = 0.1 + 0.7 * random();
      probabilities.push(probability);
      labels.push(random() < probability);
    }
    const observed = labels.filter(Boolean).length / labels.length;
    const gate = evaluateCalibrationGate({
      probabilities,
      labels,
      benchmarkProbabilities: benchmark(labels, observed),
      foldCount,
      hasLearnedSignal: true,
    });
    assert.ok(gate.ecePassed, `ECE ${gate.expectedCalibrationError}`);
    assert.ok(gate.sharpnessPassed, `sharpness ${gate.sharpness}`);
    assert.ok(gate.benchmarkBeat, `skill ${gate.brierSkillScore} margin ${gate.benchmarkMargin}`);
    assert.ok(gate.passed, gate.failureReasons.join(","));
  });

  test("the previous gate would have failed an honestly calibrated model", () => {
    const random = makeRandom(13);
    const probabilities: number[] = [];
    const labels: boolean[] = [];
    for (let index = 0; index < 4000; index += 1) {
      const probability = 0.1 + 0.7 * random();
      probabilities.push(probability);
      labels.push(random() < probability);
    }
    const legacyError = probabilities.reduce(
      (sum, probability, index) => sum + Math.abs(probability - (labels[index] ? 1 : 0)), 0,
    ) / probabilities.length;
    assert.ok(legacyError > 0.2, `the old metric scores ${legacyError} and fails a well calibrated model`);
  });

  test("fewer than the minimum fold count fails regardless of metrics", () => {
    const random = makeRandom(14);
    const probabilities: number[] = [];
    const labels: boolean[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const probability = 0.1 + 0.7 * random();
      probabilities.push(probability);
      labels.push(random() < probability);
    }
    const gate = evaluateCalibrationGate({
      probabilities,
      labels,
      benchmarkProbabilities: labels.map(() => 0.45),
      foldCount: MIN_FOLD_COUNT - 1,
      hasLearnedSignal: true,
    });
    assert.equal(gate.passed, false);
    assert.ok(gate.failureReasons.includes(`FOLD_COUNT_BELOW_${MIN_FOLD_COUNT}`));
  });

  test("the benchmark margin scales with the test set rather than sitting at 0.001", () => {
    const random = makeRandom(15);
    const labels = Array.from({ length: 400 }, () => random() < 0.4);
    const observed = labels.filter(Boolean).length / labels.length;
    // A forecast that is the base rate plus imperceptible noise beats the
    // benchmark by far less than the noise floor and must not pass.
    const probabilities = labels.map(() => observed + 0.0005 * (random() - 0.5));
    const gate = evaluateCalibrationGate({
      probabilities,
      labels,
      benchmarkProbabilities: labels.map(() => observed),
      foldCount,
      hasLearnedSignal: true,
    });
    assert.ok(gate.benchmarkMargin > 0.001, `margin ${gate.benchmarkMargin} must exceed the old 0.001`);
    assert.equal(gate.benchmarkBeat, false);
  });

  test("empty reliability bins are skipped rather than diluting the average", () => {
    const probabilities = [0.05, 0.05, 0.95, 0.95];
    const labels = [false, false, true, true];
    const curve = makeReliabilityCurve(probabilities, labels);
    assert.equal(curve.length, 10);
    assert.equal(curve.filter((bin) => bin.count > 0).length, 2);
    const ece = expectedCalibrationError(curve);
    assert.ok(Math.abs(ece - 0.05) < 1e-9, `ECE ${ece} must average only the two populated bins`);
  });
});

describe("Task 1.3 and Task 1.6 one scoring transformation", () => {
  const artifact: ModelArtifact = {
    schemaVersion: MODEL_ARTIFACT_SCHEMA_VERSION,
    market: "TB",
    algorithm: MODEL_ALGORITHM,
    featureSetHash: "hash",
    featureNames: ["hitterFeatures.statcast.xslg.all", "pitcherFeatures.pitcher.statcast.xslg_allowed.all"],
    coefficients: {
      "hitterFeatures.statcast.xslg.all": 0.8,
      "pitcherFeatures.pitcher.statcast.xslg_allowed.all": -0.5,
    },
    intercept: -0.3,
    featureMeans: {
      "hitterFeatures.statcast.xslg.all": 0.4,
      "pitcherFeatures.pitcher.statcast.xslg_allowed.all": 0.39,
    },
    featureStdDevs: {
      "hitterFeatures.statcast.xslg.all": 0.05,
      "pitcherFeatures.pitcher.statcast.xslg_allowed.all": 0.04,
    },
    droppedFeatures: [],
    lambda: 1,
    target: "outcome_hit",
    link: "logit",
  };

  test("a missing feature is imputed with its training mean, never with zero", () => {
    const complete = scoreArtifact(artifact, {
      "hitterFeatures.statcast.xslg.all": 0.4,
      "pitcherFeatures.pitcher.statcast.xslg_allowed.all": 0.39,
    });
    const partial = scoreArtifact(artifact, { "pitcherFeatures.pitcher.statcast.xslg_allowed.all": 0.39 });
    assert.equal(complete.imputedFeatures.length, 0);
    assert.deepEqual(partial.imputedFeatures, ["hitterFeatures.statcast.xslg.all"]);
    // Imputing the mean leaves the score unchanged at the mean point. Imputing
    // zero would move the score by 0.8 * (0 - 0.4) / 0.05 = -6.4 logits.
    assert.ok(Math.abs(complete.rawScore - partial.rawScore) < 1e-12);
    const zeroImputed = artifact.intercept
      + 0.8 * ((0 - 0.4) / 0.05)
      + -0.5 * ((0.39 - 0.39) / 0.04);
    assert.ok(Math.abs(zeroImputed - partial.rawScore) > 6);
  });

  test("coverage and schema drift are reported", () => {
    const result = scoreArtifact(artifact, {
      "hitterFeatures.statcast.xslg.all": 0.45,
      "hitterFeatures.statcast.brand_new_metric.all": 1.1,
    });
    assert.equal(result.coverage, 0.5);
    assert.deepEqual(result.unknownFeatures, ["hitterFeatures.statcast.brand_new_metric.all"]);
  });

  test("the calibration transformation is a pure function of the raw score", () => {
    const { rawScore } = scoreArtifact(artifact, {
      "hitterFeatures.statcast.xslg.all": 0.5,
      "pitcherFeatures.pitcher.statcast.xslg_allowed.all": 0.42,
    });
    const probability = applyCalibration(rawScore, 1.2, -0.1);
    assert.ok(probability > 0 && probability < 1);
    assert.equal(probability, applyCalibration(rawScore, 1.2, -0.1));
  });

  test("an artifact using the previous algorithm is rejected, not reinterpreted", () => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      market: "TB",
      algorithm: "deterministic-centered-linear-v1",
      featureSetHash: "hash",
      featureNames: ["a"],
      coefficients: { a: 1 },
      intercept: 0,
    });
    assert.throws(
      () => parseModelArtifact(legacy, {
        market: "TB",
        algorithm: "deterministic-centered-linear-v1",
        featureSetHash: "hash",
      }),
      ModelArtifactError,
    );
  });

  test("an artifact without standardisation parameters is rejected", () => {
    const incomplete = JSON.stringify({ ...artifact, featureMeans: undefined, featureStdDevs: undefined });
    assert.throws(
      () => parseModelArtifact(incomplete, { market: "TB", algorithm: MODEL_ALGORITHM, featureSetHash: "hash" }),
      ModelArtifactError,
    );
  });

  test("a well formed artifact round trips", () => {
    const parsed = parseModelArtifact(JSON.stringify(artifact), {
      market: "TB",
      algorithm: MODEL_ALGORITHM,
      featureSetHash: "hash",
    });
    assert.deepEqual(parsed.featureNames, artifact.featureNames);
  });
});

describe("Task 1.3 Platt fitting", () => {
  test("Newton fitting resolves finer than the previous quarter unit grid", () => {
    const normal = makeNormal(2222);
    const scores: number[] = [];
    const labels: boolean[] = [];
    const random = makeRandom(3333);
    for (let index = 0; index < 4000; index += 1) {
      const score = normal();
      scores.push(score);
      labels.push(random() < 1 / (1 + Math.exp(-(1.37 * score - 0.62))));
    }
    const platt = fitPlatt(scores, labels);
    assert.ok(platt.converged);
    assert.ok(Math.abs(platt.slope - 1.37) < 0.15, `slope ${platt.slope}`);
    assert.ok(Math.abs(platt.intercept + 0.62) < 0.15, `intercept ${platt.intercept}`);
    // The old grid could only ever return a multiple of 0.25.
    assert.notEqual(Number((platt.slope * 4).toFixed(6)) % 1, 0);
  });

  test("scores on a scale the old grid could not represent are still calibrated", () => {
    const normal = makeNormal(4444);
    const random = makeRandom(5555);
    const scores: number[] = [];
    const labels: boolean[] = [];
    for (let index = 0; index < 4000; index += 1) {
      // A score scaled by 100, far outside the old 0.25 to 4 slope range.
      const score = 100 * normal();
      scores.push(score);
      labels.push(random() < 1 / (1 + Math.exp(-(0.012 * score + 0.2))));
    }
    const platt = fitPlatt(scores, labels);
    const probabilities = scores.map((score) => applyCalibration(score, platt.slope, platt.intercept));
    const gate = evaluateCalibrationGate({
      probabilities,
      labels,
      benchmarkProbabilities: labels.map(() => labels.filter(Boolean).length / labels.length),
      foldCount: MIN_FOLD_COUNT,
      hasLearnedSignal: true,
    });
    assert.ok(gate.ecePassed, `ECE ${gate.expectedCalibrationError}`);
  });
});
