/**
 * The controlled path from CANDIDATE to ACTIVE, and back.
 *
 * Before this module nothing in production code ever set
 * model_versions.status to ACTIVE. Training wrote CANDIDATE, validation wrote
 * CANDIDATE on pass and CANDIDATE or FAILED on fail, and the only writes of
 * ACTIVE anywhere in the repository were direct SQL statements inside two test
 * files. The database trigger in apply-immutability.mjs guarded an ACTIVE
 * transition that nothing performed. The confidence layer had therefore never
 * run: 7 CANDIDATE versions, 1 FAILED, 0 ACTIVE, and 1,472 board rows reading
 * RESEARCH_ONLY / NONE.
 *
 * Promotion is operator-initiated and stays that way. The orchestration
 * pipeline trains and validates; it does not promote. Revisit only after at
 * least two weeks of validation history exist.
 */
import { pool } from "@workspace/db";
import { recordAuditEvent } from "./audit";
import { toShortMarketOrNull, type ModelMarket } from "./market-codes";
import { CALIBRATION_ECE_THRESHOLD, MIN_FOLD_COUNT, SHARPNESS_MIN_STD_DEV } from "./model-math";

/** Terminal status a displaced model moves to. The lifecycle trigger permits only this. */
const DISPLACED_STATUS = "RETIRED";

export type PromotionRefusalReason =
  | "VERSION_NOT_FOUND"
  | "VERSION_NOT_CANDIDATE"
  | "NO_WALK_FORWARD_ACCEPTANCE"
  | "WALK_FORWARD_RUN_MISSING"
  | "WALK_FORWARD_RUN_NOT_PASS"
  | "FOLD_COUNT_BELOW_MINIMUM"
  | "EXPECTED_CALIBRATION_ERROR_ABOVE_THRESHOLD"
  | "SHARPNESS_GUARD_NOT_MET"
  | "BENCHMARK_MARGIN_NOT_MET"
  | "CALIBRATION_PARAMETERS_MISSING"
  | "UNKNOWN_MARKET";

export class ModelPromotionError extends Error {
  readonly reason: PromotionRefusalReason | "VERSION_NOT_ACTIVE";

  constructor(reason: PromotionRefusalReason | "VERSION_NOT_ACTIVE", message: string) {
    super(message);
    this.name = "ModelPromotionError";
    this.reason = reason;
  }
}

export type PromotionCandidate = {
  version_id: string;
  market: string;
  status: string;
  walk_forward_acceptance_id: string | null;
  calibration_slope: string | null;
  calibration_intercept: string | null;
  run_status: string | null;
  run_fold_count: number | null;
  run_benchmark_beat: boolean | null;
  run_calibration_passed: boolean | null;
  run_expected_calibration_error: string | null;
  run_prediction_std_dev: string | null;
  run_brier_skill_score: string | null;
};

async function loadPromotionCandidate(versionId: string): Promise<PromotionCandidate | null> {
  const result = await pool.query<PromotionCandidate>(
    `SELECT mv.version_id, mv.market::text AS market, mv.status::text AS status,
            mv.walk_forward_acceptance_id::text AS walk_forward_acceptance_id,
            mv.calibration_slope::text AS calibration_slope,
            mv.calibration_intercept::text AS calibration_intercept,
            wfr.status::text AS run_status,
            wfr.fold_count AS run_fold_count,
            wfr.benchmark_beat AS run_benchmark_beat,
            wfr.calibration_passed AS run_calibration_passed,
            wfr.expected_calibration_error::text AS run_expected_calibration_error,
            wfr.prediction_std_dev::text AS run_prediction_std_dev,
            wfr.brier_skill_score::text AS run_brier_skill_score
       FROM model_versions mv
       LEFT JOIN walk_forward_runs wfr
         ON wfr.walk_forward_run_id = mv.walk_forward_acceptance_id
        AND wfr.model_version_id = mv.version_id
      WHERE mv.version_id = $1`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

/**
 * Every condition that must hold before a model may serve a probability to a
 * human. Each refusal names one reason, so an operator is told what failed
 * rather than being told no.
 */
export function promotionRefusalFor(
  candidate: PromotionCandidate,
): { reason: PromotionRefusalReason; message: string } | null {
  if (candidate.status !== "CANDIDATE") {
    return {
      reason: "VERSION_NOT_CANDIDATE",
      message: `Only a CANDIDATE version may be promoted; this version is ${candidate.status}.`,
    };
  }
  if (!toShortMarketOrNull(candidate.market)) {
    return { reason: "UNKNOWN_MARKET", message: `Version market ${candidate.market} is not a modelled market.` };
  }
  if (!candidate.walk_forward_acceptance_id) {
    return {
      reason: "NO_WALK_FORWARD_ACCEPTANCE",
      message: "The version has no walk-forward acceptance record.",
    };
  }
  if (candidate.run_status === null) {
    return {
      reason: "WALK_FORWARD_RUN_MISSING",
      message: "The referenced walk-forward run does not exist for this version.",
    };
  }
  if (candidate.run_status !== "PASS") {
    return {
      reason: "WALK_FORWARD_RUN_NOT_PASS",
      message: `The referenced walk-forward run has status ${candidate.run_status}, not PASS.`,
    };
  }
  if ((candidate.run_fold_count ?? 0) < MIN_FOLD_COUNT) {
    return {
      reason: "FOLD_COUNT_BELOW_MINIMUM",
      message: `The walk-forward run has ${candidate.run_fold_count ?? 0} fold(s); ${MIN_FOLD_COUNT} are required.`,
    };
  }
  const ece = candidate.run_expected_calibration_error === null
    ? null
    : Number(candidate.run_expected_calibration_error);
  if (ece === null || !Number.isFinite(ece) || ece > CALIBRATION_ECE_THRESHOLD) {
    return {
      reason: "EXPECTED_CALIBRATION_ERROR_ABOVE_THRESHOLD",
      message: `Expected calibration error ${ece ?? "is unrecorded"} exceeds the ${CALIBRATION_ECE_THRESHOLD} threshold.`,
    };
  }
  const sharpness = candidate.run_prediction_std_dev === null
    ? null
    : Number(candidate.run_prediction_std_dev);
  if (sharpness === null || !Number.isFinite(sharpness) || sharpness <= SHARPNESS_MIN_STD_DEV) {
    return {
      reason: "SHARPNESS_GUARD_NOT_MET",
      message: `Prediction standard deviation ${sharpness ?? "is unrecorded"} does not exceed ${SHARPNESS_MIN_STD_DEV}.`,
    };
  }
  if (candidate.run_benchmark_beat !== true) {
    return {
      reason: "BENCHMARK_MARGIN_NOT_MET",
      message: "The walk-forward run did not beat its benchmark by the required margin.",
    };
  }
  if (candidate.run_calibration_passed !== true) {
    return {
      reason: "EXPECTED_CALIBRATION_ERROR_ABOVE_THRESHOLD",
      message: "The walk-forward run did not pass calibration.",
    };
  }
  if (candidate.calibration_slope === null || candidate.calibration_intercept === null) {
    return {
      reason: "CALIBRATION_PARAMETERS_MISSING",
      message: "The version has no accepted calibration slope and intercept.",
    };
  }
  return null;
}

export type PromotionResult = {
  versionId: string;
  market: ModelMarket;
  status: "ACTIVE";
  displacedVersionId: string | null;
  displacedStatus: string | null;
  walkForwardRunId: string;
  foldCount: number;
  expectedCalibrationError: number;
  predictionStdDev: number;
  brierSkillScore: number | null;
  calibrationSlope: number;
  calibrationIntercept: number;
  promotedAt: string;
};

/**
 * Promotes one CANDIDATE version to ACTIVE and retires whatever was ACTIVE for
 * the same market, in one transaction, under the controlled validation writer
 * role so the database lifecycle trigger is exercised rather than bypassed.
 *
 * Exactly one ACTIVE row per market is also enforced by a partial unique index
 * in lib/db/scripts/apply-immutability.mjs. Application code is not the only
 * thing standing between this system and two live models for one market.
 */
export async function promoteModelVersion(
  versionId: string,
  options: { actor?: string | null; requestId?: string | null } = {},
): Promise<PromotionResult> {
  const candidate = await loadPromotionCandidate(versionId);
  if (!candidate) {
    throw new ModelPromotionError("VERSION_NOT_FOUND", `Model version ${versionId} was not found.`);
  }
  const refusal = promotionRefusalFor(candidate);
  if (refusal) throw new ModelPromotionError(refusal.reason, refusal.message);

  const market = toShortMarketOrNull(candidate.market)!;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE mlb_walk_forward_validator");

    // Re-read under the transaction so a concurrent promotion cannot slip
    // between the gate check and the write.
    const locked = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM model_versions WHERE version_id = $1 FOR UPDATE`,
      [versionId],
    );
    if (locked.rows[0]?.status !== "CANDIDATE") {
      throw new ModelPromotionError(
        "VERSION_NOT_CANDIDATE",
        `Only a CANDIDATE version may be promoted; this version is ${locked.rows[0]?.status ?? "missing"}.`,
      );
    }

    const displaced = await client.query<{ version_id: string }>(
      `UPDATE model_versions
          SET status = '${DISPLACED_STATUS}'
        WHERE market = $1::market_type
          AND status = 'ACTIVE'
          AND version_id <> $2
        RETURNING version_id`,
      [candidate.market, versionId],
    );

    await client.query(
      `UPDATE model_versions SET status = 'ACTIVE' WHERE version_id = $1`,
      [versionId],
    );

    const promotedAt = new Date().toISOString();
    const auditMetadata = {
      market,
      walkForwardRunId: candidate.walk_forward_acceptance_id,
      foldCount: candidate.run_fold_count,
      expectedCalibrationError: Number(candidate.run_expected_calibration_error),
      expectedCalibrationErrorThreshold: CALIBRATION_ECE_THRESHOLD,
      predictionStdDev: Number(candidate.run_prediction_std_dev),
      brierSkillScore: candidate.run_brier_skill_score === null
        ? null
        : Number(candidate.run_brier_skill_score),
      displacedVersionId: displaced.rows[0]?.version_id ?? null,
      displacedStatus: displaced.rows.length ? DISPLACED_STATUS : null,
    };

    // The audit insert is not the validation writer's to make, so the role is
    // released first. It stays inside the transaction: an unaudited promotion
    // must not be possible.
    await client.query("RESET ROLE");
    await recordAuditEvent({
      actor: options.actor ?? "OPERATOR",
      requestId: options.requestId ?? null,
      action: "MODEL_VERSION_PROMOTED",
      resourceType: "model_versions",
      resourceId: versionId,
      metadata: auditMetadata,
    }, client);

    await client.query("COMMIT");
    return {
      versionId,
      market,
      status: "ACTIVE",
      displacedVersionId: auditMetadata.displacedVersionId,
      displacedStatus: auditMetadata.displacedStatus,
      walkForwardRunId: candidate.walk_forward_acceptance_id!,
      foldCount: candidate.run_fold_count ?? 0,
      expectedCalibrationError: auditMetadata.expectedCalibrationError,
      predictionStdDev: auditMetadata.predictionStdDev,
      brierSkillScore: auditMetadata.brierSkillScore,
      calibrationSlope: Number(candidate.calibration_slope),
      calibrationIntercept: Number(candidate.calibration_intercept),
      promotedAt,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type DemotionResult = {
  versionId: string;
  market: ModelMarket;
  status: typeof DISPLACED_STATUS;
  demotedAt: string;
};

/**
 * The kill switch. One call returns a market to research-only: the next board
 * refresh finds no ACTIVE model for it and emits RESEARCH_ONLY rows.
 */
export async function demoteModelVersion(
  versionId: string,
  options: { actor?: string | null; requestId?: string | null; reason?: string | null } = {},
): Promise<DemotionResult> {
  const existing = await pool.query<{ market: string; status: string }>(
    `SELECT market::text AS market, status::text AS status FROM model_versions WHERE version_id = $1`,
    [versionId],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new ModelPromotionError("VERSION_NOT_FOUND", `Model version ${versionId} was not found.`);
  }
  if (row.status !== "ACTIVE") {
    throw new ModelPromotionError(
      "VERSION_NOT_ACTIVE",
      `Only an ACTIVE version may be demoted; this version is ${row.status}.`,
    );
  }
  const market = toShortMarketOrNull(row.market);
  if (!market) {
    throw new ModelPromotionError("UNKNOWN_MARKET", `Version market ${row.market} is not a modelled market.`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE mlb_walk_forward_validator");
    await client.query(
      `UPDATE model_versions SET status = '${DISPLACED_STATUS}'
        WHERE version_id = $1 AND status = 'ACTIVE'`,
      [versionId],
    );
    await client.query("RESET ROLE");
    await recordAuditEvent({
      actor: options.actor ?? "OPERATOR",
      requestId: options.requestId ?? null,
      action: "MODEL_VERSION_DEMOTED",
      resourceType: "model_versions",
      resourceId: versionId,
      metadata: { market, reason: options.reason ?? null, status: DISPLACED_STATUS },
    }, client);
    await client.query("COMMIT");
    return { versionId, market, status: DISPLACED_STATUS, demotedAt: new Date().toISOString() };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
