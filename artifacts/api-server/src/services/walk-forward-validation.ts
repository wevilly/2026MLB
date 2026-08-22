import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { verifyModelArtifact } from "../lib/model-artifact-storage";
import { type ModelMarket } from "./model-training";

const MARKET_TO_DB: Record<ModelMarket, string> = {
  TB: "TOTAL_BASES_2_PLUS",
  XBH: "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR: "HOME_RUN",
};

const DB_TO_MARKET: Record<string, ModelMarket> = {
  TOTAL_BASES_2_PLUS: "TB",
  EXTRA_BASE_HIT: "XBH",
  BATTER_WALK: "WALK",
  HOME_RUN: "HR",
};

const MARKET_THRESHOLDS: Record<ModelMarket, number> = { TB: 2, XBH: 1, WALK: 1, HR: 1 };
const CALIBRATION_ERROR_THRESHOLD = 0.2;
const MIN_FOLD_COUNT = 2;

type JsonObject = Record<string, unknown>;
type TrainingRow = {
  features: JsonObject;
  outcomeValue: number;
  outcomeHit: boolean;
  slateDate: string;
};

export class WalkForwardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalkForwardValidationError";
  }
}

function flattenNumbers(value: unknown, path = "", result: Record<string, number> = {}): Record<string, number> {
  if (typeof value === "number" && Number.isFinite(value)) {
    result[path || "value"] = value;
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenNumbers(entry, `${path}[${index}]`, result));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b))) {
      flattenNumbers(entry, path ? `${path}.${key}` : key, result);
    }
  }
  return result;
}

function fitValueModel(rows: TrainingRow[], featureNames: string[]) {
  const vectors = rows.map((row) => flattenNumbers(row.features));
  const means = new Map(featureNames.map((name) => [
    name,
    rows.reduce((sum, _, index) => sum + (vectors[index][name] ?? 0), 0) / rows.length,
  ]));
  const targetMean = rows.reduce((sum, row) => sum + row.outcomeValue, 0) / rows.length;
  const coefficients: Record<string, number> = {};

  for (const name of featureNames) {
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const centeredFeature = (vectors[index][name] ?? 0) - (means.get(name) ?? 0);
      numerator += centeredFeature * (rows[index].outcomeValue - targetMean);
      denominator += centeredFeature * centeredFeature;
    }
    coefficients[name] = denominator ? numerator / denominator : 0;
  }
  const intercept = targetMean - featureNames.reduce(
    (sum, name) => sum + coefficients[name] * (means.get(name) ?? 0),
    0,
  );
  return { coefficients, intercept };
}

function rawScore(model: { coefficients: Record<string, number>; intercept: number }, row: TrainingRow, featureNames: string[]) {
  const features = flattenNumbers(row.features);
  return model.intercept + featureNames.reduce((sum, name) => sum + model.coefficients[name] * (features[name] ?? 0), 0);
}

function sigmoid(value: number): number {
  const bounded = Math.max(-30, Math.min(30, value));
  return 1 / (1 + Math.exp(-bounded));
}

function logLoss(probability: number, label: boolean): number {
  const p = Math.max(1e-7, Math.min(1 - 1e-7, probability));
  return label ? -Math.log(p) : -Math.log(1 - p);
}

/**
 * Fits Platt parameters only on the training side of a fold. A small,
 * deterministic grid keeps calibration reproducible without a dependency.
 */
function fitPlatt(scores: number[], labels: boolean[]) {
  let best = { slope: 1, intercept: 0, loss: Number.POSITIVE_INFINITY };
  for (let slope = 0.25; slope <= 4; slope += 0.25) {
    for (let intercept = -3; intercept <= 3; intercept += 0.25) {
      const loss = scores.reduce((sum, score, index) => sum + logLoss(sigmoid(slope * score + intercept), labels[index]), 0);
      if (loss < best.loss) best = { slope, intercept, loss };
    }
  }
  return best;
}

function brier(probabilities: number[], labels: boolean[]) {
  return probabilities.reduce((sum, probability, index) => {
    const target = labels[index] ? 1 : 0;
    return sum + (probability - target) ** 2;
  }, 0) / probabilities.length;
}

function makeCalibrationCurve(probabilities: number[], labels: boolean[]) {
  return Array.from({ length: 5 }, (_, bucket) => {
    const indexes = probabilities
      .map((probability, index) => ({ probability, index }))
      .filter(({ probability }) => Math.min(4, Math.floor(probability * 5)) === bucket)
      .map(({ index }) => index);
    return {
      bucket,
      count: indexes.length,
      predictedProbability: indexes.length
        ? Number((indexes.reduce((sum, index) => sum + probabilities[index], 0) / indexes.length).toFixed(6))
        : null,
      observedRate: indexes.length
        ? Number((indexes.reduce((sum, index) => sum + (labels[index] ? 1 : 0), 0) / indexes.length).toFixed(6))
        : null,
    };
  });
}

function parsedArtifact(value: string, market: ModelMarket, algorithm: string, featureSetHash: string) {
  let artifact: unknown;
  try {
    artifact = JSON.parse(value);
  } catch {
    throw new WalkForwardValidationError("The model artifact is not valid JSON.");
  }
  if (!artifact || typeof artifact !== "object") {
    throw new WalkForwardValidationError("The model artifact has an invalid shape.");
  }
  const record = artifact as JsonObject;
  if (record.market !== market || record.algorithm !== algorithm || record.featureSetHash !== featureSetHash) {
    throw new WalkForwardValidationError("The model artifact identity does not match its database version.");
  }
  if (!Array.isArray(record.featureNames) || !record.featureNames.every((name) => typeof name === "string")) {
    throw new WalkForwardValidationError("The model artifact is missing its frozen feature schema.");
  }
  return { featureNames: record.featureNames as string[] };
}

async function queryFoldRowsAsOf(
  market: string,
  testDate: string,
  mode: "TRAIN" | "TEST",
): Promise<TrainingRow[]> {
  const isTraining = mode === "TRAIN";
  const rows = await pool.query<{
    features: JsonObject;
    outcome_value: string;
    outcome_hit: boolean;
    slate_date: string;
  }>(
    `WITH snapshots_as_of AS (
       SELECT DISTINCT ON (pfs.player_id, pfs.game_pk, pfs.market)
              pfs.player_id, pfs.game_pk, pfs.market, pfs.slate_date, pfs.features
         FROM pregame_feature_snapshots pfs
        WHERE pfs.market = $1
          AND pfs.slate_date ${isTraining ? "<" : "="} $2::date
          AND (
            ${isTraining
              ? "pfs.frozen_at < $2::date AND pfs.created_at < $2::date"
              : "pfs.frozen_at < ($2::date + interval '1 day') AND pfs.created_at < ($2::date + interval '1 day')"}
          )
        ORDER BY pfs.player_id, pfs.game_pk, pfs.market,
                 pfs.created_at ${isTraining ? "DESC" : "ASC"},
                 pfs.frozen_at ${isTraining ? "DESC" : "ASC"}
     ),
     outcomes AS (
       SELECT DISTINCT ON (ho.player_id, ho.game_pk, ho.market)
              ho.player_id, ho.game_pk, ho.market, ho.slate_date,
              ho.outcome_value, ho.outcome_hit
         FROM historical_outcomes ho
        WHERE ho.market = $1
          AND ho.slate_date ${isTraining ? "<" : "="} $2::date
          AND ho.settlement_state = 'SETTLED'
          AND ho.source_id = 'MLB_OFFICIAL'
           ${isTraining
             ? "AND ho.settled_at < $2::date AND ho.created_at < $2::date"
             : "AND ho.settled_at < ($2::date + interval '2 days') AND ho.created_at < ($2::date + interval '2 days')"}
        ORDER BY ho.player_id, ho.game_pk, ho.market, ho.settled_at DESC, ho.created_at DESC
     )
     SELECT s.features, o.outcome_value, o.outcome_hit, s.slate_date::text AS slate_date
       FROM snapshots_as_of s
       JOIN outcomes o
         ON o.player_id = s.player_id
        AND o.game_pk = s.game_pk
        AND o.market = s.market
        AND o.slate_date = s.slate_date
      ORDER BY s.slate_date, s.player_id, s.game_pk`,
    [market, testDate],
  );
  return rows.rows.map((row) => ({
    features: row.features ?? {},
    outcomeValue: Number(row.outcome_value),
    outcomeHit: row.outcome_hit,
    slateDate: row.slate_date,
  }));
}

async function completeWalkForwardRun(sql: string, values: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE mlb_walk_forward_validator");
    await client.query(sql, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateModelWithValidationWriter(sql: string, values: unknown[]) {
  await completeWalkForwardRun(sql, values);
}

export async function validateModelVersion(modelVersionId: string) {
  const versionResult = await pool.query<{
    version_id: string;
    market: string;
    algorithm: string;
    feature_set_hash: string;
    artifact_key: string;
    artifact_generation: string;
    artifact_content_hash: string;
    status: string;
  }>(
    `SELECT version_id, market, algorithm, feature_set_hash, artifact_key,
            artifact_generation, artifact_content_hash, status
       FROM model_versions
      WHERE version_id = $1`,
    [modelVersionId],
  );
  const version = versionResult.rows[0];
  if (!version) throw new WalkForwardValidationError("modelVersionId was not found.");
  if (!["DRAFT", "CANDIDATE"].includes(version.status)) {
    throw new WalkForwardValidationError("Only DRAFT or CANDIDATE model versions can be validated.");
  }
  const market = DB_TO_MARKET[version.market];
  if (!market) throw new WalkForwardValidationError("Model version has an unknown market.");

  const walkForwardRunId = randomUUID();
  const startedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO walk_forward_runs
       (walk_forward_run_id, model_version_id, market, status, benchmark_method, calibration_method, started_at)
     VALUES ($1, $2, $3, 'INCOMPLETE', $4, 'platt-grid-v1', $5)`,
    [walkForwardRunId, modelVersionId, version.market, `${market.toLowerCase()}-historical-base-rate-v1`, startedAt],
  );

  const incomplete = async (errorMessage: string | null = null) => {
    await completeWalkForwardRun(
      `UPDATE walk_forward_runs
          SET finished_at = now(), status = 'INCOMPLETE', fold_count = 0,
              fold_results = '[]', benchmark_beat = false, calibration_passed = false,
              calibration_slope = NULL, calibration_intercept = NULL,
              error_message = $1
        WHERE walk_forward_run_id = $2`,
      [errorMessage, walkForwardRunId],
    );
    await updateModelWithValidationWriter(
      `UPDATE model_versions SET walk_forward_acceptance_id = NULL
          , calibration_method = NULL, calibration_slope = NULL, calibration_intercept = NULL
        WHERE version_id = $1 AND status IN ('DRAFT', 'CANDIDATE')`,
      [modelVersionId],
    );
    return {
      walkForwardRunId,
      versionId: modelVersionId,
      market,
      foldCount: 0,
      foldResults: [],
      overallMetric: null,
      benchmarkMetric: null,
      benchmarkBeat: false,
      benchmarkMethod: `${market.toLowerCase()}-historical-base-rate-v1`,
      calibrationMethod: "platt-grid-v1",
      calibrationCurve: [],
      calibrationError: null,
      calibrationPassed: false,
      calibrationSlope: null,
      calibrationIntercept: null,
      status: "INCOMPLETE" as const,
    };
  };

  try {
    const artifact = parsedArtifact(
      await verifyModelArtifact(version.artifact_key, version.artifact_generation, version.artifact_content_hash),
      market,
      version.algorithm,
      version.feature_set_hash,
    );
    const datesResult = await pool.query<{ slate_date: string }>(
      `SELECT DISTINCT slate_date::text AS slate_date
         FROM pregame_feature_snapshots
        WHERE market = $1
        ORDER BY slate_date`,
      [version.market],
    );
    const testRowsByDate = new Map<string, TrainingRow[]>();
    for (const { slate_date: date } of datesResult.rows) {
      const testRows = await queryFoldRowsAsOf(version.market, date, "TEST");
      if (testRows.length) testRowsByDate.set(date, testRows);
    }
    const dates = [...testRowsByDate.keys()];
    if (dates.length < MIN_FOLD_COUNT + 1) {
      return incomplete("Fewer than three historical slates have an as-of frozen snapshot and official result.");
    }

    const foldResults: Array<Record<string, unknown>> = [];
    const allProbabilities: number[] = [];
    const allLabels: boolean[] = [];
    for (let dateIndex = MIN_FOLD_COUNT; dateIndex < dates.length; dateIndex += 1) {
      const testDate = dates[dateIndex];
      const trainRows = await queryFoldRowsAsOf(version.market, testDate, "TRAIN");
      const testRows = testRowsByDate.get(testDate) ?? [];
      if (trainRows.length < 2 || !testRows.length) continue;
      const model = fitValueModel(trainRows, artifact.featureNames);
      const threshold = MARKET_THRESHOLDS[market];
      const trainScores = trainRows.map((row) => rawScore(model, row, artifact.featureNames) - threshold);
      const testScores = testRows.map((row) => rawScore(model, row, artifact.featureNames) - threshold);
      const trainLabels = trainRows.map((row) => row.outcomeHit);
      const testLabels = testRows.map((row) => row.outcomeHit);
      const platt = fitPlatt(trainScores, trainLabels);
      const probabilities = testScores.map((score) => sigmoid(platt.slope * score + platt.intercept));
      const benchmarkRate = trainLabels.filter(Boolean).length / trainLabels.length;
      const benchmarkProbabilities = testRows.map(() => benchmarkRate);
      const modelBrier = brier(probabilities, testLabels);
      const benchmarkBrier = brier(benchmarkProbabilities, testLabels);
      const hasLearnedSignal = Object.values(model.coefficients).some((coefficient) => Math.abs(coefficient) > 1e-9);
      allProbabilities.push(...probabilities);
      allLabels.push(...testLabels);
      foldResults.push({
        foldNumber: foldResults.length + 1,
        trainThrough: trainRows.at(-1)?.slateDate ?? null,
        testDate,
        asOfCutoff: `${testDate}T00:00:00.000Z`,
        testSnapshotWindowEnd: `${testDate}T24:00:00.000Z`,
        testOutcomeCutoff: `${testDate} + 2 calendar days`,
        trainRowCount: trainRows.length,
        testRowCount: testRows.length,
        modelMetric: Number((1 - modelBrier).toFixed(6)),
        benchmarkMetric: Number((1 - benchmarkBrier).toFixed(6)),
        modelBrier: Number(modelBrier.toFixed(6)),
        benchmarkBrier: Number(benchmarkBrier.toFixed(6)),
        calibrationSlope: Number(platt.slope.toFixed(4)),
        calibrationIntercept: Number(platt.intercept.toFixed(4)),
        hasLearnedSignal,
      });
    }

    if (foldResults.length < MIN_FOLD_COUNT || !allLabels.length) {
      return incomplete("Fewer than two chronological folds had as-of training rows and held-out official outcomes.");
    }

    const overallBrier = brier(allProbabilities, allLabels);
    const benchmarkBrier = foldResults.reduce((sum, fold) => {
      return sum + Number(fold.benchmarkBrier) * Number(fold.testRowCount);
    }, 0) / allLabels.length;
    const overallMetric = 1 - overallBrier;
    const benchmarkMetric = 1 - benchmarkBrier;
    const modelHasSignal = foldResults.some((fold) => fold.hasLearnedSignal === true);
    const benchmarkBeat = modelHasSignal && overallMetric > benchmarkMetric + 0.001;
    const curve = makeCalibrationCurve(allProbabilities, allLabels);
    const error = allProbabilities.reduce((sum, probability, index) => {
      return sum + Math.abs(probability - (allLabels[index] ? 1 : 0));
    }, 0) / allProbabilities.length;
    const calibrationPassed = Number.isFinite(error) && error <= CALIBRATION_ERROR_THRESHOLD;
    const status = benchmarkBeat && calibrationPassed ? "PASS" : "FAIL";
    const totalTestRows = foldResults.reduce((sum, fold) => sum + Number(fold.testRowCount), 0);
    const calibrationSlope = foldResults.reduce(
      (sum, fold) => sum + Number(fold.calibrationSlope) * Number(fold.testRowCount), 0,
    ) / totalTestRows;
    const calibrationIntercept = foldResults.reduce(
      (sum, fold) => sum + Number(fold.calibrationIntercept) * Number(fold.testRowCount), 0,
    ) / totalTestRows;

    await completeWalkForwardRun(
      `UPDATE walk_forward_runs
          SET finished_at = now(), status = $1, fold_count = $2, fold_results = $3,
              overall_metric = $4, benchmark_metric = $5, benchmark_beat = $6,
               calibration_curve = $7, calibration_error = $8, calibration_passed = $9,
               calibration_slope = $10, calibration_intercept = $11
         WHERE walk_forward_run_id = $12`,
      [status, foldResults.length, JSON.stringify(foldResults), overallMetric, benchmarkMetric, benchmarkBeat,
        JSON.stringify(curve), error, calibrationPassed, calibrationSlope, calibrationIntercept, walkForwardRunId],
    );

    if (status === "PASS") {
      await updateModelWithValidationWriter(
        `UPDATE model_versions SET status = 'CANDIDATE', walk_forward_acceptance_id = $1
             , calibration_method = $3, calibration_slope = $4, calibration_intercept = $5
           WHERE version_id = $2`,
        [walkForwardRunId, modelVersionId, "platt-grid-fold-weighted-v1", calibrationSlope, calibrationIntercept],
      );
    } else {
      await updateModelWithValidationWriter(
        `UPDATE model_versions SET status = $1, walk_forward_acceptance_id = NULL
             , calibration_method = NULL, calibration_slope = NULL, calibration_intercept = NULL
           WHERE version_id = $2`,
        [benchmarkBeat ? "CANDIDATE" : "FAILED", modelVersionId],
      );
    }

    return {
      walkForwardRunId,
      versionId: modelVersionId,
      market,
      foldCount: foldResults.length,
      foldResults,
      overallMetric: Number(overallMetric.toFixed(6)),
      benchmarkMetric: Number(benchmarkMetric.toFixed(6)),
      benchmarkBeat,
      benchmarkMethod: `${market.toLowerCase()}-historical-base-rate-v1`,
      calibrationMethod: "platt-grid-v1",
      calibrationCurve: curve,
      calibrationError: Number(error.toFixed(6)),
      calibrationPassed,
      calibrationSlope: Number(calibrationSlope.toFixed(6)),
      calibrationIntercept: Number(calibrationIntercept.toFixed(6)),
      status: status as "PASS" | "FAIL",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return incomplete(message);
  }
}

export async function queryWalkForwardRuns(market: ModelMarket | null) {
  const result = await pool.query<{
    walk_forward_run_id: string;
    model_version_id: string;
    market: string;
    fold_count: number;
    fold_results: unknown[];
    overall_metric: string | null;
    benchmark_metric: string | null;
    benchmark_beat: boolean;
    benchmark_method: string;
    calibration_method: string;
    calibration_curve: unknown[];
    calibration_error: string | null;
    calibration_passed: boolean;
    calibration_slope: string | null;
    calibration_intercept: string | null;
    status: string;
    started_at: string;
    finished_at: string | null;
    error_message: string | null;
  }>(
    `SELECT walk_forward_run_id, model_version_id, market, fold_count, fold_results,
            overall_metric, benchmark_metric, benchmark_beat, benchmark_method,
            calibration_method, calibration_curve, calibration_error, calibration_passed,
            calibration_slope, calibration_intercept,
            status, started_at, finished_at, error_message
       FROM walk_forward_runs
      ${market ? "WHERE market = $1" : ""}
      ORDER BY started_at DESC`,
    market ? [MARKET_TO_DB[market]] : [],
  );
  return result.rows.map((row) => ({
    walkForwardRunId: row.walk_forward_run_id,
    versionId: row.model_version_id,
    market: DB_TO_MARKET[row.market],
    foldCount: row.fold_count,
    foldResults: row.fold_results,
    overallMetric: row.overall_metric == null ? null : Number(row.overall_metric),
    benchmarkMetric: row.benchmark_metric == null ? null : Number(row.benchmark_metric),
    benchmarkBeat: row.benchmark_beat,
    benchmarkMethod: row.benchmark_method,
    calibrationMethod: row.calibration_method,
    calibrationCurve: row.calibration_curve,
    calibrationError: row.calibration_error == null ? null : Number(row.calibration_error),
    calibrationPassed: row.calibration_passed,
    calibrationSlope: row.calibration_slope == null ? null : Number(row.calibration_slope),
    calibrationIntercept: row.calibration_intercept == null ? null : Number(row.calibration_intercept),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
  }));
}