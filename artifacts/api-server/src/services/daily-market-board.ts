import { pool } from "@workspace/db";
import { verifyModelArtifact } from "../lib/model-artifact-storage";
import {
  DB_TO_MARKET,
  HRRBI_DB_MARKET,
  MARKET_TO_DB,
  type DbModelMarket,
  type ModelMarket,
} from "./market-codes";
import {
  MIN_FEATURE_COVERAGE,
  MODEL_CONFIRMATION_THRESHOLD,
  MODEL_FIRE_THRESHOLD,
  applyCalibration,
  parseModelArtifact,
  scoreArtifact,
  trainableVector,
  type ModelArtifact,
} from "./model-math";

type JsonObject = Record<string, unknown>;
export type BoardMarket = ModelMarket | "H_R_RBI";
type DbMarket = DbModelMarket | typeof HRRBI_DB_MARKET;

/**
 * Research states that must never appear on the materialized board.
 *
 * The predicate lives here, once, and is used by both the candidate SELECT and
 * the reconcile DELETE in populateDailyMarketBoard. Writing it twice is what
 * let a BLOCKED candidate keep its board row: the SELECT excluded it while the
 * DELETE still found a matching candidate row and spared the board row.
 */
export const BOARD_EXCLUDED_RESEARCH_STATES = ["BLOCKED"] as const;

const EXCLUDED_RESEARCH_STATES_SQL = BOARD_EXCLUDED_RESEARCH_STATES
  .map((state) => `'${state}'`)
  .join(", ");

type ActiveModel = {
  versionId: string;
  market: DbModelMarket;
  featureSetHash: string;
  algorithm: string;
  artifactKey: string;
  artifactGeneration: string;
  artifactContentHash: string;
  calibrationSlope: number;
  calibrationIntercept: number;
};

export class DailyMarketBoardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyMarketBoardValidationError";
  }
}

async function loadActiveModels() {
  const result = await pool.query<{
    version_id: string;
    market: DbModelMarket;
    feature_set_hash: string;
    algorithm: string;
    artifact_key: string;
    artifact_generation: string;
    artifact_content_hash: string;
    calibration_slope: string | null;
    calibration_intercept: string | null;
  }>(
    `SELECT DISTINCT ON (market)
       version_id, market, feature_set_hash, algorithm, artifact_key, artifact_generation,
       artifact_content_hash, calibration_slope, calibration_intercept
     FROM model_versions
     WHERE status = 'ACTIVE'
       AND walk_forward_acceptance_id IS NOT NULL
       AND calibration_slope IS NOT NULL
       AND calibration_intercept IS NOT NULL
     ORDER BY market, trained_at DESC`,
  );
  const models = new Map<DbModelMarket, { model: ActiveModel; artifact: ModelArtifact }>();
  const rejectedModels = new Map<DbModelMarket, ActiveModel>();
  for (const row of result.rows) {
    const model: ActiveModel = {
      versionId: row.version_id,
      market: row.market,
      featureSetHash: row.feature_set_hash,
      algorithm: row.algorithm,
      artifactKey: row.artifact_key,
      artifactGeneration: row.artifact_generation,
      artifactContentHash: row.artifact_content_hash,
      calibrationSlope: Number(row.calibration_slope),
      calibrationIntercept: Number(row.calibration_intercept),
    };
    try {
      const raw = await verifyModelArtifact(model.artifactKey, model.artifactGeneration, model.artifactContentHash);
      const artifact = parseModelArtifact(raw, {
        market: DB_TO_MARKET[model.market],
        algorithm: model.algorithm,
        featureSetHash: model.featureSetHash,
      });
      models.set(model.market, { model, artifact });
    } catch {
      // A missing, corrupt, or mismatched artifact must remain visible as an
      // invalid model context rather than being silently treated as absent.
      rejectedModels.set(model.market, model);
    }
  }
  return { models, rejectedModels };
}

export type BoardConfidence = {
  modelVersionId: string | null;
  modelPrediction: number | null;
  calibratedProbability: number | null;
  confidenceLabel: "FIRE" | "HALF" | "HOLD" | "NONE";
  confidenceBasis:
    | "RESEARCH_ONLY"
    | "MODEL_CONFIRMED"
    | "MODEL_DECLINED"
    | "ARTIFACT_INVALID"
    | "MARKET_MISMATCH"
    | "INSUFFICIENT_FEATURES";
  featureCoverage: number | null;
  imputedFeatures: string[];
  unknownFeatures: string[];
};

/**
 * Decides what the board may say about a candidate.
 *
 * Every branch that used to collapse into MODEL_REJECTED now has its own
 * value. A corrupt artifact, a market mismatch, a partial feature vector and a
 * model that ran and returned a low probability are four different facts, and
 * an operator cannot act on the fourth if it is indistinguishable from the
 * first.
 *
 * The scoring and calibration arithmetic is imported, not written here. The
 * walk-forward validator calls the same two functions on the same artifact, so
 * the probability measured during validation is the probability served.
 */
export function confidenceFor(
  market: BoardMarket,
  researchState: string,
  model: { model: ActiveModel; artifact: ModelArtifact } | undefined,
  rejectedModel: ActiveModel | undefined,
  features: JsonObject | null,
): BoardConfidence {
  const empty = {
    modelPrediction: null,
    calibratedProbability: null,
    confidenceLabel: "NONE" as const,
    featureCoverage: null,
    imputedFeatures: [],
    unknownFeatures: [],
  };
  if (rejectedModel) {
    return { ...empty, modelVersionId: rejectedModel.versionId, confidenceBasis: "ARTIFACT_INVALID" };
  }
  if (!model) {
    return { ...empty, modelVersionId: null, confidenceBasis: "RESEARCH_ONLY" };
  }
  if (model.artifact.market !== market) {
    return { ...empty, modelVersionId: model.model.versionId, confidenceBasis: "MARKET_MISMATCH" };
  }
  if (!features) {
    return {
      ...empty,
      modelVersionId: model.model.versionId,
      confidenceBasis: "INSUFFICIENT_FEATURES",
      featureCoverage: 0,
      imputedFeatures: [...model.artifact.featureNames],
    };
  }

  const vector = trainableVector(features);
  const score = scoreArtifact(model.artifact, vector);
  if (score.coverage < MIN_FEATURE_COVERAGE) {
    // Below the coverage floor the probability would be produced mostly from
    // imputed training means. That is not a model output and is not labelled
    // as one.
    return {
      modelVersionId: model.model.versionId,
      modelPrediction: null,
      calibratedProbability: null,
      confidenceLabel: "NONE",
      confidenceBasis: "INSUFFICIENT_FEATURES",
      featureCoverage: Number(score.coverage.toFixed(6)),
      imputedFeatures: score.imputedFeatures,
      unknownFeatures: score.unknownFeatures,
    };
  }

  const probability = applyCalibration(
    score.rawScore,
    model.model.calibrationSlope,
    model.model.calibrationIntercept,
  );
  const confirmed = probability >= MODEL_CONFIRMATION_THRESHOLD;
  const confidenceLabel = researchState === "STRONG" && probability >= MODEL_FIRE_THRESHOLD
    ? "FIRE"
    : confirmed && ["STRONG", "POSITIVE"].includes(researchState)
      ? "HALF"
      : "HOLD";
  return {
    modelVersionId: model.model.versionId,
    modelPrediction: Number(score.rawScore.toFixed(6)),
    calibratedProbability: Number(probability.toFixed(6)),
    confidenceLabel,
    // The model ran. A probability below the confirmation threshold is the
    // model declining, not the model being rejected.
    confidenceBasis: confirmed ? "MODEL_CONFIRMED" : "MODEL_DECLINED",
    featureCoverage: Number(score.coverage.toFixed(6)),
    imputedFeatures: score.imputedFeatures,
    unknownFeatures: score.unknownFeatures,
  };
}

export async function populateDailyMarketBoard(slateDate: string, market: BoardMarket | null = null) {
  const dbMarket = market
    ? market === "H_R_RBI" ? HRRBI_DB_MARKET : MARKET_TO_DB[market]
    : null;
  const activeModels = await loadActiveModels();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidates = await client.query<{
    game_pk: number;
    player_id: number;
    market: DbMarket;
    research_rank: number | null;
    research_state: string;
    primary_mechanism: string | null;
    snapshot_id: string | null;
    features: JsonObject | null;
    }>(
    `SELECT mrc.game_pk::bigint, mrc.player_id, mrc.market, mrc.research_rank, mrc.research_state,
            mrc.primary_mechanism, pfs.snapshot_id, pfs.features
       FROM market_research_candidates mrc
       LEFT JOIN LATERAL (
         SELECT snapshot_id, features
           FROM pregame_feature_snapshots pfs
          WHERE pfs.player_id = mrc.player_id
            AND pfs.game_pk = mrc.game_pk
            AND pfs.slate_date = mrc.slate_date
            AND pfs.market = mrc.market
            AND NOT EXISTS (
              SELECT 1 FROM pregame_feature_snapshots correction
               WHERE correction.correction_of = pfs.snapshot_id
            )
          ORDER BY pfs.created_at DESC
          LIMIT 1
       ) pfs ON true
      WHERE mrc.slate_date = $1
        AND ($2::market_type IS NULL OR mrc.market = $2::market_type)
        AND mrc.research_state NOT IN (${EXCLUDED_RESEARCH_STATES_SQL})
      ORDER BY mrc.market, mrc.research_rank ASC NULLS LAST, mrc.player_id`,
    [slateDate, dbMarket],
    );
    // Reconcile the materialized board with the current research universe before
    // upserting. A removed candidate cannot remain visible after refresh, and
    // neither can one whose research state has moved into an excluded state.
    //
    // The NOT EXISTS subquery repeats the SELECT's state predicate through the
    // same constant. Before that, a BLOCKED candidate still satisfied the
    // EXISTS check and kept its board row alive forever: detectLateScratches
    // set the state and called this function expecting the row to disappear,
    // and it did not.
    await client.query(
      `DELETE FROM daily_market_board dmb
        WHERE dmb.slate_date = $1
          AND ($2::market_type IS NULL OR dmb.market = $2::market_type)
          AND NOT EXISTS (
            SELECT 1 FROM market_research_candidates mrc
             WHERE mrc.slate_date = dmb.slate_date
               AND mrc.market = dmb.market
               AND mrc.player_id = dmb.player_id
               AND mrc.game_pk = dmb.game_pk
               AND mrc.research_state NOT IN (${EXCLUDED_RESEARCH_STATES_SQL})
          )`,
      [slateDate, dbMarket],
    );
    let modeledRows = 0;
    for (const candidate of candidates.rows) {
      const confidence = candidate.market === HRRBI_DB_MARKET
        ? {
          modelVersionId: null,
          modelPrediction: null,
          calibratedProbability: null,
          confidenceLabel: "NONE" as const,
          confidenceBasis: "RESEARCH_ONLY" as const,
          featureCoverage: null,
          imputedFeatures: [] as string[],
          unknownFeatures: [] as string[],
        }
        : confidenceFor(
          DB_TO_MARKET[candidate.market],
          candidate.research_state,
          activeModels.models.get(candidate.market),
          activeModels.rejectedModels.get(candidate.market),
          candidate.features,
        );
      if (confidence.calibratedProbability !== null) modeledRows += 1;
      await client.query(
      `INSERT INTO daily_market_board
         (slate_date, game_pk, player_id, market, research_rank, research_state, primary_mechanism,
          snapshot_id, model_version_id, model_prediction, confidence_label, confidence_basis,
          calibrated_probability, feature_coverage, imputed_features, unknown_features, board_frozen_at)
       VALUES ($1, $2, $3, $4, $5, $6::research_state, $7, $8, $9, $10, $11::confidence_label,
               $12::confidence_basis, $13, $14, $15, $16, now())
       ON CONFLICT (slate_date, market, player_id, game_pk) DO UPDATE SET
         research_rank = EXCLUDED.research_rank,
         research_state = EXCLUDED.research_state,
         primary_mechanism = EXCLUDED.primary_mechanism,
         snapshot_id = EXCLUDED.snapshot_id,
         model_version_id = EXCLUDED.model_version_id,
         model_prediction = EXCLUDED.model_prediction,
         confidence_label = EXCLUDED.confidence_label,
         confidence_basis = EXCLUDED.confidence_basis,
         calibrated_probability = EXCLUDED.calibrated_probability,
         feature_coverage = EXCLUDED.feature_coverage,
         imputed_features = EXCLUDED.imputed_features,
         unknown_features = EXCLUDED.unknown_features,
         board_frozen_at = EXCLUDED.board_frozen_at,
         updated_at = now()`,
      [
        slateDate, candidate.game_pk, candidate.player_id, candidate.market, candidate.research_rank,
        candidate.research_state, candidate.primary_mechanism, candidate.snapshot_id,
        confidence.modelVersionId, confidence.modelPrediction, confidence.confidenceLabel,
        confidence.confidenceBasis, confidence.calibratedProbability,
        confidence.featureCoverage,
        JSON.stringify(confidence.imputedFeatures),
        JSON.stringify(confidence.unknownFeatures),
      ],
      );
    }
    // Post-refresh invariant. The set of (player_id, game_pk, market) on the
    // board must be exactly the set of non-excluded candidates for the slate.
    // Anything else means the SELECT and the reconcile DELETE have drifted
    // again, and a refresh that leaves a stale row is worse than a refresh
    // that fails.
    const invariant = await client.query<{ orphaned: string; missing: string }>(
      `WITH expected AS (
         SELECT mrc.player_id, mrc.game_pk, mrc.market
           FROM market_research_candidates mrc
          WHERE mrc.slate_date = $1
            AND ($2::market_type IS NULL OR mrc.market = $2::market_type)
            AND mrc.research_state NOT IN (${EXCLUDED_RESEARCH_STATES_SQL})
       ),
       actual AS (
         SELECT dmb.player_id, dmb.game_pk, dmb.market
           FROM daily_market_board dmb
          WHERE dmb.slate_date = $1
            AND ($2::market_type IS NULL OR dmb.market = $2::market_type)
       )
       SELECT
         (SELECT count(*)::text FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected) o) AS orphaned,
         (SELECT count(*)::text FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual) m) AS missing`,
      [slateDate, dbMarket],
    );
    const orphaned = Number(invariant.rows[0]?.orphaned ?? 0);
    const missing = Number(invariant.rows[0]?.missing ?? 0);
    if (orphaned || missing) {
      throw new DailyMarketBoardValidationError(
        `Daily market board refresh for ${slateDate} left ${orphaned} board row(s) with no eligible `
        + `candidate and ${missing} eligible candidate(s) with no board row.`,
      );
    }

    await client.query("COMMIT");
    return {
      slateDate,
      market,
      candidatesFound: candidates.rows.length,
      modeledRows,
      researchOnlyRows: candidates.rows.length - modeledRows,
      boardRowsOrphaned: orphaned,
      candidatesMissingBoardRow: missing,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryDailyMarketBoard(slateDate: string, market: BoardMarket | null = null) {
  const dbMarket = market
    ? market === "H_R_RBI" ? HRRBI_DB_MARKET : MARKET_TO_DB[market]
    : null;
  const result = await pool.query<{
    candidate_id: string; slate_date: string; game_pk: number; player_id: number; player_name: string;
    market: DbMarket; research_rank: number | null; research_state: string; primary_mechanism: string | null;
    counter_evidence: unknown; starter_matchup_evidence: unknown; bullpen_path_evidence: unknown; park_evidence: unknown;
    reference_rank: number | null; reference_projected_value: string | null; reference_retrieved_at: string | null;
  }>(
    `SELECT mrc.candidate_id, mrc.slate_date::text, mrc.game_pk::bigint, mrc.player_id,
            COALESCE(p.full_name, 'Unknown') AS player_name, mrc.market, mrc.research_rank,
            mrc.research_state, mrc.primary_mechanism, mrc.counter_evidence,
            mrc.starter_matchup_evidence, mrc.bullpen_path_evidence, mrc.park_evidence,
            fp.reference_rank, fp.projected_value::text AS reference_projected_value,
            fp.snapshot_retrieved_at::text AS reference_retrieved_at
       FROM market_research_candidates mrc
       JOIN players p ON p.player_id = mrc.player_id
       LEFT JOIN LATERAL (
         SELECT reference_rank, projected_value, snapshot_retrieved_at
           FROM fantasypros_reference_ranks
          WHERE slate_date = mrc.slate_date
            AND game_pk = mrc.game_pk
            AND player_id = mrc.player_id
            AND market = mrc.market
          ORDER BY snapshot_retrieved_at DESC, created_at DESC
          LIMIT 1
       ) fp ON true
      WHERE mrc.slate_date = $1
        AND ($2::market_type IS NULL OR mrc.market = $2::market_type)
       ORDER BY mrc.market, mrc.research_rank ASC NULLS LAST, player_name`,
    [slateDate, dbMarket],
  );
  return result.rows.map((row) => ({
    boardId: row.candidate_id,
    slateDate: row.slate_date,
    gamePk: Number(row.game_pk),
    playerId: row.player_id,
    playerName: row.player_name,
    market: row.market === HRRBI_DB_MARKET ? "H_R_RBI" : DB_TO_MARKET[row.market],
    researchRank: row.research_rank,
    researchState: row.research_state,
    primaryMechanism: row.primary_mechanism,
    referenceRank: row.reference_rank,
    referenceProjectedValue: row.reference_projected_value === null ? null : Number(row.reference_projected_value),
    referenceRetrievedAt: row.reference_retrieved_at,
    referenceComparison: row.reference_rank === null || row.research_rank === null
      ? "NOT_AVAILABLE"
      : row.reference_rank === row.research_rank ? "AGREE" : "DISAGREE",
    evidenceStatus: row.research_state === "BLOCKED"
      ? "BLOCKED"
      : row.reference_rank === null || !row.starter_matchup_evidence || !row.bullpen_path_evidence || !row.park_evidence
        ? "PARTIAL"
        : "READY",
    decisionStatus: row.research_state === "BLOCKED" || row.research_rank === null ? "BLOCKED" : "PASS",
    counterEvidence: row.counter_evidence && typeof row.counter_evidence === "object" ? row.counter_evidence : {},
    starterMatchupEvidence: row.starter_matchup_evidence && typeof row.starter_matchup_evidence === "object" ? row.starter_matchup_evidence : {},
    bullpenPathEvidence: row.bullpen_path_evidence && typeof row.bullpen_path_evidence === "object" ? row.bullpen_path_evidence : {},
    parkEvidence: row.park_evidence && typeof row.park_evidence === "object" ? row.park_evidence : {},
  }));
}

export async function queryDailyBoardGameSummary(
  slateDate: string,
  presentationEntries?: Awaited<ReturnType<typeof queryDailyMarketBoard>>,
) {
  const games = await pool.query<{
    game_pk: number; away_team: string; home_team: string; start_time_utc: string | null; park: string | null;
    away_starter: string | null; home_starter: string | null; away_starter_state: string | null; home_starter_state: string | null;
    away_available: number; home_available: number;
  }>(
    `SELECT g.game_pk::bigint, away.abbreviation AS away_team, home.abbreviation AS home_team,
            g.start_time_utc::text, v.name AS park,
            away_starter.full_name AS away_starter, home_starter.full_name AS home_starter,
            away_starter.starter_state AS away_starter_state, home_starter.starter_state AS home_starter_state,
            COALESCE(away_bullpen.available_arms, 0)::int AS away_available,
            COALESCE(home_bullpen.available_arms, 0)::int AS home_available
       FROM games g
       JOIN teams away ON away.team_id = g.away_team_id
       JOIN teams home ON home.team_id = g.home_team_id
       LEFT JOIN venues v ON v.venue_id = g.venue_id
       LEFT JOIN LATERAL (
         SELECT p.full_name, s.starter_state FROM starters s LEFT JOIN players p ON p.player_id = s.player_id
          WHERE s.game_pk = g.game_pk AND s.team_id = g.away_team_id ORDER BY s.observed_at DESC LIMIT 1
       ) away_starter ON true
       LEFT JOIN LATERAL (
         SELECT p.full_name, s.starter_state FROM starters s LEFT JOIN players p ON p.player_id = s.player_id
          WHERE s.game_pk = g.game_pk AND s.team_id = g.home_team_id ORDER BY s.observed_at DESC LIMIT 1
       ) home_starter ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE final_state IN ('AVAILABLE', 'LIKELY_AVAILABLE')) AS available_arms
           FROM bullpen_availability_observations WHERE team_id = g.away_team_id AND slate_date = $1
       ) away_bullpen ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE final_state IN ('AVAILABLE', 'LIKELY_AVAILABLE')) AS available_arms
           FROM bullpen_availability_observations WHERE team_id = g.home_team_id AND slate_date = $1
       ) home_bullpen ON true
      WHERE g.game_date = $1
        AND EXISTS (SELECT 1 FROM daily_market_board dmb WHERE dmb.slate_date = $1 AND dmb.game_pk = g.game_pk)
      ORDER BY g.start_time_utc NULLS LAST`,
    [slateDate],
  );
  const entries = presentationEntries ?? await queryDailyMarketBoard(slateDate);
  return games.rows.map((game) => ({
    gamePk: Number(game.game_pk),
    awayTeam: game.away_team,
    homeTeam: game.home_team,
    startTimeUtc: game.start_time_utc,
    park: game.park,
    awayStarter: { name: game.away_starter ?? "TBD", state: game.away_starter_state ?? "TBD" },
    homeStarter: { name: game.home_starter ?? "TBD", state: game.home_starter_state ?? "TBD" },
    bullpenContext: { awayAvailableArms: game.away_available, homeAvailableArms: game.home_available },
    topCandidates: entries
      .filter((entry) => entry.gamePk === Number(game.game_pk))
      .reduce<Partial<Record<BoardMarket, typeof entries[number]>>>((byMarket, entry) => {
        const market = entry.market as BoardMarket;
        if (!byMarket[market]) byMarket[market] = entry;
        return byMarket;
      }, {}),
  }));
}