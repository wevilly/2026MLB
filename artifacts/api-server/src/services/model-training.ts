import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { storeModelArtifact, verifyModelArtifact } from "../lib/model-artifact-storage";
import { MODEL_MARKETS, toDbMarket, toShortMarket, type ModelMarket } from "./market-codes";
import {
  MODEL_ALGORITHM,
  MODEL_ARTIFACT_SCHEMA_VERSION,
  TRAINABLE_FEATURE_PREFIXES,
  VIF_CAP,
  fitLogisticModel,
  trainableVector,
  type NumericVector,
} from "./model-math";

export { MODEL_MARKETS, type ModelMarket };
export type { NumericVector };
type JsonObject = Record<string, unknown>;

export class ModelTrainingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTrainingValidationError";
  }
}

export function featureSetHash(names: string[]): string {
  return createHash("sha256").update(names.slice().sort().join("\n")).digest("hex");
}

type TrainingRow = { vector: NumericVector; label: boolean };

/**
 * Fits the market model.
 *
 * Option B of remediation task 1.2: L2 penalised logistic regression fitted
 * directly on outcome_hit. The board's question is binary, so the model answers
 * the binary question and there is no threshold-subtraction step between the
 * model output and the calibrated probability. outcome_value is not needed
 * anywhere downstream; model_prediction on the board carries the model's raw
 * score, which under this algorithm is a logit.
 *
 * The previous implementation computed, for each feature independently, the
 * univariate slope cov(x, y) / var(x) and summed all of those slopes together.
 * That is a sum of marginal effects, not a multivariate fit: every collinear
 * feature contributed its full marginal effect again, and with xslg, slg, iso,
 * barrel_percent and hard_hit_percent all measuring the same quantity the
 * prediction inflated roughly in proportion to the redundancy of the feature
 * set. Its algorithm identifier is deliberately not reused.
 */
function trainMarketArtifact(market: ModelMarket, rows: TrainingRow[]) {
  const candidateNames = [...new Set(rows.flatMap((row) => Object.keys(row.vector)))].sort();
  if (!candidateNames.length) {
    throw new ModelTrainingValidationError(
      `No allowlisted training feature was present for ${market}. Expected keys under ${TRAINABLE_FEATURE_PREFIXES.join(", ")}.`,
    );
  }
  const fit = fitLogisticModel(rows, candidateNames);
  const hash = featureSetHash(fit.featureNames);
  const importance: NumericVector = {};
  for (const name of fit.featureNames) {
    // Coefficients are on the standardised scale, so their magnitudes are
    // directly comparable across features. Under the previous fitter they were
    // on each feature's own raw scale and were not.
    importance[name] = Number(Math.abs(fit.coefficients[name]).toFixed(10));
  }
  return {
    algorithm: MODEL_ALGORITHM,
    featureSetHash: hash,
    candidateNames,
    fit,
    importance,
    artifact: {
      schemaVersion: MODEL_ARTIFACT_SCHEMA_VERSION,
      market,
      algorithm: MODEL_ALGORITHM,
      featureSetHash: hash,
      featureNames: fit.featureNames,
      coefficients: fit.coefficients,
      intercept: fit.intercept,
      featureMeans: fit.featureMeans,
      featureStdDevs: fit.featureStdDevs,
      droppedFeatures: fit.droppedFeatures,
      lambda: fit.lambda,
      target: "outcome_hit",
      link: "logit",
    },
  };
}

export async function trainMarketModel(market: ModelMarket) {
  const trainingRunId = randomUUID();
  const dbMarket = toDbMarket(market);
  await pool.query(
    `INSERT INTO model_training_runs
       (training_run_id, market, status, algorithm, metadata)
     VALUES ($1, $2, 'RUNNING', $3, $4)`,
    [trainingRunId, dbMarket, MODEL_ALGORITHM,
      { source: "MLB_OFFICIAL settled outcomes + frozen feature snapshots" }],
  );

  try {
    // The snapshot must predate first pitch. A snapshot frozen at 23:00 on the
    // slate date is post-game for a 19:05 start, and training the deployed
    // artifact on it teaches the model information that did not exist when the
    // board was published. This is the same bound task 1.4 applies to the
    // walk-forward TEST folds, applied at the source of the deployed model.
    const rows = await pool.query<{
      features: JsonObject;
      outcome_hit: boolean;
      slate_date: string;
    }>(
      `SELECT pfs.features, ho.outcome_hit, pfs.slate_date::text AS slate_date
       FROM pregame_feature_snapshots pfs
       JOIN games g ON g.game_pk = pfs.game_pk
       JOIN historical_outcomes ho
         ON ho.player_id = pfs.player_id
        AND ho.game_pk = pfs.game_pk
        AND ho.slate_date = pfs.slate_date
        AND ho.market = pfs.market
        AND ho.settlement_state = 'SETTLED'
        AND ho.source_id = 'MLB_OFFICIAL'
        -- A row settled without a frozen snapshot is a complete operational
        -- settle record with no pregame feature vector. It must not train.
        AND NOT ho.settled_without_snapshot
       WHERE pfs.market = $1
         AND g.start_time_utc IS NOT NULL
         AND pfs.frozen_at < g.start_time_utc
         AND NOT EXISTS (
           SELECT 1 FROM pregame_feature_snapshots newer
            WHERE newer.correction_of = pfs.snapshot_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM historical_outcomes newer
            WHERE newer.correction_of = ho.outcome_id
         )
       ORDER BY pfs.slate_date, pfs.created_at`,
      [dbMarket],
    );
    if (!rows.rows.length) {
      throw new ModelTrainingValidationError(`No official settled training rows are available for ${market}.`);
    }

    const trainingRows: TrainingRow[] = rows.rows.map((row) => ({
      vector: trainableVector(row.features ?? {}),
      label: row.outcome_hit,
    }));
    const trained = trainMarketArtifact(market, trainingRows);
    const versionId = `${market.toLowerCase()}-${randomUUID()}`;
    const content = JSON.stringify(trained.artifact);
    const artifactContentHash = createHash("sha256").update(content).digest("hex");
    const { artifactKey, artifactGeneration } = await storeModelArtifact(versionId, content, artifactContentHash);
    await verifyModelArtifact(artifactKey, artifactGeneration, artifactContentHash);
    const trainingSeasons = [...new Set(rows.rows.map((row) => row.slate_date.slice(0, 4)))].sort();
    const hyperparameters = {
      market,
      target: "outcome_hit",
      link: "logit",
      penalty: "l2",
      lambda: trained.fit.lambda,
      lambdaSelection: "5-fold cross validation on the training rows only",
      standardisation: "zero mean unit variance, parameters stored in the artifact",
      vifCap: VIF_CAP,
      featureAllowlistPrefixes: [...TRAINABLE_FEATURE_PREFIXES],
      candidateFeatureCount: trained.candidateNames.length,
      featureCount: trained.fit.featureNames.length,
      converged: trained.fit.converged,
      iterations: trained.fit.iterations,
    };

    await pool.query(
      `INSERT INTO model_versions
         (version_id, market, training_seasons, feature_set_hash, algorithm,
          hyperparameters, training_sample_count, status, artifact_key, artifact_generation, artifact_content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CANDIDATE', $8, $9, $10)`,
      [versionId, dbMarket, JSON.stringify(trainingSeasons), trained.featureSetHash, trained.algorithm,
        hyperparameters, trainingRows.length, artifactKey, artifactGeneration, artifactContentHash],
    );
    await pool.query(
      `UPDATE model_training_runs
          SET model_version_id = $1, finished_at = now(), status = 'SUCCESS',
              training_seasons = $2, feature_set_hash = $3, algorithm = $4,
              hyperparameters = $5, training_sample_count = $6,
              feature_importance = $7, artifact_content_hash = $8,
              metadata = $10
        WHERE training_run_id = $9`,
      [versionId, JSON.stringify(trainingSeasons), trained.featureSetHash, trained.algorithm, hyperparameters,
        trainingRows.length, trained.importance, artifactContentHash, trainingRunId,
        {
          source: "MLB_OFFICIAL settled outcomes + frozen feature snapshots",
          // The explicit list of feature keys that entered this fit, and the
          // list of keys the allowlist admitted but the fitter refused, with
          // the reason for each refusal.
          fittedFeatureKeys: trained.fit.featureNames,
          candidateFeatureKeys: trained.candidateNames,
          droppedFeatures: trained.fit.droppedFeatures,
        }],
    );
    return {
      trainingRunId,
      versionId,
      market,
      status: "CANDIDATE" as const,
      trainingSampleCount: trainingRows.length,
      trainingSeasons,
      featureSetHash: trained.featureSetHash,
      algorithm: trained.algorithm,
      artifactKey,
      artifactGeneration,
      artifactContentHash,
      fittedFeatureKeys: trained.fit.featureNames,
      droppedFeatures: trained.fit.droppedFeatures,
      lambda: trained.fit.lambda,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE model_training_runs
          SET finished_at = now(), status = 'FAILED', error_message = $1
        WHERE training_run_id = $2`,
      [message, trainingRunId],
    );
    throw error;
  }
}

export async function queryModelVersions(market: ModelMarket | null) {
  const result = await pool.query<{
    version_id: string;
    market: string;
    trained_at: string;
    training_seasons: string[];
    feature_set_hash: string;
    algorithm: string;
    hyperparameters: JsonObject;
    training_sample_count: number;
    status: string;
    artifact_key: string;
    artifact_generation: string;
    artifact_content_hash: string;
    walk_forward_acceptance_id: string | null;
    calibration_method: string | null;
    calibration_slope: string | null;
    calibration_intercept: string | null;
  }>(
    `SELECT version_id, market, trained_at, training_seasons, feature_set_hash,
            algorithm, hyperparameters, training_sample_count, status, artifact_key, artifact_generation,
            artifact_content_hash, walk_forward_acceptance_id,
            calibration_method, calibration_slope, calibration_intercept
       FROM model_versions
      ${market ? "WHERE market = $1" : ""}
      ORDER BY trained_at DESC`,
    market ? [toDbMarket(market)] : [],
  );
  return result.rows.map((row) => ({
    versionId: row.version_id,
    market: toShortMarket(row.market),
    trainedAt: row.trained_at,
    trainingSeasons: row.training_seasons,
    featureSetHash: row.feature_set_hash,
    algorithm: row.algorithm,
    hyperparameters: row.hyperparameters,
    trainingSampleCount: row.training_sample_count,
    status: row.status,
    artifactKey: row.artifact_key,
    artifactGeneration: row.artifact_generation,
    artifactContentHash: row.artifact_content_hash,
    walkForwardAcceptanceId: row.walk_forward_acceptance_id,
    calibrationMethod: row.calibration_method,
    calibrationSlope: row.calibration_slope == null ? null : Number(row.calibration_slope),
    calibrationIntercept: row.calibration_intercept == null ? null : Number(row.calibration_intercept),
  }));
}
