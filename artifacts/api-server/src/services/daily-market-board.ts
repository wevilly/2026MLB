import { pool } from "@workspace/db";
import { verifyModelArtifact } from "../lib/model-artifact-storage";
import { flattenNumbers } from "./model-training";

type JsonObject = Record<string, unknown>;
export type BoardMarket = "TB" | "XBH" | "WALK" | "HR";
type DbMarket = "TOTAL_BASES_2_PLUS" | "EXTRA_BASE_HIT" | "BATTER_WALK" | "HOME_RUN";

const DB_TO_MARKET: Record<DbMarket, BoardMarket> = {
  TOTAL_BASES_2_PLUS: "TB",
  EXTRA_BASE_HIT: "XBH",
  BATTER_WALK: "WALK",
  HOME_RUN: "HR",
};

const MARKET_TO_DB: Record<BoardMarket, DbMarket> = {
  TB: "TOTAL_BASES_2_PLUS",
  XBH: "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR: "HOME_RUN",
};

const MARKET_THRESHOLDS: Record<BoardMarket, number> = { TB: 2, XBH: 1, WALK: 1, HR: 1 };

type ActiveModel = {
  versionId: string;
  market: DbMarket;
  featureSetHash: string;
  algorithm: string;
  artifactKey: string;
  artifactGeneration: string;
  artifactContentHash: string;
  calibrationSlope: number;
  calibrationIntercept: number;
};

type Artifact = {
  schemaVersion: number;
  market: BoardMarket;
  algorithm: string;
  featureSetHash: string;
  featureNames: string[];
  coefficients: Record<string, number>;
  intercept: number;
};

export class DailyMarketBoardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyMarketBoardValidationError";
  }
}

function sigmoid(value: number) {
  const bounded = Math.max(-30, Math.min(30, value));
  return 1 / (1 + Math.exp(-bounded));
}

function parseArtifact(raw: string, model: ActiveModel): Artifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DailyMarketBoardValidationError("The ACTIVE model artifact is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new DailyMarketBoardValidationError("The ACTIVE model artifact has an invalid shape.");
  }
  const artifact = parsed as Partial<Artifact>;
  if (
    artifact.schemaVersion !== 1
    || artifact.market !== DB_TO_MARKET[model.market]
    || artifact.algorithm !== model.algorithm
    || artifact.featureSetHash !== model.featureSetHash
    || !Array.isArray(artifact.featureNames)
    || !artifact.coefficients
    || typeof artifact.intercept !== "number"
  ) {
    throw new DailyMarketBoardValidationError("The ACTIVE model artifact identity does not match its database version.");
  }
  return artifact as Artifact;
}

async function loadActiveModels() {
  const result = await pool.query<{
    version_id: string;
    market: DbMarket;
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
  const models = new Map<DbMarket, { model: ActiveModel; artifact: Artifact }>();
  const rejectedModels = new Map<DbMarket, ActiveModel>();
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
      models.set(model.market, { model, artifact: parseArtifact(raw, model) });
    } catch {
      // A missing, corrupt, or mismatched artifact must remain visible as a
      // rejected model context rather than being silently treated as absent.
      rejectedModels.set(model.market, model);
    }
  }
  return { models, rejectedModels };
}

function confidenceFor(
  market: BoardMarket,
  researchState: string,
  model: { model: ActiveModel; artifact: Artifact } | undefined,
  rejectedModel: ActiveModel | undefined,
  features: JsonObject | null,
) {
  if (rejectedModel) {
    return {
      modelVersionId: rejectedModel.versionId,
      modelPrediction: null,
      calibratedProbability: null,
      confidenceLabel: "NONE",
      confidenceBasis: "MODEL_REJECTED",
    } as const;
  }
  if (!model) {
    return {
      modelVersionId: null,
      modelPrediction: null,
      calibratedProbability: null,
      confidenceLabel: "NONE",
      confidenceBasis: "RESEARCH_ONLY",
    } as const;
  }
  if (!features || model.artifact.market !== market) {
    return {
      modelVersionId: model.model.versionId,
      modelPrediction: null,
      calibratedProbability: null,
      confidenceLabel: "NONE",
      confidenceBasis: "MODEL_REJECTED",
    } as const;
  }
  const vector = flattenNumbers(features);
  const prediction = model.artifact.featureNames.reduce(
    (sum, name) => sum + (model.artifact.coefficients[name] ?? 0) * (vector[name] ?? 0),
    model.artifact.intercept,
  );
  const margin = prediction - MARKET_THRESHOLDS[market];
  const probability = sigmoid(model.model.calibrationSlope * margin + model.model.calibrationIntercept);
  const confirmed = probability >= 0.55;
  const confidenceLabel = researchState === "STRONG" && probability >= 0.65
    ? "FIRE"
    : confirmed && ["STRONG", "POSITIVE"].includes(researchState)
      ? "HALF"
      : "HOLD";
  return {
    modelVersionId: model.model.versionId,
    modelPrediction: Number(prediction.toFixed(6)),
    calibratedProbability: Number(probability.toFixed(6)),
    confidenceLabel,
    confidenceBasis: confirmed ? "MODEL_CONFIRMED" : "MODEL_REJECTED",
  } as const;
}

export async function populateDailyMarketBoard(slateDate: string, market: BoardMarket | null = null) {
  const dbMarket = market ? MARKET_TO_DB[market] : null;
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
        AND mrc.research_state <> 'BLOCKED'
      ORDER BY mrc.market, mrc.research_rank ASC NULLS LAST, mrc.player_id`,
    [slateDate, dbMarket],
    );
    // Reconcile the materialized board with the current research universe before
    // upserting. A removed scratch/candidate cannot remain visible after refresh.
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
          )`,
      [slateDate, dbMarket],
    );
    let modeledRows = 0;
    for (const candidate of candidates.rows) {
      const marketCode = DB_TO_MARKET[candidate.market];
      const confidence = confidenceFor(
        marketCode,
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
          calibrated_probability, board_frozen_at)
       VALUES ($1, $2, $3, $4, $5, $6::research_state, $7, $8, $9, $10, $11::confidence_label,
               $12::confidence_basis, $13, now())
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
         board_frozen_at = EXCLUDED.board_frozen_at,
         updated_at = now()`,
      [
        slateDate, candidate.game_pk, candidate.player_id, candidate.market, candidate.research_rank,
        candidate.research_state, candidate.primary_mechanism, candidate.snapshot_id,
        confidence.modelVersionId, confidence.modelPrediction, confidence.confidenceLabel,
        confidence.confidenceBasis, confidence.calibratedProbability,
      ],
      );
    }
    await client.query("COMMIT");
    return {
      slateDate,
      market,
      candidatesFound: candidates.rows.length,
      modeledRows,
      researchOnlyRows: candidates.rows.length - modeledRows,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryDailyMarketBoard(slateDate: string, market: BoardMarket | null = null) {
  const dbMarket = market ? MARKET_TO_DB[market] : null;
  const result = await pool.query<{
    board_id: string; slate_date: string; game_pk: number; player_id: number; player_name: string;
    market: DbMarket; research_rank: number | null; research_state: string; primary_mechanism: string | null;
    model_prediction: string | null; confidence_label: string; confidence_basis: string;
    calibrated_probability: string | null; model_version_id: string | null; board_frozen_at: string;
  }>(
    `SELECT dmb.board_id, dmb.slate_date::text, dmb.game_pk::bigint, dmb.player_id,
            COALESCE(p.full_name, 'Unknown') AS player_name, dmb.market, dmb.research_rank,
            dmb.research_state, dmb.primary_mechanism, dmb.model_prediction, dmb.confidence_label,
            dmb.confidence_basis, dmb.calibrated_probability, dmb.model_version_id,
            dmb.board_frozen_at::text
       FROM daily_market_board dmb
       JOIN players p ON p.player_id = dmb.player_id
      WHERE dmb.slate_date = $1
        AND ($2::market_type IS NULL OR dmb.market = $2::market_type)
      ORDER BY dmb.market,
        CASE dmb.confidence_label WHEN 'FIRE' THEN 1 WHEN 'HALF' THEN 2 WHEN 'HOLD' THEN 3 ELSE 4 END,
        dmb.research_rank ASC NULLS LAST, player_name`,
    [slateDate, dbMarket],
  );
  return result.rows.map((row) => ({
    boardId: row.board_id,
    slateDate: row.slate_date,
    gamePk: Number(row.game_pk),
    playerId: row.player_id,
    playerName: row.player_name,
    market: DB_TO_MARKET[row.market],
    researchRank: row.research_rank,
    researchState: row.research_state,
    primaryMechanism: row.primary_mechanism,
    modelPrediction: row.model_prediction === null ? null : Number(row.model_prediction),
    confidenceLabel: row.confidence_label,
    confidenceBasis: row.confidence_basis,
    calibratedProbability: row.calibrated_probability === null ? null : Number(row.calibrated_probability),
    modelVersionId: row.model_version_id,
    boardFrozenAt: row.board_frozen_at,
  }));
}

export async function queryDailyBoardGameSummary(slateDate: string) {
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
  const entries = await queryDailyMarketBoard(slateDate);
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
        if (!byMarket[entry.market]) byMarket[entry.market] = entry;
        return byMarket;
      }, {}),
  }));
}