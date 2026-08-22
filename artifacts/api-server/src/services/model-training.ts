import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { storeModelArtifact, verifyModelArtifact } from "../lib/model-artifact-storage";

export const MODEL_MARKETS = ["TB", "XBH", "WALK", "HR"] as const;
export type ModelMarket = (typeof MODEL_MARKETS)[number];
type JsonObject = Record<string, unknown>;

const DB_MARKETS: Record<ModelMarket, string> = {
  TB: "TOTAL_BASES_2_PLUS",
  XBH: "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR: "HOME_RUN",
};

export class ModelTrainingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTrainingValidationError";
  }
}

function featureSetHash(names: string[]): string {
  return createHash("sha256").update(names.slice().sort().join("\n")).digest("hex");
}

export function flattenNumbers(value: unknown, path = "", result: Record<string, number> = {}): Record<string, number> {
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

function trainLinearArtifact(market: ModelMarket, rows: Array<{ features: JsonObject; outcomeValue: number }>) {
  const vectors = rows.map((row) => flattenNumbers(row.features));
  const names = [...new Set(vectors.flatMap((vector) => Object.keys(vector)))].sort();
  const means = new Map(names.map((name) => [name, rows.reduce((sum, _, index) => sum + (vectors[index][name] ?? 0), 0) / rows.length]));
  const targetMean = rows.reduce((sum, row) => sum + row.outcomeValue, 0) / rows.length;
  const coefficients: Record<string, number> = {};
  const importance: Record<string, number> = {};

  for (const name of names) {
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const centeredFeature = (vectors[index][name] ?? 0) - (means.get(name) ?? 0);
      numerator += centeredFeature * (rows[index].outcomeValue - targetMean);
      denominator += centeredFeature * centeredFeature;
    }
    const coefficient = denominator ? numerator / denominator : 0;
    coefficients[name] = Number(coefficient.toFixed(10));
    importance[name] = Number(Math.abs(coefficient).toFixed(10));
  }

  const intercept = Number((targetMean - names.reduce((sum, name) => sum + (coefficients[name] ?? 0) * (means.get(name) ?? 0), 0)).toFixed(10));
  const algorithm = "deterministic-centered-linear-v1";
  const hash = featureSetHash(names);
  return {
    algorithm,
    featureSetHash: hash,
    artifact: {
      schemaVersion: 1,
      market,
      algorithm,
      featureSetHash: hash,
      featureNames: names,
      coefficients,
      intercept,
    },
    importance,
  };
}

export async function trainMarketModel(market: ModelMarket) {
  const trainingRunId = randomUUID();
  const algorithm = "deterministic-centered-linear-v1";
  await pool.query(
    `INSERT INTO model_training_runs
       (training_run_id, market, status, algorithm, metadata)
     VALUES ($1, $2, 'RUNNING', $3, $4)`,
    [trainingRunId, DB_MARKETS[market], algorithm, { source: "MLB_OFFICIAL settled outcomes + frozen feature snapshots" }],
  );

  try {
    const rows = await pool.query<{
      features: JsonObject;
      outcome_value: string;
      slate_date: string;
    }>(
      `SELECT pfs.features, ho.outcome_value, pfs.slate_date::text AS slate_date
       FROM pregame_feature_snapshots pfs
       JOIN historical_outcomes ho
         ON ho.player_id = pfs.player_id
        AND ho.game_pk = pfs.game_pk
        AND ho.slate_date = pfs.slate_date
        AND ho.market = pfs.market
        AND ho.settlement_state = 'SETTLED'
        AND ho.source_id = 'MLB_OFFICIAL'
       WHERE pfs.market = $1
         AND NOT EXISTS (
           SELECT 1 FROM pregame_feature_snapshots newer
            WHERE newer.correction_of = pfs.snapshot_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM historical_outcomes newer
            WHERE newer.correction_of = ho.outcome_id
         )
       ORDER BY pfs.slate_date, pfs.created_at`,
      [DB_MARKETS[market]],
    );
    if (!rows.rows.length) {
      throw new ModelTrainingValidationError(`No official settled training rows are available for ${market}.`);
    }

    const trainingRows = rows.rows.map((row) => ({ features: row.features ?? {}, outcomeValue: Number(row.outcome_value) }));
    const trained = trainLinearArtifact(market, trainingRows);
    const versionId = `${market.toLowerCase()}-${randomUUID()}`;
    const content = JSON.stringify(trained.artifact);
    const artifactContentHash = createHash("sha256").update(content).digest("hex");
    const { artifactKey, artifactGeneration } = await storeModelArtifact(versionId, content, artifactContentHash);
    await verifyModelArtifact(artifactKey, artifactGeneration, artifactContentHash);
    const trainingSeasons = [...new Set(rows.rows.map((row) => row.slate_date.slice(0, 4)))].sort();
    const hyperparameters = {
      market,
      target: "outcome_value",
      centering: "feature-and-target-means",
      featureCount: Object.keys(trained.artifact.coefficients).length,
    };

    await pool.query(
      `INSERT INTO model_versions
         (version_id, market, training_seasons, feature_set_hash, algorithm,
          hyperparameters, training_sample_count, status, artifact_key, artifact_generation, artifact_content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CANDIDATE', $8, $9, $10)`,
      [versionId, DB_MARKETS[market], JSON.stringify(trainingSeasons), trained.featureSetHash, trained.algorithm,
        hyperparameters, trainingRows.length, artifactKey, artifactGeneration, artifactContentHash],
    );
    await pool.query(
      `UPDATE model_training_runs
          SET model_version_id = $1, finished_at = now(), status = 'SUCCESS',
              training_seasons = $2, feature_set_hash = $3, algorithm = $4,
              hyperparameters = $5, training_sample_count = $6,
              feature_importance = $7, artifact_content_hash = $8
        WHERE training_run_id = $9`,
      [versionId, JSON.stringify(trainingSeasons), trained.featureSetHash, trained.algorithm, hyperparameters,
        trainingRows.length, trained.importance, artifactContentHash, trainingRunId],
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
    market ? [DB_MARKETS[market]] : [],
  );
  return result.rows.map((row) => ({
    versionId: row.version_id,
    market: row.market === "TOTAL_BASES_2_PLUS" ? "TB" : row.market === "EXTRA_BASE_HIT" ? "XBH" : row.market === "BATTER_WALK" ? "WALK" : "HR",
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