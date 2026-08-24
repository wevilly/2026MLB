/**
 * Shared modelling mathematics for the analyst platform.
 *
 * Everything in this file is pure. It holds no database handle and performs no
 * I/O, which is what lets the training service, the walk-forward validator and
 * the daily market board all call exactly the same arithmetic. Before this
 * module the feature flattener existed twice, the sigmoid existed twice, the
 * market thresholds existed twice, and the linear fitter existed twice, which
 * is why the probability the validator measured was not the probability the
 * board served.
 *
 * Interpretation of walk-forward validation, stated once so the code says which
 * one it means: the artifact under validation IS the artifact that gets
 * deployed. Folds exist only to guarantee that the scores used for calibration
 * and for metrics are out-of-sample with respect to the slate being scored.
 * Folds do not refit the model. See walk-forward-validation.ts.
 */

export type NumericVector = Record<string, number>;
type JsonObject = Record<string, unknown>;

// ── Feature extraction ────────────────────────────────────────────────────────

/**
 * Recursively pulls every finite number out of a JSON payload, keyed by its
 * dotted path. This is a transport-level flattener, not a feature selector:
 * see selectTrainableFeatures for the allowlist that decides what a model is
 * permitted to see.
 */
export function flattenNumbers(value: unknown, path = "", result: NumericVector = {}): NumericVector {
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

/**
 * The only three containers a model may read from.
 *
 * feature-store.ts validates hitterFeatures, pitcherFeatures and parkFeatures
 * with assertMetricMap, which guarantees every value in them is a finite
 * research metric or null. Every other number in the frozen feature vector is
 * an identifier, an ordinal, a count, or a display artefact:
 *
 *   playerId, gamePk                         identifiers
 *   researchRank                             an ordinal produced by the engine
 *                                            being modelled, not an observation
 *   opportunityEvidence.*                    display containers whose numeric
 *   starterMatchupEvidence.*                 members are counts and already
 *   bullpenPathEvidence.*                    derived scores, and which include
 *   parkEvidence.*                           reliever player ids under
 *   recentVsSeasonVsCareer.*                 bullpenPathEvidence.rolePath[n]
 *   counterEvidence.*                        .playerId
 *
 * This is an allowlist by construction: a new numeric field added anywhere
 * outside the three metric maps is excluded until somebody adds it here on
 * purpose.
 */
export const TRAINABLE_FEATURE_PREFIXES = [
  "hitterFeatures.",
  "pitcherFeatures.",
  "parkFeatures.",
] as const;

export function isTrainableFeatureKey(key: string): boolean {
  return TRAINABLE_FEATURE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function selectTrainableFeatures(vector: NumericVector): NumericVector {
  const selected: NumericVector = {};
  for (const [key, value] of Object.entries(vector)) {
    if (isTrainableFeatureKey(key)) selected[key] = value;
  }
  return selected;
}

/** Flatten then allowlist in one step. Every caller should use this, not flattenNumbers. */
export function trainableVector(features: unknown): NumericVector {
  return selectTrainableFeatures(flattenNumbers(features));
}

// ── Elementary functions ──────────────────────────────────────────────────────

export function sigmoid(value: number): number {
  const bounded = Math.max(-30, Math.min(30, value));
  return 1 / (1 + Math.exp(-bounded));
}

export function logLoss(probability: number, label: boolean): number {
  const p = Math.max(1e-7, Math.min(1 - 1e-7, probability));
  return label ? -Math.log(p) : -Math.log(1 - p);
}

export function brier(probabilities: number[], labels: boolean[]): number {
  if (!probabilities.length) return Number.NaN;
  return probabilities.reduce((sum, probability, index) => {
    const target = labels[index] ? 1 : 0;
    return sum + (probability - target) ** 2;
  }, 0) / probabilities.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ── Linear algebra ────────────────────────────────────────────────────────────

type Matrix = number[][];

/** Cholesky solve for a symmetric positive definite system. Returns null if not SPD. */
function solveSpd(a: Matrix, b: number[]): number[] | null {
  const n = a.length;
  const l: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = a[i][j];
      for (let k = 0; k < j; k += 1) sum -= l[i][k] * l[j][k];
      if (i === j) {
        if (!(sum > 1e-12)) return null;
        l[i][i] = Math.sqrt(sum);
      } else {
        l[i][j] = sum / l[j][j];
      }
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = b[i];
    for (let k = 0; k < i; k += 1) sum -= l[i][k] * y[k];
    y[i] = sum / l[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i];
    for (let k = i + 1; k < n; k += 1) sum -= l[k][i] * x[k];
    x[i] = sum / l[i][i];
  }
  return x;
}

/** Inverse of a symmetric positive definite matrix. Returns null if not SPD. */
function invertSpd(a: Matrix): Matrix | null {
  const n = a.length;
  const inverse: Matrix = [];
  for (let column = 0; column < n; column += 1) {
    const unit = new Array<number>(n).fill(0);
    unit[column] = 1;
    const solved = solveSpd(a, unit);
    if (!solved) return null;
    inverse.push(solved);
  }
  // solveSpd returned columns; transpose back to rows. The matrix is symmetric,
  // so this is only a readability guarantee, not a correction.
  return Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, column) => inverse[column][row]));
}

// ── Design matrix preparation ─────────────────────────────────────────────────

/**
 * Variance inflation factor cap.
 *
 * The feature set contains xslg, iso, slg, barrel_percent and hard_hit_percent,
 * which all measure the same underlying contact quality. A VIF above 10 is the
 * conventional threshold for "this column is essentially a linear combination
 * of the others"; keeping such a column adds variance to the fit without adding
 * information. L2 shrinkage handles moderate collinearity, so the cap only has
 * to catch the severe cases that shrinkage cannot stabilise.
 */
export const VIF_CAP = 10;

/** Below this ratio of residual norm to original norm a column is rank deficient. */
const RANK_TOLERANCE = 1e-6;

export type DroppedFeature = { name: string; reason: string; detail?: number };

export type DesignMatrix = {
  /** Retained feature names, in column order. */
  featureNames: string[];
  /** Standardised columns, one array of length rowCount per retained feature. */
  columns: number[][];
  featureMeans: NumericVector;
  featureStdDevs: NumericVector;
  droppedFeatures: DroppedFeature[];
  rowCount: number;
};

function correlationMatrix(columns: number[][], rowCount: number): Matrix {
  const p = columns.length;
  const r: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < p; i += 1) {
    for (let j = i; j < p; j += 1) {
      let sum = 0;
      for (let row = 0; row < rowCount; row += 1) sum += columns[i][row] * columns[j][row];
      const value = sum / rowCount;
      r[i][j] = value;
      r[j][i] = value;
    }
    // Guard the diagonal against floating point drift so the matrix stays SPD.
    r[i][i] = Math.max(r[i][i], 1);
  }
  return r;
}

/**
 * Builds the standardised design matrix and records every feature it refuses to
 * fit, with the reason. A dropped feature is recorded rather than being emitted
 * as a coefficient of 0, because a stored 0 is indistinguishable from a
 * legitimately fitted zero.
 */
export function prepareDesignMatrix(
  vectors: NumericVector[],
  candidateNames: string[],
  options: { vifCap?: number } = {},
): DesignMatrix {
  const vifCap = options.vifCap ?? VIF_CAP;
  const rowCount = vectors.length;
  const dropped: DroppedFeature[] = [];
  const featureMeans: NumericVector = {};
  const featureStdDevs: NumericVector = {};

  let names: string[] = [];
  let columns: number[][] = [];

  for (const name of candidateNames) {
    const raw = vectors.map((vector) => {
      const value = vector[name];
      return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
    });
    const present = raw.filter((value) => Number.isFinite(value));
    if (!present.length) {
      dropped.push({ name, reason: "NO_OBSERVED_VALUES" });
      continue;
    }
    const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
    // Missing values are imputed with the training mean here and at inference.
    // On the standardised scale that imputation is exactly zero, which is the
    // only value that adds no signal in either direction.
    const filled = raw.map((value) => (Number.isFinite(value) ? value : mean));
    const sd = standardDeviation(filled);
    if (!(sd > 1e-9)) {
      dropped.push({ name, reason: "ZERO_VARIANCE" });
      continue;
    }
    featureMeans[name] = mean;
    featureStdDevs[name] = sd;
    names.push(name);
    columns.push(filled.map((value) => (value - mean) / sd));
  }

  // Rank reduction by modified Gram-Schmidt. A column whose residual after
  // projecting out the accepted basis is numerically zero is an exact linear
  // combination of columns already kept, and cannot be fitted separately.
  const basis: number[][] = [];
  const rankKeptIndexes: number[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const residual = columns[index].slice();
    for (const vector of basis) {
      const projection = residual.reduce((sum, value, row) => sum + value * vector[row], 0);
      for (let row = 0; row < rowCount; row += 1) residual[row] -= projection * vector[row];
    }
    const originalNorm = Math.sqrt(columns[index].reduce((sum, value) => sum + value * value, 0));
    const residualNorm = Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0));
    if (!(originalNorm > 0) || residualNorm / originalNorm < RANK_TOLERANCE) {
      dropped.push({ name: names[index], reason: "RANK_DEFICIENT" });
      continue;
    }
    basis.push(residual.map((value) => value / residualNorm));
    rankKeptIndexes.push(index);
  }
  names = rankKeptIndexes.map((index) => names[index]);
  columns = rankKeptIndexes.map((index) => columns[index]);

  // Collinearity reduction. VIF for column j is the jth diagonal entry of the
  // inverse correlation matrix, so one inverse gives every VIF at once.
  while (names.length > 1) {
    const inverse = invertSpd(correlationMatrix(columns, rowCount));
    if (!inverse) break;
    let worstIndex = -1;
    let worstVif = vifCap;
    for (let index = 0; index < names.length; index += 1) {
      const vif = inverse[index][index];
      if (Number.isFinite(vif) && vif > worstVif) {
        worstVif = vif;
        worstIndex = index;
      }
    }
    if (worstIndex < 0) break;
    dropped.push({ name: names[worstIndex], reason: "COLLINEAR", detail: Number(worstVif.toFixed(4)) });
    names.splice(worstIndex, 1);
    columns.splice(worstIndex, 1);
  }

  for (const { name } of dropped) {
    delete featureMeans[name];
    delete featureStdDevs[name];
  }

  return { featureNames: names, columns, featureMeans, featureStdDevs, droppedFeatures: dropped, rowCount };
}

// ── Fitters ───────────────────────────────────────────────────────────────────

export type FittedModel = {
  featureNames: string[];
  /** Coefficients on the standardised scale. Pair them with featureMeans and featureStdDevs. */
  coefficients: NumericVector;
  intercept: number;
  featureMeans: NumericVector;
  featureStdDevs: NumericVector;
  droppedFeatures: DroppedFeature[];
  lambda: number;
  converged: boolean;
  iterations: number;
};

export const DEFAULT_LAMBDA_GRID = [0.01, 0.1, 0.3, 1, 3, 10, 30, 100];
const MAX_IRLS_ITERATIONS = 100;
const IRLS_TOLERANCE = 1e-8;

function solveRidgeCoefficients(columns: number[][], target: number[], lambda: number): number[] | null {
  const p = columns.length;
  const rowCount = target.length;
  const gram: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const rhs = new Array<number>(p).fill(0);
  for (let i = 0; i < p; i += 1) {
    for (let j = i; j < p; j += 1) {
      let sum = 0;
      for (let row = 0; row < rowCount; row += 1) sum += columns[i][row] * columns[j][row];
      gram[i][j] = sum;
      gram[j][i] = sum;
    }
    gram[i][i] += lambda;
    let sum = 0;
    for (let row = 0; row < rowCount; row += 1) sum += columns[i][row] * target[row];
    rhs[i] = sum;
  }
  return solveSpd(gram, rhs);
}

/**
 * Iteratively reweighted least squares for L2 penalised logistic regression.
 * The intercept is not penalised. Returns coefficients on the standardised
 * feature scale.
 */
function solveLogisticCoefficients(
  columns: number[][],
  labels: boolean[],
  lambda: number,
): { beta: number[]; intercept: number; converged: boolean; iterations: number } | null {
  const p = columns.length;
  const rowCount = labels.length;
  const y = labels.map((label) => (label ? 1 : 0));
  const positives = y.reduce((sum, value) => sum + value, 0);
  const baseRate = Math.max(1e-6, Math.min(1 - 1e-6, positives / rowCount));
  let intercept = Math.log(baseRate / (1 - baseRate));
  let beta = new Array<number>(p).fill(0);
  let converged = false;
  let iterations = 0;

  for (; iterations < MAX_IRLS_ITERATIONS; iterations += 1) {
    const eta = new Array<number>(rowCount).fill(0);
    for (let row = 0; row < rowCount; row += 1) {
      let sum = intercept;
      for (let j = 0; j < p; j += 1) sum += beta[j] * columns[j][row];
      eta[row] = sum;
    }
    const mu = eta.map((value) => sigmoid(value));
    // Weight floor keeps the Hessian invertible under separation, where the
    // fitted probabilities are driven to 0 or 1 and the true weights vanish.
    const weights = mu.map((value) => Math.max(1e-6, value * (1 - value)));

    const size = p + 1;
    const hessian: Matrix = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    const gradient = new Array<number>(size).fill(0);
    const designRow = (row: number, index: number) => (index === 0 ? 1 : columns[index - 1][row]);
    for (let i = 0; i < size; i += 1) {
      for (let j = i; j < size; j += 1) {
        let sum = 0;
        for (let row = 0; row < rowCount; row += 1) sum += weights[row] * designRow(row, i) * designRow(row, j);
        hessian[i][j] = sum;
        hessian[j][i] = sum;
      }
      let sum = 0;
      for (let row = 0; row < rowCount; row += 1) sum += designRow(row, i) * (y[row] - mu[row]);
      gradient[i] = sum;
    }
    for (let i = 1; i < size; i += 1) {
      hessian[i][i] += lambda;
      gradient[i] -= lambda * beta[i - 1];
    }
    // A small ridge on the intercept only for numerical conditioning; it is
    // three orders of magnitude below any grid lambda and does not shrink.
    hessian[0][0] += 1e-8;

    const step = solveSpd(hessian, gradient);
    if (!step) return null;
    let maxStep = 0;
    intercept += step[0];
    for (let j = 0; j < p; j += 1) {
      beta[j] += step[j + 1];
      maxStep = Math.max(maxStep, Math.abs(step[j + 1]));
    }
    maxStep = Math.max(maxStep, Math.abs(step[0]));
    if (!Number.isFinite(intercept) || beta.some((value) => !Number.isFinite(value))) return null;
    if (maxStep < IRLS_TOLERANCE) {
      converged = true;
      iterations += 1;
      break;
    }
  }
  return { beta, intercept, converged, iterations };
}

function chunkIndexes(rowCount: number, folds: number): number[][] {
  const buckets: number[][] = Array.from({ length: folds }, () => []);
  for (let index = 0; index < rowCount; index += 1) buckets[index % folds].push(index);
  return buckets.filter((bucket) => bucket.length > 0);
}

function toModel(
  design: DesignMatrix,
  beta: number[],
  intercept: number,
  lambda: number,
  converged: boolean,
  iterations: number,
): FittedModel {
  const coefficients: NumericVector = {};
  design.featureNames.forEach((name, index) => {
    coefficients[name] = Number(beta[index].toFixed(10));
  });
  return {
    featureNames: design.featureNames,
    coefficients,
    intercept: Number(intercept.toFixed(10)),
    featureMeans: Object.fromEntries(
      design.featureNames.map((name) => [name, Number(design.featureMeans[name].toFixed(10))]),
    ),
    featureStdDevs: Object.fromEntries(
      design.featureNames.map((name) => [name, Number(design.featureStdDevs[name].toFixed(10))]),
    ),
    droppedFeatures: design.droppedFeatures,
    lambda,
    converged,
    iterations,
  };
}

export class ModelFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelFitError";
  }
}

/**
 * L2 penalised logistic regression on the binary outcome. This is the
 * production fitter: the question the board asks is binary, so the model
 * answers it directly and there is no threshold-subtraction step between the
 * model output and the calibrated probability.
 */
export function fitLogisticModel(
  rows: Array<{ vector: NumericVector; label: boolean }>,
  candidateNames: string[],
  options: { lambdaGrid?: number[]; cvFolds?: number; vifCap?: number } = {},
): FittedModel {
  if (rows.length < 2) throw new ModelFitError("At least two training rows are required.");
  const labels = rows.map((row) => row.label);
  if (labels.every((label) => label) || labels.every((label) => !label)) {
    throw new ModelFitError("Training rows contain a single outcome class.");
  }
  const design = prepareDesignMatrix(rows.map((row) => row.vector), candidateNames, options);
  if (!design.featureNames.length) throw new ModelFitError("No feature survived variance and rank screening.");

  const grid = options.lambdaGrid ?? DEFAULT_LAMBDA_GRID;
  const lambda = selectLambda(grid, options.cvFolds ?? 5, design, labels, null);
  const fit = solveLogisticCoefficients(design.columns, labels, lambda);
  if (!fit) throw new ModelFitError("The penalised logistic system could not be solved.");
  return toModel(design, fit.beta, fit.intercept, lambda, fit.converged, fit.iterations);
}

/**
 * Ridge regression on a continuous target. Retained because the coefficient
 * recovery properties of a genuine multivariate fit are easiest to assert
 * against a known linear truth, and because a future value market may need it.
 */
export function fitRidgeModel(
  rows: Array<{ vector: NumericVector; target: number }>,
  candidateNames: string[],
  options: { lambdaGrid?: number[]; cvFolds?: number; vifCap?: number } = {},
): FittedModel {
  if (rows.length < 2) throw new ModelFitError("At least two training rows are required.");
  const targets = rows.map((row) => row.target);
  const design = prepareDesignMatrix(rows.map((row) => row.vector), candidateNames, options);
  if (!design.featureNames.length) throw new ModelFitError("No feature survived variance and rank screening.");

  const grid = options.lambdaGrid ?? DEFAULT_LAMBDA_GRID;
  const lambda = selectLambda(grid, options.cvFolds ?? 5, design, null, targets);
  const targetMean = targets.reduce((sum, value) => sum + value, 0) / targets.length;
  const centered = targets.map((value) => value - targetMean);
  const beta = solveRidgeCoefficients(design.columns, centered, lambda);
  if (!beta) throw new ModelFitError("The ridge normal equations could not be solved.");
  return toModel(design, beta, targetMean, lambda, true, 1);
}

/**
 * Chooses lambda by k-fold cross validation on the training rows only. Never
 * call this with rows the caller intends to score: the selection is part of
 * the training procedure and is therefore in-sample by definition.
 */
function selectLambda(
  grid: number[],
  folds: number,
  design: DesignMatrix,
  labels: boolean[] | null,
  targets: number[] | null,
): number {
  if (grid.length === 1) return grid[0];
  const buckets = chunkIndexes(design.rowCount, Math.max(2, Math.min(folds, design.rowCount)));
  if (buckets.length < 2) return grid[Math.floor(grid.length / 2)];

  let bestLambda = grid[0];
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const lambda of grid) {
    let total = 0;
    let counted = 0;
    let usable = true;
    for (const holdout of buckets) {
      const holdoutSet = new Set(holdout);
      const trainIndexes = Array.from({ length: design.rowCount }, (_, index) => index)
        .filter((index) => !holdoutSet.has(index));
      if (trainIndexes.length < 2) { usable = false; break; }
      const trainColumns = design.columns.map((column) => trainIndexes.map((index) => column[index]));
      if (labels) {
        const trainLabels = trainIndexes.map((index) => labels[index]);
        if (trainLabels.every((label) => label) || trainLabels.every((label) => !label)) { usable = false; break; }
        const fit = solveLogisticCoefficients(trainColumns, trainLabels, lambda);
        if (!fit) { usable = false; break; }
        for (const index of holdout) {
          let eta = fit.intercept;
          design.columns.forEach((column, j) => { eta += fit.beta[j] * column[index]; });
          total += logLoss(sigmoid(eta), labels[index]);
          counted += 1;
        }
      } else if (targets) {
        const trainTargets = trainIndexes.map((index) => targets[index]);
        const mean = trainTargets.reduce((sum, value) => sum + value, 0) / trainTargets.length;
        const beta = solveRidgeCoefficients(trainColumns, trainTargets.map((value) => value - mean), lambda);
        if (!beta) { usable = false; break; }
        for (const index of holdout) {
          let prediction = mean;
          design.columns.forEach((column, j) => { prediction += beta[j] * column[index]; });
          total += (prediction - targets[index]) ** 2;
          counted += 1;
        }
      }
    }
    if (!usable || !counted) continue;
    const loss = total / counted;
    if (loss < bestLoss) {
      bestLoss = loss;
      bestLambda = lambda;
    }
  }
  return bestLambda;
}

// ── Artifact ──────────────────────────────────────────────────────────────────

/**
 * The algorithm identifier is compared for identity when an artifact is loaded.
 * It changed from deterministic-centered-linear-v1 because that fitter summed
 * univariate slopes; an old artifact must be rejected, never reinterpreted
 * under the new scoring rules.
 */
export const MODEL_ALGORITHM = "regularized-logistic-standardized-v2";
export const MODEL_ARTIFACT_SCHEMA_VERSION = 2;

export type ModelArtifact = {
  schemaVersion: number;
  market: string;
  algorithm: string;
  featureSetHash: string;
  featureNames: string[];
  coefficients: NumericVector;
  intercept: number;
  featureMeans: NumericVector;
  featureStdDevs: NumericVector;
  droppedFeatures: DroppedFeature[];
  lambda: number;
  target: string;
  link: string;
};

export class ModelArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelArtifactError";
  }
}

function isNumericRecord(value: unknown): value is NumericVector {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as JsonObject).every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * Parses and identity-checks a stored artifact. Every failure is a hard throw:
 * a model whose identity does not match its database row is not a model whose
 * output can be labelled with that row's calibration.
 */
export function parseModelArtifact(
  raw: string,
  expected: { market: string; algorithm: string; featureSetHash: string },
): ModelArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelArtifactError("The model artifact is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelArtifactError("The model artifact has an invalid shape.");
  }
  const artifact = parsed as Partial<ModelArtifact>;
  if (artifact.schemaVersion !== MODEL_ARTIFACT_SCHEMA_VERSION) {
    throw new ModelArtifactError(
      `The model artifact schema version is not ${MODEL_ARTIFACT_SCHEMA_VERSION}.`,
    );
  }
  if (artifact.algorithm !== expected.algorithm || artifact.algorithm !== MODEL_ALGORITHM) {
    throw new ModelArtifactError("The model artifact algorithm is not the supported algorithm.");
  }
  if (artifact.market !== expected.market || artifact.featureSetHash !== expected.featureSetHash) {
    throw new ModelArtifactError("The model artifact identity does not match its database version.");
  }
  if (!Array.isArray(artifact.featureNames) || !artifact.featureNames.every((name) => typeof name === "string")) {
    throw new ModelArtifactError("The model artifact is missing its frozen feature schema.");
  }
  if (typeof artifact.intercept !== "number" || !Number.isFinite(artifact.intercept)) {
    throw new ModelArtifactError("The model artifact intercept is not a finite number.");
  }
  if (!isNumericRecord(artifact.coefficients)) {
    throw new ModelArtifactError("The model artifact coefficients are not finite numbers.");
  }
  if (!isNumericRecord(artifact.featureMeans) || !isNumericRecord(artifact.featureStdDevs)) {
    throw new ModelArtifactError(
      "The model artifact is missing the training means and standardisation parameters required for inference.",
    );
  }
  for (const name of artifact.featureNames) {
    if (!(name in artifact.coefficients)) {
      throw new ModelArtifactError(`The model artifact has no coefficient for "${name}".`);
    }
    if (!(name in artifact.featureMeans) || !(name in artifact.featureStdDevs)) {
      throw new ModelArtifactError(`The model artifact has no standardisation parameters for "${name}".`);
    }
  }
  return {
    schemaVersion: artifact.schemaVersion,
    market: artifact.market as string,
    algorithm: artifact.algorithm,
    featureSetHash: artifact.featureSetHash as string,
    featureNames: artifact.featureNames,
    coefficients: artifact.coefficients,
    intercept: artifact.intercept,
    featureMeans: artifact.featureMeans,
    featureStdDevs: artifact.featureStdDevs,
    droppedFeatures: Array.isArray(artifact.droppedFeatures) ? artifact.droppedFeatures : [],
    lambda: typeof artifact.lambda === "number" ? artifact.lambda : 0,
    target: typeof artifact.target === "string" ? artifact.target : "outcome_hit",
    link: typeof artifact.link === "string" ? artifact.link : "logit",
  };
}

/**
 * Minimum fraction of the artifact's frozen feature schema that must be present
 * in an inference vector before a probability may be emitted. Policy, not a
 * derived quantity: below this the probability is being produced mostly from
 * imputed means and should not be labelled as a model output.
 */
export const MIN_FEATURE_COVERAGE = 0.8;

/**
 * Confirmation threshold. A calibrated probability at or above this value is
 * labelled MODEL_CONFIRMED; below it the model ran and declined, which is
 * MODEL_DECLINED and is a legitimate model output rather than a rejection.
 *
 * This is policy, not a derived quantity. It is not a break-even, an edge, or
 * anything priced: pricing is handled outside this system by the operator.
 */
export const MODEL_CONFIRMATION_THRESHOLD = 0.55;

/**
 * The probability at which a STRONG research state may be labelled FIRE.
 * Policy, not derived. FIRE is a confidence label, not a recommendation to
 * stake anything.
 */
export const MODEL_FIRE_THRESHOLD = 0.65;

export type ArtifactScore = {
  rawScore: number;
  /** Features the artifact expects that the inference vector did not supply. */
  imputedFeatures: string[];
  /** Fraction of the frozen feature schema actually present. */
  coverage: number;
  /** Keys present in the inference vector that the artifact does not know about. */
  unknownFeatures: string[];
};

/**
 * The single scoring transformation. The validator and the daily market board
 * both call this; the arithmetic exists nowhere else. A feature the vector does
 * not supply is imputed with its stored training mean, which on the
 * standardised scale is exactly zero. It is never imputed with 0 on the raw
 * scale, which for a metric like xslg would be a full unit below the mean.
 */
export function scoreArtifact(artifact: ModelArtifact, vector: NumericVector): ArtifactScore {
  const imputedFeatures: string[] = [];
  let rawScore = artifact.intercept;
  for (const name of artifact.featureNames) {
    const value = vector[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      imputedFeatures.push(name);
      continue;
    }
    const sd = artifact.featureStdDevs[name];
    if (!(sd > 0)) {
      imputedFeatures.push(name);
      continue;
    }
    rawScore += (artifact.coefficients[name] ?? 0) * ((value - artifact.featureMeans[name]) / sd);
  }
  const known = new Set(artifact.featureNames);
  const unknownFeatures = Object.keys(vector).filter((key) => !known.has(key)).sort();
  const coverage = artifact.featureNames.length
    ? (artifact.featureNames.length - imputedFeatures.length) / artifact.featureNames.length
    : 0;
  return { rawScore, imputedFeatures, coverage, unknownFeatures };
}

/** The single calibration transformation. Platt scaling of the model's raw score. */
export function applyCalibration(rawScore: number, slope: number, intercept: number): number {
  return sigmoid(slope * rawScore + intercept);
}

// ── Calibration and validation metrics ────────────────────────────────────────

/** Ten bins rather than five: five bins cannot resolve a 0.05 calibration error. */
export const CALIBRATION_BIN_COUNT = 10;

/**
 * Expected calibration error pass threshold. Policy, not derived. 0.05 means
 * the average predicted probability in a reliability bin may sit five points
 * away from the observed rate in that bin.
 */
export const CALIBRATION_ECE_THRESHOLD = 0.05;

/**
 * A model must vary its predictions to pass. Without this guard a model that
 * emits the base rate for every row scores an expected calibration error of
 * approximately zero and passes while carrying no information at all.
 */
export const SHARPNESS_MIN_STD_DEV = 0.03;

/**
 * Five folds is the minimum defensible walk-forward count. Two folds gives two
 * held-out slates, which cannot distinguish a model from the ordering of two
 * particular days; the pooled test set is also too small for the benchmark
 * margin below to be anything but noise.
 */
export const MIN_FOLD_COUNT = 5;

/** Two standard errors of the paired Brier difference. */
export const BENCHMARK_MARGIN_Z = 2;

export type ReliabilityBin = {
  bucket: number;
  count: number;
  predictedProbability: number | null;
  observedRate: number | null;
};

export function makeReliabilityCurve(
  probabilities: number[],
  labels: boolean[],
  bins = CALIBRATION_BIN_COUNT,
): ReliabilityBin[] {
  const totals = Array.from({ length: bins }, () => ({ count: 0, predicted: 0, observed: 0 }));
  probabilities.forEach((probability, index) => {
    const bucket = Math.min(bins - 1, Math.max(0, Math.floor(probability * bins)));
    totals[bucket].count += 1;
    totals[bucket].predicted += probability;
    totals[bucket].observed += labels[index] ? 1 : 0;
  });
  return totals.map((total, bucket) => ({
    bucket,
    count: total.count,
    predictedProbability: total.count ? Number((total.predicted / total.count).toFixed(6)) : null,
    observedRate: total.count ? Number((total.observed / total.count).toFixed(6)) : null,
  }));
}

/**
 * Expected calibration error over the reliability bins.
 *
 *   ECE = sum over bins of (n_b / N) * |observedRate_b - predictedProbability_b|
 *
 * Empty bins are skipped rather than contributing zero, which would dilute the
 * average with bins that carry no evidence.
 */
export function expectedCalibrationError(curve: ReliabilityBin[]): number {
  const total = curve.reduce((sum, bin) => sum + bin.count, 0);
  if (!total) return Number.NaN;
  let error = 0;
  for (const bin of curve) {
    if (!bin.count || bin.predictedProbability === null || bin.observedRate === null) continue;
    error += (bin.count / total) * Math.abs(bin.observedRate - bin.predictedProbability);
  }
  return error;
}

/**
 * Brier skill score against a reference forecast. Positive means the model's
 * squared error is lower than the reference's; zero means it is identical.
 */
export function brierSkillScore(modelBrier: number, referenceBrier: number): number {
  if (!(referenceBrier > 0)) return Number.NaN;
  return 1 - modelBrier / referenceBrier;
}

/**
 * Standard error of the mean Brier score on a test set of this size.
 *
 * The old gate used a fixed margin of 0.001, which is below the noise floor of
 * any realistic test set. The replacement is justified by the test-set size:
 * the per-row Brier contribution of the benchmark forecast has an observable
 * spread, and the standard error of its mean is that spread divided by the
 * square root of the row count. On 1,000 held-out rows at a 38 percent base
 * rate this is on the order of 0.003, so the two-standard-error margin below
 * is roughly 0.006 rather than 0.001, and a model that is indistinguishable
 * from the base rate no longer passes by accident.
 */
export function benchmarkBrierStandardError(benchmarkProbabilities: number[], labels: boolean[]): number {
  const n = labels.length;
  if (n < 2) return Number.POSITIVE_INFINITY;
  const contributions = labels.map((label, index) => (benchmarkProbabilities[index] - (label ? 1 : 0)) ** 2);
  const sd = standardDeviation(contributions);
  if (!(sd > 0)) return Number.POSITIVE_INFINITY;
  return sd / Math.sqrt(n);
}

export type CalibrationGateInput = {
  probabilities: number[];
  labels: boolean[];
  benchmarkProbabilities: number[];
  foldCount: number;
  hasLearnedSignal: boolean;
};

export type CalibrationGateResult = {
  reliabilityCurve: ReliabilityBin[];
  expectedCalibrationError: number;
  eceThreshold: number;
  ecePassed: boolean;
  sharpness: number;
  sharpnessThreshold: number;
  sharpnessPassed: boolean;
  modelBrier: number;
  benchmarkBrier: number;
  brierSkillScore: number;
  benchmarkMargin: number;
  benchmarkBeat: boolean;
  foldCountPassed: boolean;
  calibrationPassed: boolean;
  passed: boolean;
  failureReasons: string[];
};

/**
 * The whole acceptance gate in one place, so the reasons a model failed are a
 * list rather than a boolean.
 */
export function evaluateCalibrationGate(input: CalibrationGateInput): CalibrationGateResult {
  const { probabilities, labels, benchmarkProbabilities, foldCount, hasLearnedSignal } = input;
  const reliabilityCurve = makeReliabilityCurve(probabilities, labels);
  const ece = expectedCalibrationError(reliabilityCurve);
  const ecePassed = Number.isFinite(ece) && ece <= CALIBRATION_ECE_THRESHOLD;

  const sharpness = standardDeviation(probabilities);
  const sharpnessPassed = sharpness > SHARPNESS_MIN_STD_DEV;

  const modelBrier = brier(probabilities, labels);
  const benchmarkBrier = brier(benchmarkProbabilities, labels);
  const skill = brierSkillScore(modelBrier, benchmarkBrier);
  const standardError = benchmarkBrierStandardError(benchmarkProbabilities, labels);
  const benchmarkMargin = Number.isFinite(standardError)
    ? BENCHMARK_MARGIN_Z * standardError
    : Number.POSITIVE_INFINITY;
  const benchmarkBeat = hasLearnedSignal
    && Number.isFinite(skill)
    && skill > 0
    && benchmarkBrier - modelBrier > benchmarkMargin;

  const foldCountPassed = foldCount >= MIN_FOLD_COUNT;
  const calibrationPassed = ecePassed && sharpnessPassed;
  const failureReasons: string[] = [];
  if (!foldCountPassed) failureReasons.push(`FOLD_COUNT_BELOW_${MIN_FOLD_COUNT}`);
  if (!ecePassed) failureReasons.push("EXPECTED_CALIBRATION_ERROR_ABOVE_THRESHOLD");
  if (!sharpnessPassed) failureReasons.push("PREDICTIONS_NOT_SHARP_ENOUGH");
  if (!benchmarkBeat) failureReasons.push("BENCHMARK_MARGIN_NOT_MET");

  return {
    reliabilityCurve,
    expectedCalibrationError: ece,
    eceThreshold: CALIBRATION_ECE_THRESHOLD,
    ecePassed,
    sharpness,
    sharpnessThreshold: SHARPNESS_MIN_STD_DEV,
    sharpnessPassed,
    modelBrier,
    benchmarkBrier,
    brierSkillScore: skill,
    benchmarkMargin,
    benchmarkBeat,
    foldCountPassed,
    calibrationPassed,
    passed: foldCountPassed && calibrationPassed && benchmarkBeat,
    failureReasons,
  };
}

/**
 * Fits Platt slope and intercept by Newton descent on log loss. The previous
 * implementation searched a fixed grid stepping 0.25 from 0.25 to 4 in slope
 * and -3 to 3 in intercept, which cannot represent a model whose scores are on
 * a different scale and cannot resolve anything finer than a quarter unit.
 */
export function fitPlatt(scores: number[], labels: boolean[]): { slope: number; intercept: number; converged: boolean } {
  if (!scores.length) return { slope: 1, intercept: 0, converged: false };
  const y = labels.map((label) => (label ? 1 : 0));
  const positives = y.reduce((sum, value) => sum + value, 0);
  const baseRate = Math.max(1e-6, Math.min(1 - 1e-6, positives / y.length));
  const interceptOnly = Math.log(baseRate / (1 - baseRate));

  // Standardise the scores before optimising and fold the standardisation back
  // into the returned parameters. The optimiser then behaves identically for a
  // model whose scores are logits and for one whose scores are on any other
  // scale, which the previous fixed 0.25-to-4 slope grid could not do.
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const sd = standardDeviation(scores);
  if (!(sd > 0)) return { slope: 0, intercept: interceptOnly, converged: true };
  const z = scores.map((score) => (score - mean) / sd);

  const loss = (slope: number, intercept: number) =>
    z.reduce((sum, value, index) => sum + logLoss(sigmoid(slope * value + intercept), labels[index]), 0) / z.length;

  let slope = 1;
  let intercept = interceptOnly;
  let currentLoss = loss(slope, intercept);
  let converged = false;

  for (let iteration = 0; iteration < MAX_IRLS_ITERATIONS; iteration += 1) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 1e-9;
    let h01 = 0;
    let h11 = 1e-9;
    for (let index = 0; index < z.length; index += 1) {
      const p = sigmoid(slope * z[index] + intercept);
      const w = Math.max(1e-9, p * (1 - p));
      const residual = y[index] - p;
      g0 += residual * z[index];
      g1 += residual;
      h00 += w * z[index] * z[index];
      h01 += w * z[index];
      h11 += w;
    }
    const determinant = h00 * h11 - h01 * h01;
    if (!(Math.abs(determinant) > 1e-14)) break;
    const stepSlope = (h11 * g0 - h01 * g1) / determinant;
    const stepIntercept = (h00 * g1 - h01 * g0) / determinant;
    if (!Number.isFinite(stepSlope) || !Number.isFinite(stepIntercept)) break;

    // Backtracking: a full Newton step on a saturated fit can overshoot into a
    // worse log loss, so shrink until the step actually improves.
    let scale = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidateSlope = slope + scale * stepSlope;
      const candidateIntercept = intercept + scale * stepIntercept;
      const candidateLoss = loss(candidateSlope, candidateIntercept);
      if (Number.isFinite(candidateLoss) && candidateLoss <= currentLoss) {
        const movement = Math.max(Math.abs(scale * stepSlope), Math.abs(scale * stepIntercept));
        slope = candidateSlope;
        intercept = candidateIntercept;
        currentLoss = candidateLoss;
        accepted = true;
        if (movement < 1e-10) converged = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) {
      converged = true;
      break;
    }
    if (converged) break;
  }

  return {
    slope: slope / sd,
    intercept: intercept - (slope * mean) / sd,
    converged,
  };
}
