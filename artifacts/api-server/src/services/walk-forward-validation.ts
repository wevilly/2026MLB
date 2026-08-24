/**
 * Walk-forward validation and deployment calibration.
 *
 * WHAT IS BEING VALIDATED, stated once because the previous implementation did
 * not say and did two different things:
 *
 *   The artifact under validation IS the artifact that will be deployed. Folds
 *   exist only to guarantee that the scores used for calibration and for the
 *   acceptance metrics are out-of-sample with respect to the slate being
 *   scored. No fold refits the model.
 *
 * The previous implementation refitted the model inside every fold, fitted
 * Platt parameters to each fold's own score distribution, row-count-weighted
 * averaged those parameters, and wrote the average onto the frozen artifact.
 * Averaging Platt parameters across differently scaled score distributions is
 * not a defined operation, and the calibrated probability the board served was
 * therefore not the probability the validator measured.
 *
 * Scoring and calibration arithmetic lives in model-math.ts and exists in
 * exactly one place. daily-market-board.ts calls the same two functions.
 */
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { verifyModelArtifact } from "../lib/model-artifact-storage";
import { toDbMarket, toShortMarketOrNull, type ModelMarket } from "./market-codes";
import {
  CALIBRATION_BIN_COUNT,
  CALIBRATION_ECE_THRESHOLD,
  MIN_FOLD_COUNT,
  SHARPNESS_MIN_STD_DEV,
  applyCalibration,
  evaluateCalibrationGate,
  fitPlatt,
  parseModelArtifact,
  scoreArtifact,
  trainableVector,
  type ModelArtifact,
  type NumericVector,
} from "./model-math";

export const CALIBRATION_METHOD = "platt-pooled-out-of-fold-v2";

/**
 * Slates of history required before the first fold may be scored. This is
 * separate from MIN_FOLD_COUNT: one controls how much training history the
 * benchmark base rate is drawn from, the other controls how many held-out
 * slates the acceptance decision rests on.
 */
export const MIN_TRAINING_SLATES_BEFORE_FIRST_FOLD = 5;

type JsonObject = Record<string, unknown>;
type FoldRow = {
  vector: NumericVector;
  outcomeHit: boolean;
  slateDate: string;
  playerId: number;
  gamePk: number;
  frozenAt: string;
  firstPitchUtc: string | null;
};

export class WalkForwardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalkForwardValidationError";
  }
}

/** Raised when a TEST fold contains a snapshot that did not exist before first pitch. */
export class WalkForwardLeakageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalkForwardLeakageError";
  }
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

/**
 * The first-pitch bound.
 *
 * A snapshot is usable for a slate only if it was frozen strictly before the
 * game started. The previous TEST window admitted anything frozen before
 * testDate + 1 day, so a snapshot frozen at 23:00 on the slate date was
 * accepted for a game that started at 19:05.
 *
 * Where a game carries no start_time_utc the slate's earliest first pitch is
 * used instead. That is conservative and defensible; a calendar day boundary
 * is neither.
 */
const FIRST_PITCH_BOUND = `COALESCE(
  g.start_time_utc,
  (SELECT min(sg.start_time_utc) FROM games sg WHERE sg.game_date = $2::date)
)`;

async function queryFoldRowsAsOf(
  market: string,
  testDate: string,
  mode: "TRAIN" | "TEST",
): Promise<FoldRow[]> {
  const isTraining = mode === "TRAIN";
  const rows = await pool.query<{
    features: JsonObject;
    outcome_hit: boolean;
    slate_date: string;
    player_id: number;
    game_pk: string;
    frozen_at: string;
    first_pitch_utc: string | null;
  }>(
    `WITH snapshots_as_of AS (
       SELECT DISTINCT ON (pfs.player_id, pfs.game_pk, pfs.market)
              pfs.player_id, pfs.game_pk, pfs.market, pfs.slate_date, pfs.features,
              pfs.frozen_at, ${FIRST_PITCH_BOUND} AS first_pitch_utc
         FROM pregame_feature_snapshots pfs
         JOIN games g ON g.game_pk = pfs.game_pk
        WHERE pfs.market = $1
          AND pfs.slate_date ${isTraining ? "<" : "="} $2::date
          AND pfs.frozen_at < ${FIRST_PITCH_BOUND}
          AND (
            ${isTraining
              ? "pfs.frozen_at < $2::date AND pfs.created_at < $2::date"
              : `pfs.created_at < ${FIRST_PITCH_BOUND}`}
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
          AND NOT ho.settled_without_snapshot
           ${isTraining
             ? "AND ho.settled_at < $2::date AND ho.created_at < $2::date"
             : "AND ho.settled_at < ($2::date + interval '2 days') AND ho.created_at < ($2::date + interval '2 days')"}
        ORDER BY ho.player_id, ho.game_pk, ho.market, ho.settled_at DESC, ho.created_at DESC
     )
     SELECT s.features, o.outcome_hit, s.slate_date::text AS slate_date,
            s.player_id, s.game_pk::text AS game_pk,
            s.frozen_at::text AS frozen_at, s.first_pitch_utc::text AS first_pitch_utc
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
    vector: trainableVector(row.features ?? {}),
    outcomeHit: row.outcome_hit,
    slateDate: row.slate_date,
    playerId: row.player_id,
    gamePk: Number(row.game_pk),
    frozenAt: row.frozen_at,
    firstPitchUtc: row.first_pitch_utc,
  }));
}

export type LateFreeze = {
  playerId: number;
  gamePk: number;
  frozenAt: string;
  firstPitchUtc: string | null;
};

/**
 * Finds snapshots on a test slate that were frozen at or after first pitch, or
 * whose first pitch is unknown and therefore cannot be bounded at all. The
 * query above excludes them from scoring; this reports them so the run fails
 * loudly rather than silently dropping rows.
 */
async function findLateFrozenTestSnapshots(market: string, testDate: string): Promise<LateFreeze[]> {
  const result = await pool.query<{
    player_id: number;
    game_pk: string;
    frozen_at: string;
    first_pitch_utc: string | null;
  }>(
    `SELECT pfs.player_id, pfs.game_pk::text AS game_pk, pfs.frozen_at::text AS frozen_at,
            ${FIRST_PITCH_BOUND}::text AS first_pitch_utc
       FROM pregame_feature_snapshots pfs
       JOIN games g ON g.game_pk = pfs.game_pk
      WHERE pfs.market = $1
        AND pfs.slate_date = $2::date
        AND (
          ${FIRST_PITCH_BOUND} IS NULL
          OR pfs.frozen_at >= ${FIRST_PITCH_BOUND}
        )
      ORDER BY pfs.player_id, pfs.game_pk
      LIMIT 25`,
    [market, testDate],
  );
  return result.rows.map((row) => ({
    playerId: row.player_id,
    gamePk: Number(row.game_pk),
    frozenAt: row.frozen_at,
    firstPitchUtc: row.first_pitch_utc,
  }));
}

function assertNoLeakage(testDate: string, rows: FoldRow[], lateFreezes: LateFreeze[]) {
  if (lateFreezes.length) {
    const example = lateFreezes[0];
    throw new WalkForwardLeakageError(
      `TEST fold ${testDate} contains ${lateFreezes.length} snapshot(s) frozen at or after first pitch `
      + `(player ${example.playerId}, game ${example.gamePk}, frozen ${example.frozenAt}, `
      + `first pitch ${example.firstPitchUtc ?? "unknown"}). Validation cannot proceed on leaked features.`,
    );
  }
  // Defence in depth against a future regression in the query above.
  for (const row of rows) {
    if (!row.firstPitchUtc || Date.parse(row.frozenAt) >= Date.parse(row.firstPitchUtc)) {
      throw new WalkForwardLeakageError(
        `TEST fold ${testDate} scored a snapshot frozen at ${row.frozenAt} for a game starting `
        + `${row.firstPitchUtc ?? "unknown"} (player ${row.playerId}, game ${row.gamePk}).`,
      );
    }
  }
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
  const market = toShortMarketOrNull(version.market);
  if (!market) throw new WalkForwardValidationError("Model version has an unknown market.");

  const walkForwardRunId = randomUUID();
  const startedAt = new Date().toISOString();
  const benchmarkMethod = `${market.toLowerCase()}-historical-base-rate-v1`;
  await pool.query(
    `INSERT INTO walk_forward_runs
       (walk_forward_run_id, model_version_id, market, status, benchmark_method, calibration_method, started_at)
     VALUES ($1, $2, $3, 'INCOMPLETE', $4, $5, $6)`,
    [walkForwardRunId, modelVersionId, version.market, benchmarkMethod, CALIBRATION_METHOD, startedAt],
  );

  const incomplete = async (errorMessage: string | null = null) => {
    await completeWalkForwardRun(
      `UPDATE walk_forward_runs
          SET finished_at = now(), status = 'INCOMPLETE', fold_count = 0,
              fold_results = '[]', benchmark_beat = false, calibration_passed = false,
              calibration_slope = NULL, calibration_intercept = NULL,
              expected_calibration_error = NULL, mean_absolute_prediction_error = NULL,
              brier_skill_score = NULL, prediction_std_dev = NULL, benchmark_margin = NULL,
              failure_reasons = $3,
              error_message = $1
        WHERE walk_forward_run_id = $2`,
      [errorMessage, walkForwardRunId, JSON.stringify(errorMessage ? ["INCOMPLETE"] : [])],
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
      benchmarkMethod,
      benchmarkMargin: null,
      calibrationMethod: CALIBRATION_METHOD,
      calibrationCurve: [],
      expectedCalibrationError: null,
      expectedCalibrationErrorThreshold: CALIBRATION_ECE_THRESHOLD,
      meanAbsolutePredictionError: null,
      brierSkillScore: null,
      predictionStdDev: null,
      predictionStdDevThreshold: SHARPNESS_MIN_STD_DEV,
      calibrationPassed: false,
      calibrationSlope: null,
      calibrationIntercept: null,
      failureReasons: errorMessage ? ["INCOMPLETE"] : [],
      status: "INCOMPLETE" as const,
    };
  };

  try {
    const artifact: ModelArtifact = parseModelArtifact(
      await verifyModelArtifact(version.artifact_key, version.artifact_generation, version.artifact_content_hash),
      { market, algorithm: version.algorithm, featureSetHash: version.feature_set_hash },
    );
    const datesResult = await pool.query<{ slate_date: string }>(
      `SELECT DISTINCT slate_date::text AS slate_date
         FROM pregame_feature_snapshots
        WHERE market = $1
        ORDER BY slate_date`,
      [version.market],
    );
    const allDates = datesResult.rows.map((row) => row.slate_date);
    const requiredDates = MIN_TRAINING_SLATES_BEFORE_FIRST_FOLD + MIN_FOLD_COUNT;
    if (allDates.length < requiredDates) {
      return incomplete(
        `Walk-forward validation needs at least ${requiredDates} distinct slates `
        + `(${MIN_TRAINING_SLATES_BEFORE_FIRST_FOLD} of history before the first of ${MIN_FOLD_COUNT} folds); `
        + `${allDates.length} are available.`,
      );
    }

    const foldResults: Array<Record<string, unknown>> = [];
    const pooledScores: number[] = [];
    const pooledLabels: boolean[] = [];
    const pooledBenchmark: number[] = [];
    const pooledFoldIndex: number[] = [];
    let totalImputedFeatureReads = 0;
    let minCoverage = 1;

    for (let dateIndex = MIN_TRAINING_SLATES_BEFORE_FIRST_FOLD; dateIndex < allDates.length; dateIndex += 1) {
      const testDate = allDates[dateIndex];
      const lateFreezes = await findLateFrozenTestSnapshots(version.market, testDate);
      const testRows = await queryFoldRowsAsOf(version.market, testDate, "TEST");
      if (!testRows.length && !lateFreezes.length) continue;
      assertNoLeakage(testDate, testRows, lateFreezes);
      const trainRows = await queryFoldRowsAsOf(version.market, testDate, "TRAIN");
      if (trainRows.length < 2 || !testRows.length) continue;

      // The frozen artifact scores the fold. Nothing is refitted here.
      const scored = testRows.map((row) => scoreArtifact(artifact, row.vector));
      const labels = testRows.map((row) => row.outcomeHit);
      const benchmarkRate = trainRows.filter((row) => row.outcomeHit).length / trainRows.length;
      const foldIndex = foldResults.length;

      scored.forEach((score, index) => {
        pooledScores.push(score.rawScore);
        pooledLabels.push(labels[index]);
        pooledBenchmark.push(benchmarkRate);
        pooledFoldIndex.push(foldIndex);
        totalImputedFeatureReads += score.imputedFeatures.length;
        minCoverage = Math.min(minCoverage, score.coverage);
      });

      foldResults.push({
        foldNumber: foldIndex + 1,
        trainThrough: trainRows.at(-1)?.slateDate ?? null,
        testDate,
        testSnapshotWindowEnd: "game start_time_utc, per game",
        testOutcomeCutoff: `${testDate} + 2 calendar days`,
        trainRowCount: trainRows.length,
        testRowCount: testRows.length,
        benchmarkRate: Number(benchmarkRate.toFixed(6)),
        meanFeatureCoverage: Number(
          (scored.reduce((sum, score) => sum + score.coverage, 0) / scored.length).toFixed(6),
        ),
      });
    }

    if (foldResults.length < MIN_FOLD_COUNT || !pooledLabels.length) {
      return incomplete(
        `Only ${foldResults.length} chronological fold(s) had as-of training rows and held-out official `
        + `outcomes; ${MIN_FOLD_COUNT} are required.`,
      );
    }

    // One Platt fit, on the pooled out-of-fold scores of the frozen artifact.
    // The fold structure guaranteed those scores are out-of-sample; the two
    // calibration parameters are then fitted once on all of them, rather than
    // per fold and averaged across incomparable score distributions.
    const platt = fitPlatt(pooledScores, pooledLabels);
    const probabilities = pooledScores.map((score) => applyCalibration(score, platt.slope, platt.intercept));
    const hasLearnedSignal = artifact.featureNames.some(
      (name) => Math.abs(artifact.coefficients[name] ?? 0) > 1e-9,
    );

    const gate = evaluateCalibrationGate({
      probabilities,
      labels: pooledLabels,
      benchmarkProbabilities: pooledBenchmark,
      foldCount: foldResults.length,
      hasLearnedSignal,
    });

    // The quantity the previous code called calibrationError: the mean absolute
    // distance between each predicted probability and its binary label. It is
    // retained for continuity under a name that does not claim to be a
    // calibration measurement, because it is not one.
    const meanAbsolutePredictionError = probabilities.reduce(
      (sum, probability, index) => sum + Math.abs(probability - (pooledLabels[index] ? 1 : 0)), 0,
    ) / probabilities.length;

    foldResults.forEach((fold, index) => {
      const indexes = pooledFoldIndex
        .map((value, position) => (value === index ? position : -1))
        .filter((position) => position >= 0);
      const foldProbabilities = indexes.map((position) => probabilities[position]);
      const foldLabels = indexes.map((position) => pooledLabels[position]);
      const foldBrier = foldProbabilities.reduce(
        (sum, probability, position) => sum + (probability - (foldLabels[position] ? 1 : 0)) ** 2, 0,
      ) / (foldProbabilities.length || 1);
      const benchmarkRate = Number(fold.benchmarkRate);
      const foldBenchmarkBrier = foldLabels.reduce(
        (sum, label) => sum + (benchmarkRate - (label ? 1 : 0)) ** 2, 0,
      ) / (foldLabels.length || 1);
      fold.modelBrier = Number(foldBrier.toFixed(6));
      fold.benchmarkBrier = Number(foldBenchmarkBrier.toFixed(6));
      fold.modelMetric = Number((1 - foldBrier).toFixed(6));
      fold.benchmarkMetric = Number((1 - foldBenchmarkBrier).toFixed(6));
      fold.hasLearnedSignal = hasLearnedSignal;
    });

    const overallMetric = 1 - gate.modelBrier;
    const benchmarkMetric = 1 - gate.benchmarkBrier;
    const status = gate.passed ? "PASS" : "FAIL";

    await completeWalkForwardRun(
      `UPDATE walk_forward_runs
          SET finished_at = now(), status = $1, fold_count = $2, fold_results = $3,
              overall_metric = $4, benchmark_metric = $5, benchmark_beat = $6,
              calibration_curve = $7, calibration_passed = $8,
              calibration_slope = $9, calibration_intercept = $10,
              expected_calibration_error = $11, mean_absolute_prediction_error = $12,
              brier_skill_score = $13, prediction_std_dev = $14, benchmark_margin = $15,
              failure_reasons = $16
         WHERE walk_forward_run_id = $17`,
      [status, foldResults.length, JSON.stringify(foldResults),
        overallMetric, benchmarkMetric, gate.benchmarkBeat,
        JSON.stringify(gate.reliabilityCurve), gate.calibrationPassed,
        platt.slope, platt.intercept,
        gate.expectedCalibrationError, meanAbsolutePredictionError,
        gate.brierSkillScore, gate.sharpness,
        Number.isFinite(gate.benchmarkMargin) ? gate.benchmarkMargin : null,
        JSON.stringify(gate.failureReasons), walkForwardRunId],
    );

    if (status === "PASS") {
      await updateModelWithValidationWriter(
        `UPDATE model_versions SET status = 'CANDIDATE', walk_forward_acceptance_id = $1
             , calibration_method = $3, calibration_slope = $4, calibration_intercept = $5
           WHERE version_id = $2`,
        [walkForwardRunId, modelVersionId, CALIBRATION_METHOD, platt.slope, platt.intercept],
      );
    } else {
      await updateModelWithValidationWriter(
        `UPDATE model_versions SET status = $1, walk_forward_acceptance_id = NULL
             , calibration_method = NULL, calibration_slope = NULL, calibration_intercept = NULL
           WHERE version_id = $2`,
        [gate.benchmarkBeat ? "CANDIDATE" : "FAILED", modelVersionId],
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
      benchmarkBeat: gate.benchmarkBeat,
      benchmarkMethod,
      benchmarkMargin: Number.isFinite(gate.benchmarkMargin) ? Number(gate.benchmarkMargin.toFixed(6)) : null,
      calibrationMethod: CALIBRATION_METHOD,
      calibrationCurve: gate.reliabilityCurve,
      expectedCalibrationError: Number(gate.expectedCalibrationError.toFixed(6)),
      expectedCalibrationErrorThreshold: CALIBRATION_ECE_THRESHOLD,
      meanAbsolutePredictionError: Number(meanAbsolutePredictionError.toFixed(6)),
      brierSkillScore: Number(gate.brierSkillScore.toFixed(6)),
      predictionStdDev: Number(gate.sharpness.toFixed(6)),
      predictionStdDevThreshold: SHARPNESS_MIN_STD_DEV,
      calibrationPassed: gate.calibrationPassed,
      calibrationSlope: Number(platt.slope.toFixed(6)),
      calibrationIntercept: Number(platt.intercept.toFixed(6)),
      failureReasons: gate.failureReasons,
      calibrationBinCount: CALIBRATION_BIN_COUNT,
      imputedFeatureReads: totalImputedFeatureReads,
      minimumFeatureCoverage: Number(minCoverage.toFixed(6)),
      status: status as "PASS" | "FAIL",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WalkForwardLeakageError) {
      await completeWalkForwardRun(
        `UPDATE walk_forward_runs
            SET finished_at = now(), status = 'FAIL', error_message = $1,
                failure_reasons = '["TEST_SNAPSHOT_FROZEN_AFTER_FIRST_PITCH"]'
          WHERE walk_forward_run_id = $2`,
        [message, walkForwardRunId],
      );
      throw error;
    }
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
    benchmark_margin: string | null;
    calibration_method: string;
    calibration_curve: unknown[];
    expected_calibration_error: string | null;
    mean_absolute_prediction_error: string | null;
    brier_skill_score: string | null;
    prediction_std_dev: string | null;
    calibration_passed: boolean;
    calibration_slope: string | null;
    calibration_intercept: string | null;
    failure_reasons: unknown;
    status: string;
    started_at: string;
    finished_at: string | null;
    error_message: string | null;
  }>(
    `SELECT walk_forward_run_id, model_version_id, market, fold_count, fold_results,
            overall_metric, benchmark_metric, benchmark_beat, benchmark_method, benchmark_margin,
            calibration_method, calibration_curve, expected_calibration_error,
            mean_absolute_prediction_error, brier_skill_score, prediction_std_dev,
            calibration_passed, calibration_slope, calibration_intercept, failure_reasons,
            status, started_at, finished_at, error_message
       FROM walk_forward_runs
      ${market ? "WHERE market = $1" : ""}
      ORDER BY started_at DESC`,
    market ? [toDbMarket(market)] : [],
  );
  return result.rows.map((row) => ({
    walkForwardRunId: row.walk_forward_run_id,
    versionId: row.model_version_id,
    market: toShortMarketOrNull(row.market),
    foldCount: row.fold_count,
    foldResults: row.fold_results,
    overallMetric: row.overall_metric == null ? null : Number(row.overall_metric),
    benchmarkMetric: row.benchmark_metric == null ? null : Number(row.benchmark_metric),
    benchmarkBeat: row.benchmark_beat,
    benchmarkMethod: row.benchmark_method,
    benchmarkMargin: row.benchmark_margin == null ? null : Number(row.benchmark_margin),
    calibrationMethod: row.calibration_method,
    calibrationCurve: row.calibration_curve,
    expectedCalibrationError: row.expected_calibration_error == null
      ? null
      : Number(row.expected_calibration_error),
    expectedCalibrationErrorThreshold: CALIBRATION_ECE_THRESHOLD,
    meanAbsolutePredictionError: row.mean_absolute_prediction_error == null
      ? null
      : Number(row.mean_absolute_prediction_error),
    brierSkillScore: row.brier_skill_score == null ? null : Number(row.brier_skill_score),
    predictionStdDev: row.prediction_std_dev == null ? null : Number(row.prediction_std_dev),
    predictionStdDevThreshold: SHARPNESS_MIN_STD_DEV,
    calibrationPassed: row.calibration_passed,
    calibrationSlope: row.calibration_slope == null ? null : Number(row.calibration_slope),
    calibrationIntercept: row.calibration_intercept == null ? null : Number(row.calibration_intercept),
    failureReasons: Array.isArray(row.failure_reasons) ? row.failure_reasons : [],
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
  }));
}
