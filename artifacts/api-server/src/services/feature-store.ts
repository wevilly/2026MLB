/**
 * Phase 4A – Historical Pregame Feature Store
 *
 * Captures immutable pregame feature snapshots for each player-market-game-date.
 * Implements the correction protocol (new row with correction_of + taxonomy reason).
 * Provides historical backfill from existing market research candidates.
 *
 * IMMUTABILITY CONTRACT: This service NEVER issues UPDATE or DELETE against
 * pregame_feature_snapshots or historical_outcomes. Corrections create new rows.
 *
 * PROHIBITED: No odds, EV, CLV, implied probability, or sportsbook data is
 * captured, stored, or returned from this service.
 */

import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { PREGAME_LINEUP_SOURCE_PRECEDENCE, lineupSourceFilter } from "./lineup-sources";
// The prohibited-betting vocabulary is shared with bettor-intelligence, which
// audit S3 found was applying no such check at all. See betting-content-guard.
import { prohibitedBettingTerm } from "./betting-content-guard";

type JsonObject = Record<string, unknown>;

// ── No-betting-data validation ───────────────────────────────────────────────

/**
 * Immutable feature-store rows are model-training evidence, not betting records.
 * This error is deliberately exported so the HTTP boundary can return a precise
 * 400 rather than allowing a prohibited field to reach an irreversible INSERT.
 */
export class FeatureStoreValidationError extends Error {}

const FEATURE_VECTOR_KEYS = new Set([
  "market",
  "slateDate",
  "playerId",
  "gamePk",
  "candidateId",
  "researchRank",
  "researchState",
  "primaryMechanism",
  "secondaryMechanism",
  "opportunityEvidence",
  "starterMatchupEvidence",
  "bullpenPathEvidence",
  "parkEvidence",
  "recentVsSeasonVsCareer",
  "counterEvidence",
  "hitterFeatures",
  "pitcherFeatures",
  "parkFeatures",
]);
const PREGAME_LINEUP_FILTER = lineupSourceFilter(PREGAME_LINEUP_SOURCE_PRECEDENCE);

const REQUIRED_FEATURE_VECTOR_KEYS = [
  "market",
  "slateDate",
  "playerId",
  "gamePk",
  "candidateId",
  "researchRank",
  "researchState",
  "primaryMechanism",
  "secondaryMechanism",
  "opportunityEvidence",
  "starterMatchupEvidence",
  "bullpenPathEvidence",
  "parkEvidence",
  "recentVsSeasonVsCareer",
  "counterEvidence",
  "hitterFeatures",
  "pitcherFeatures",
  "parkFeatures",
] as const;

function isPlainJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedDateOnly(value: string | Date): string {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new FeatureStoreValidationError("Feature vector slateDate must use YYYY-MM-DD");
  }
  return date;
}

function assertNoBettingData(value: unknown, path: string, depth = 0): void {
  if (depth > 20) {
    throw new FeatureStoreValidationError(`Feature payload exceeds the maximum nesting depth at ${path}`);
  }
  if (typeof value === "string") {
    const prohibited = prohibitedBettingTerm(value);
    if (prohibited) {
      throw new FeatureStoreValidationError(
        `Feature payload contains prohibited betting data at ${path} (${prohibited})`,
      );
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FeatureStoreValidationError(`Feature payload contains a non-finite number at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoBettingData(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainJsonObject(value)) {
    throw new FeatureStoreValidationError(`Feature payload contains a non-JSON value at ${path}`);
  }
  for (const [key, child] of Object.entries(value)) {
    const prohibited = prohibitedBettingTerm(key);
    if (prohibited) {
      throw new FeatureStoreValidationError(
        `Feature payload contains prohibited betting key "${key}" at ${path}`,
      );
    }
    assertNoBettingData(child, `${path}.${key}`, depth + 1);
  }
}

function assertMetricMap(value: unknown, key: string): void {
  if (!isPlainJsonObject(value)) {
    throw new FeatureStoreValidationError(`${key} must be an object of numeric or null metrics`);
  }
  for (const [metricKey, metricValue] of Object.entries(value)) {
    const prohibited = prohibitedBettingTerm(metricKey);
    if (prohibited) {
      throw new FeatureStoreValidationError(`${key} contains prohibited betting key "${metricKey}"`);
    }
    if (metricValue !== null && (typeof metricValue !== "number" || !Number.isFinite(metricValue))) {
      throw new FeatureStoreValidationError(`${key}.${metricKey} must be a finite number or null`);
    }
  }
}

/**
 * Validates the complete feature-vector schema and recursively rejects betting
 * data in both field names and string values. It is called before every
 * pregame_feature_snapshots INSERT, including automated slate capture and
 * human corrections, because rows become immutable once written.
 */
export function assertFeatureVectorSafe(features: unknown): asserts features is JsonObject {
  if (!isPlainJsonObject(features)) {
    throw new FeatureStoreValidationError("updatedFeatures must be a JSON object");
  }

  for (const key of REQUIRED_FEATURE_VECTOR_KEYS) {
    if (!(key in features)) {
      throw new FeatureStoreValidationError(`Feature vector is missing required key "${key}"`);
    }
  }
  for (const key of Object.keys(features)) {
    if (!FEATURE_VECTOR_KEYS.has(key)) {
      throw new FeatureStoreValidationError(`Feature vector contains unsupported key "${key}"`);
    }
  }

  if (!["TB", "XBH", "WALK", "HR"].includes(String(features.market))) {
    throw new FeatureStoreValidationError("Feature vector market must be TB, XBH, WALK, or HR");
  }
  if (typeof features.slateDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(features.slateDate)) {
    throw new FeatureStoreValidationError("Feature vector slateDate must use YYYY-MM-DD");
  }
  for (const idKey of ["playerId", "gamePk"] as const) {
    if (!Number.isSafeInteger(features[idKey]) || Number(features[idKey]) <= 0) {
      throw new FeatureStoreValidationError(`Feature vector ${idKey} must be a positive integer`);
    }
  }
  if (typeof features.candidateId !== "string" || features.candidateId.length === 0) {
    throw new FeatureStoreValidationError("Feature vector candidateId must be a non-empty string");
  }
  if (features.researchRank !== null && (typeof features.researchRank !== "number" || !Number.isFinite(features.researchRank))) {
    throw new FeatureStoreValidationError("Feature vector researchRank must be a finite number or null");
  }
  for (const key of ["researchState", "primaryMechanism", "secondaryMechanism"] as const) {
    if (features[key] !== null && typeof features[key] !== "string") {
      throw new FeatureStoreValidationError(`Feature vector ${key} must be a string or null`);
    }
  }
  for (const key of [
    "opportunityEvidence",
    "starterMatchupEvidence",
    "bullpenPathEvidence",
    "parkEvidence",
    "recentVsSeasonVsCareer",
    "counterEvidence",
  ] as const) {
    if (!isPlainJsonObject(features[key])) {
      throw new FeatureStoreValidationError(`Feature vector ${key} must be an object`);
    }
  }
  assertMetricMap(features.hitterFeatures, "hitterFeatures");
  assertMetricMap(features.pitcherFeatures, "pitcherFeatures");
  assertMetricMap(features.parkFeatures, "parkFeatures");
  assertNoBettingData(features, "features");
}

// ── Taxonomy ──────────────────────────────────────────────────────────────────

export const CORRECTION_REASONS = [
  "LATE_SCRATCH",
  "LINEUP_ERROR",
  "DATA_INGEST_FAILURE",
  "IDENTITY_ERROR",
  "SOURCE_UNAVAILABLE",
  "HUMAN_CORRECTION",
] as const;
export type CorrectionReason = typeof CORRECTION_REASONS[number];

const MARKET_DB_VALUES: Record<string, string> = {
  TB:   "TOTAL_BASES_2_PLUS",
  XBH:  "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR:   "HOME_RUN",
};

function marketToDb(market: string): string {
  return MARKET_DB_VALUES[market] ?? market;
}

function dbToMarketShort(dbMarket: string): "TB" | "XBH" | "WALK" | "HR" {
  const m: Record<string, "TB" | "XBH" | "WALK" | "HR"> = {
    TOTAL_BASES_2_PLUS: "TB",
    EXTRA_BASE_HIT:     "XBH",
    BATTER_WALK:        "WALK",
    HOME_RUN:           "HR",
  };
  return m[dbMarket] ?? (dbMarket as "TB");
}

/**
 * Produces a deterministic SHA-256 hash of the feature vector.
 *
 * JSON.stringify preserves insertion order; if the same set of metrics arrives
 * in different row-orders across captures (due to planner non-determinism), the
 * resulting JSON strings — and therefore hashes — would differ for identical
 * feature sets. canonicalJson sorts all object keys recursively so the hash is
 * stable regardless of row-return order.
 */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function featureHash(features: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(features))).digest("hex");
}

// ── Source registry ───────────────────────────────────────────────────────────

async function ensureFeatureStoreSource() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, notes)
     VALUES ('FEATURE_STORE', 'Pregame Feature Store', 'RESEARCH',
             'Phase 4A: Immutable pregame feature snapshots captured at slate-freeze time.')
     ON CONFLICT (source_id) DO NOTHING`,
  );
}

// ── Ingest run helpers ────────────────────────────────────────────────────────

async function startRun(jobName: string, effectiveDate: string): Promise<string> {
  const r = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ('FEATURE_STORE', $1, 'RUNNING', $2) RETURNING ingest_run_id`,
    [jobName, effectiveDate],
  );
  return r.rows[0].ingest_run_id;
}

async function finishRun(
  ingestRunId: string,
  status: "SUCCESS" | "PARTIAL" | "FAILED",
  counts: { rows: number; normalized: number; rejected: number; error?: string },
  started: number,
) {
  await pool.query(
    `UPDATE ingest_runs SET finished_at = now(), status = $2, row_count = $3,
       normalized_row_count = $4, rejected_row_count = $5, duration_ms = $6, error_message = $7
     WHERE ingest_run_id = $1`,
    [ingestRunId, status, counts.rows, counts.normalized, counts.rejected,
     Date.now() - started, counts.error ?? null],
  );
}

// ── Feature vector builder ────────────────────────────────────────────────────

/**
 * Builds the feature vector for a player-market pair from:
 *   - The current market_research_candidates row (rank, state, mechanism)
 *   - The player's current season research features (Statcast)
 *   - The opponent pitcher's research features
 *   - The park research features (for HR market)
 */
async function buildFeatureVector(
  candidateId: string,
  playerId: number,
  gamePk: number,
  market: string,
  slateDate: string,
): Promise<JsonObject> {
  // Read the market research candidate for context
  const candidateRes = await pool.query<{
    research_rank: number | null;
    research_state: string | null;
    primary_mechanism: string | null;
    secondary_mechanism: string | null;
    opportunity_evidence: JsonObject;
    starter_matchup_evidence: JsonObject;
    bullpen_path_evidence: JsonObject;
    park_evidence: JsonObject;
    recent_vs_season_vs_career: JsonObject;
    counter_evidence: JsonObject;
  }>(
    `SELECT research_rank, research_state, primary_mechanism, secondary_mechanism,
            opportunity_evidence, starter_matchup_evidence, bullpen_path_evidence,
            park_evidence, recent_vs_season_vs_career, counter_evidence
     FROM market_research_candidates WHERE candidate_id = $1`,
    [candidateId],
  );
  const candidate = candidateRes.rows[0];

  // Read player's season features from exactly ONE snapshot: the most-recently
  // retrieved snapshot whose effective_to is at or before the slate date.
  //
  // Pinning to a single snapshot is essential. If we joined all matching
  // snapshots and relied on ORDER BY + LIMIT to filter, older rows for the
  // same (family, metric_key, pitcher_side) key would silently overwrite
  // newer rows during flattening, producing a mixed-vintage feature vector.
  const hitterRes = await pool.query<{
    metric_key: string; value: string | null; pitcher_side: string | null; family: string;
  }>(
    `SELECT f.metric_key, f.value, f.pitcher_side, f.family
     FROM player_research_features f
     JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
     WHERE s.research_snapshot_id = (
       SELECT research_snapshot_id
       FROM player_research_snapshots
       WHERE player_id = $1
         AND effective_to <= $2
         AND research_window = 'SEASON'
       ORDER BY retrieved_at DESC
       LIMIT 1
     )
     ORDER BY f.family, f.metric_key, f.pitcher_side NULLS LAST`,
    [playerId, slateDate],
  );

  // Flatten hitter features into a nested map by family → metric_key → {all, L, R}
  const hitterFeatures: JsonObject = {};
  for (const row of hitterRes.rows) {
    const side = row.pitcher_side ?? "all";
    const key = `${row.family}.${row.metric_key}.${side}`;
    hitterFeatures[key] = row.value !== null ? Number(row.value) : null;
  }

  // Read opponent pitcher features from exactly ONE snapshot.
  // The same single-snapshot discipline as hitter features applies here:
  // flattening rows from multiple pitcher snapshots would let older values
  // overwrite the newest values for the same feature key.
  //
  // Three-step CTE:
  //   batter_team       — derive the batter's team from the same projected-only
  //                       lineup policy that produced pregame research rows
  //   opposing_starter  — confirmed/probable starter from the opposing team
  //   latest_pitcher_snapshot — single most-recently-retrieved snapshot for that
  //                       pitcher at or before the slate date
  const pitcherRes = await pool.query<{
    metric_key: string; value: string | null; batter_side: string | null; family: string;
  }>(
    `WITH accepted AS (
       SELECT * FROM unnest($4::text[], $5::text[]) AS source_state(source_id, state)
     ),
     batter_team AS (
       SELECT ls.team_id
       FROM lineup_entries le
       JOIN lineup_snapshots ls ON ls.lineup_snapshot_id = le.lineup_snapshot_id
       JOIN accepted a ON a.source_id = ls.source_id AND a.state = ls.state::text
       WHERE le.player_id = $1 AND ls.game_pk = $2
       ORDER BY array_position($4::text[], ls.source_id), ls.observed_at DESC
       LIMIT 1
     ),
     opposing_starter AS (
       SELECT st.player_id
       FROM starters st
       JOIN batter_team bt ON bt.team_id IS NOT NULL AND st.team_id != bt.team_id
       WHERE st.game_pk = $2
         AND st.starter_state IN ('CONFIRMED', 'PROBABLE')
       LIMIT 1
     ),
     latest_pitcher_snapshot AS (
       SELECT s.research_snapshot_id
       FROM pitcher_research_snapshots s
       JOIN opposing_starter os ON os.player_id = s.player_id
       WHERE s.effective_to <= $3
         AND s.research_window = 'SEASON'
       ORDER BY s.retrieved_at DESC
       LIMIT 1
     )
     SELECT f.metric_key, f.value, f.batter_side, f.family
     FROM pitcher_research_features f
     JOIN latest_pitcher_snapshot lps ON lps.research_snapshot_id = f.research_snapshot_id
     ORDER BY f.family, f.metric_key, f.batter_side NULLS LAST`,
    [playerId, gamePk, slateDate, PREGAME_LINEUP_FILTER.sourceIds, PREGAME_LINEUP_FILTER.states],
  );

  const pitcherFeatures: JsonObject = {};
  for (const row of pitcherRes.rows) {
    const side = row.batter_side ?? "all";
    pitcherFeatures[`pitcher.${row.family}.${row.metric_key}.${side}`] = row.value !== null ? Number(row.value) : null;
  }

  // Read park features from exactly ONE snapshot for the game's venue.
  //
  // Season constraint: only snapshots whose season ≤ the game's calendar year
  // are eligible. This prevents a future-season park snapshot from being
  // frozen into a historical backfill vector (data leakage).
  //
  // Within the eligible seasons, the highest season wins (use the most
  // recent available park environment). Within that season, the most-recently
  // ingested snapshot wins (same freshness rule as hitter/pitcher).
  const parkRes = await pool.query<{
    metric_key: string; value: string | null; batter_side: string | null;
  }>(
    `SELECT f.metric_key, f.value, f.batter_side
     FROM park_research_features f
     JOIN park_research_snapshots ps ON ps.park_research_snapshot_id = f.park_research_snapshot_id
     WHERE ps.park_research_snapshot_id = (
       SELECT ps2.park_research_snapshot_id
       FROM park_research_snapshots ps2
       JOIN games g ON g.venue_id = ps2.venue_id
       WHERE g.game_pk = $1
         AND ps2.season <= EXTRACT(year FROM g.game_date)
       ORDER BY ps2.season DESC, ps2.retrieved_at DESC
       LIMIT 1
     )
     ORDER BY f.metric_key, f.batter_side NULLS LAST`,
    [gamePk],
  );

  const parkFeatures: JsonObject = {};
  for (const row of parkRes.rows) {
    const side = row.batter_side ?? "all";
    parkFeatures[`park.${row.metric_key}.${side}`] = row.value !== null ? Number(row.value) : null;
  }

  // NOTE: capturedAt is intentionally excluded from the feature vector used for hashing.
  // It is added by the snapshot writer AFTER computing the hash so that re-captures
  // of identical data produce the same hash (idempotency guarantee).
  return {
    market,
    slateDate,
    playerId,
    gamePk,
    candidateId,
    researchRank: candidate?.research_rank ?? null,
    researchState: candidate?.research_state ?? null,
    primaryMechanism: candidate?.primary_mechanism ?? null,
    secondaryMechanism: candidate?.secondary_mechanism ?? null,
    // Evidence containers from the market research candidate
    opportunityEvidence: candidate?.opportunity_evidence ?? {},
    starterMatchupEvidence: candidate?.starter_matchup_evidence ?? {},
    bullpenPathEvidence: candidate?.bullpen_path_evidence ?? {},
    parkEvidence: candidate?.park_evidence ?? {},
    recentVsSeasonVsCareer: candidate?.recent_vs_season_vs_career ?? {},
    counterEvidence: candidate?.counter_evidence ?? {},
    // Individual metric features (for model training)
    hitterFeatures,
    pitcherFeatures,
    parkFeatures,
  };
}

// ── Snapshot writer ───────────────────────────────────────────────────────────

export type SnapshotWriteResult = {
  snapshotId: string | null;
  status: "WRITTEN" | "SKIPPED" | "ERROR";
  reason: string;
};

/**
 * Captures one pregame feature snapshot for a player-market-game triplet.
 *
 * Idempotency: the partial unique index pfs_original_unique_hash_idx
 * (player_id, game_pk, market, feature_hash) WHERE correction_of IS NULL
 * guarantees at-most-one original row per content hash. Concurrent calls
 * that compute the same hash will race; the loser is caught by ON CONFLICT
 * and the winner's snapshot_id is returned as SKIPPED.
 *
 * Atomicity: snapshot row + provenance rows are written inside a single
 * transaction. A provenance failure rolls back the snapshot, leaving no
 * uncited rows for future captures to skip.
 */
async function captureOneSnapshot(
  playerId: number,
  gamePk: number,
  slateDate: string,
  market: string,
  ingestRunId: string,
  candidateId: string,
): Promise<SnapshotWriteResult> {
  try {
    // node-postgres returns bigint columns as strings. Normalize once at this
    // boundary so the frozen JSON schema stores a numeric gamePk and validation
    // does not mistake a valid database bigint for malformed client data.
    const normalizedGamePk = Number(gamePk);
    if (!Number.isSafeInteger(normalizedGamePk) || normalizedGamePk <= 0) {
      throw new FeatureStoreValidationError("Feature vector gamePk must be a positive integer");
    }
    const features = await buildFeatureVector(candidateId, playerId, normalizedGamePk, market, slateDate);
    assertFeatureVectorSafe(features);
    const hash = featureHash(features);

    // Acquire a dedicated connection for the transaction.
    // TypeScript infers the type from pool.connect() — no explicit PoolClient import needed.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ON CONFLICT DO NOTHING is used (not DO UPDATE) because DO UPDATE would fire
      // the immutability trigger that blocks ALL UPDATE statements on the table.
      // When the conflict clause fires, RETURNING yields 0 rows; we detect that and
      // report SKIPPED after releasing the transaction.
      const snapshotRes = await client.query<{ snapshot_id: string }>(
        `INSERT INTO pregame_feature_snapshots
           (player_id, game_pk, slate_date, market, features, feature_hash,
            research_rank, research_state, primary_mechanism, ingest_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (player_id, game_pk, market, feature_hash) WHERE correction_of IS NULL
         DO NOTHING
         RETURNING snapshot_id`,
        [
          playerId, normalizedGamePk, slateDate, marketToDb(market),
          JSON.stringify(features), hash,
          features.researchRank, features.researchState, features.primaryMechanism,
          ingestRunId,
        ],
      );

      if (snapshotRes.rows.length === 0) {
        // Conflict — identical hash already in the DB. Roll back (nothing to commit)
        // and look up the existing snapshot_id with a plain SELECT.
        await client.query("ROLLBACK");
        client.release();
        const existing = await pool.query<{ snapshot_id: string }>(
          `SELECT snapshot_id FROM pregame_feature_snapshots
           WHERE player_id = $1 AND game_pk = $2 AND market = $3
             AND feature_hash = $4 AND correction_of IS NULL
           LIMIT 1`,
           [playerId, normalizedGamePk, marketToDb(market), hash],
        );
        return { snapshotId: existing.rows[0]?.snapshot_id ?? null, status: "SKIPPED", reason: "identical feature hash" };
      }

      const snapshotId = snapshotRes.rows[0].snapshot_id;

      // Write provenance rows in the SAME transaction so that a provenance failure
      // rolls back the snapshot, leaving no uncited rows for future captures to skip.
      await client.query(
        `INSERT INTO feature_snapshot_provenance (snapshot_id, source_id, metric_families, ingest_run_id)
         VALUES ($1, 'STATCAST', ARRAY['power','contact','damage','discipline','opportunity'], $2),
                ($1, 'FEATURE_STORE', ARRAY['market_research_candidate'], $2)
         ON CONFLICT DO NOTHING`,
        [snapshotId, ingestRunId],
      );

      await client.query("COMMIT");
      client.release();
      return { snapshotId, status: "WRITTEN", reason: "new snapshot" };
    } catch (txErr) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      client.release();
      throw txErr;
    }
  } catch (error) {
    return { snapshotId: null, status: "ERROR", reason: String(error) };
  }
}

// ── Slate capture ─────────────────────────────────────────────────────────────

export type CaptureSlateResult = {
  slateDate: string;
  ingestRunId: string;
  markets: string[];
  candidatesFound: number;
  snapshotsWritten: number;
  snapshotsSkipped: number;
  snapshotErrors: number;
  processingMs: number;
  notes: string[];
  error: string | null;
};

/**
 * Captures pregame feature snapshots for all market research candidates on a slate date.
 * This is the primary daily entry point — call after market research engines complete.
 */
export async function captureSlateSnapshots(slateDate: string): Promise<CaptureSlateResult> {
  const normalizedSlateDate = normalizedDateOnly(slateDate as unknown as string | Date);
  await ensureFeatureStoreSource();
  const ingestRunId = await startRun("feature_store_capture", normalizedSlateDate);
  const started = Date.now();

  const notes: string[] = [];
  let written = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Get all candidates for this slate date across all four markets
    const candidatesRes = await pool.query<{
      candidate_id: string;
      player_id: number;
      game_pk: number;
      market: string;
    }>(
      `SELECT candidate_id, player_id, game_pk, market
       FROM market_research_candidates
       WHERE slate_date = $1 AND market <> 'HITS_RUNS_RBI_2_PLUS'
       ORDER BY market, player_id`,
       [normalizedSlateDate],
    );

    const candidates = candidatesRes.rows;
    if (candidates.length === 0) {
      notes.push(`No market research candidates found for ${normalizedSlateDate}. Run market engines first.`);
    }

    const markets = [...new Set(candidates.map((c) => dbToMarketShort(c.market)))];

    for (const candidate of candidates) {
      const result = await captureOneSnapshot(
        candidate.player_id,
        candidate.game_pk,
        normalizedSlateDate,
        dbToMarketShort(candidate.market),
        ingestRunId,
        candidate.candidate_id,
      );
      if (result.status === "WRITTEN") written += 1;
      else if (result.status === "SKIPPED") skipped += 1;
      else {
        errors += 1;
        notes.push(`Error capturing ${candidate.player_id}/${candidate.market}: ${result.reason}`);
      }
    }

    await finishRun(ingestRunId, errors > 0 ? "PARTIAL" : "SUCCESS", {
      rows: candidates.length,
      normalized: written,
      rejected: errors,
    }, started);

    return {
      slateDate: normalizedSlateDate,
      ingestRunId,
      markets,
      candidatesFound: candidates.length,
      snapshotsWritten: written,
      snapshotsSkipped: skipped,
      snapshotErrors: errors,
      processingMs: Date.now() - started,
      notes,
      error: null,
    };
  } catch (error) {
    await finishRun(ingestRunId, "FAILED", { rows: 0, normalized: 0, rejected: 0, error: String(error) }, started);
    return {
      slateDate: normalizedSlateDate,
      ingestRunId,
      markets: [],
      candidatesFound: 0,
      snapshotsWritten: written,
      snapshotsSkipped: skipped,
      snapshotErrors: errors,
      processingMs: Date.now() - started,
      notes,
      error: String(error),
    };
  }
}

// ── Correction protocol ───────────────────────────────────────────────────────

export type CorrectionResult = {
  newSnapshotId: string;
  originalSnapshotId: string;
  correctionReason: CorrectionReason;
  correctionNote: string | null;
  createdAt: string;
};

/**
 * Creates a correction snapshot pointing to an original snapshot.
 * The original row is NEVER modified — immutability is preserved.
 * correctionReason MUST be a valid taxonomy code from CORRECTION_REASONS.
 *
 * Atomicity: the new snapshot row + its provenance rows (copied from the
 * original) are written inside a single transaction. A provenance failure
 * rolls back the correction entirely so auditors never see an uncited row.
 */
export async function correctSnapshot(
  originalSnapshotId: string,
  correctionReason: CorrectionReason,
  correctionNote: string | null,
  updatedFeatures: JsonObject | null,
): Promise<CorrectionResult> {
  if (!CORRECTION_REASONS.includes(correctionReason)) {
    throw new Error(
      `Invalid correction reason "${correctionReason}". Must be one of: ${CORRECTION_REASONS.join(", ")}`,
    );
  }

  // Load the original snapshot and its provenance (outside the write transaction)
  const originalRes = await pool.query<{
    snapshot_id: string;
    player_id: number;
    game_pk: number;
    slate_date: string;
    market: string;
    features: JsonObject;
    research_rank: number | null;
    research_state: string | null;
    primary_mechanism: string | null;
    ingest_run_id: string | null;
    correction_of: string | null;
  }>(
    `SELECT snapshot_id, player_id, game_pk, slate_date, market, features,
            research_rank, research_state, primary_mechanism, ingest_run_id, correction_of
     FROM pregame_feature_snapshots WHERE snapshot_id = $1`,
    [originalSnapshotId],
  );

  if (originalRes.rows.length === 0) {
    throw new Error(`Snapshot ${originalSnapshotId} not found`);
  }

  const original = originalRes.rows[0];

  // Read the original's provenance rows so we can copy them to the correction
  const provenanceRes = await pool.query<{
    source_id: string;
    metric_families: string[];
    retrieved_at: string | null;
    ingest_run_id: string | null;
  }>(
    `SELECT source_id, metric_families, retrieved_at, ingest_run_id
     FROM feature_snapshot_provenance WHERE snapshot_id = $1`,
    [originalSnapshotId],
  );

  const newFeatures = updatedFeatures ?? (original.features as JsonObject);
  assertFeatureVectorSafe(newFeatures);
  const originalGamePk = Number(original.game_pk);
  const originalSlateDate = normalizedDateOnly(original.slate_date as unknown as string | Date);
  if (
    newFeatures.playerId !== original.player_id ||
    newFeatures.gamePk !== originalGamePk ||
    newFeatures.slateDate !== originalSlateDate ||
    newFeatures.market !== dbToMarketShort(original.market)
  ) {
    throw new FeatureStoreValidationError(
      "Correction feature vector identity must match the original player, game, slate date, and market",
    );
  }
  const hash = featureHash(newFeatures);

  // Write the new snapshot + copied provenance atomically
  const client = await pool.connect();
  let newSnapshotId: string;
  let createdAt: string;
  try {
    await client.query("BEGIN");

    const newSnapshotRes = await client.query<{ snapshot_id: string; created_at: string }>(
      `INSERT INTO pregame_feature_snapshots
         (player_id, game_pk, slate_date, market, features, feature_hash,
          research_rank, research_state, primary_mechanism, ingest_run_id,
          correction_of, correction_reason, correction_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING snapshot_id, created_at`,
      [
         original.player_id, originalGamePk, originalSlateDate, original.market,
        JSON.stringify(newFeatures), hash,
        original.research_rank, original.research_state, original.primary_mechanism,
        original.ingest_run_id,
        originalSnapshotId, correctionReason, correctionNote,
      ],
    );
    newSnapshotId = newSnapshotRes.rows[0].snapshot_id;
    createdAt = String(newSnapshotRes.rows[0].created_at);

    // Copy provenance from the original snapshot to the correction.
    // If the original had no provenance, write a default HUMAN_CORRECTION entry.
    if (provenanceRes.rows.length > 0) {
      for (const prov of provenanceRes.rows) {
        await client.query(
          `INSERT INTO feature_snapshot_provenance
             (snapshot_id, source_id, metric_families, retrieved_at, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [newSnapshotId, prov.source_id, prov.metric_families, prov.retrieved_at, prov.ingest_run_id],
        );
      }
    } else {
      await client.query(
        `INSERT INTO feature_snapshot_provenance (snapshot_id, source_id, metric_families)
         VALUES ($1, 'FEATURE_STORE', ARRAY['correction'])
         ON CONFLICT DO NOTHING`,
        [newSnapshotId],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    client.release();
    throw err;
  }
  client.release();

  return {
    newSnapshotId,
    originalSnapshotId,
    correctionReason,
    correctionNote,
    createdAt,
  };
}

// ── Historical backfill ───────────────────────────────────────────────────────

export type BackfillResult = {
  fromDate: string;
  toDate: string;
  datesProcessed: number;
  candidatesFound: number;
  snapshotsWritten: number;
  snapshotsSkipped: number;
  processingMs: number;
  notes: string[];
  error: string | null;
};

/**
 * Backfills pregame feature snapshots from existing market research candidates
 * for a date range. Respects source-availability gaps (skips dates with no data).
 * Idempotent — already-captured snapshots are skipped by feature hash.
 */
export async function backfillHistoricalSnapshots(fromDate: string, toDate: string): Promise<BackfillResult> {
  await ensureFeatureStoreSource();
  const started = Date.now();
  const notes: string[] = [];
  let datesProcessed = 0;
  let totalCandidates = 0;
  let totalWritten = 0;
  let totalSkipped = 0;

  try {
    // Get all distinct slate dates in range that have candidates
    const datesRes = await pool.query<{ slate_date: string }>(
      `SELECT DISTINCT slate_date FROM market_research_candidates
       WHERE slate_date >= $1 AND slate_date <= $2
       ORDER BY slate_date`,
      [fromDate, toDate],
    );

    for (const { slate_date: rawSlateDate } of datesRes.rows) {
      const slateDate = normalizedDateOnly(rawSlateDate as unknown as string | Date);
      const result = await captureSlateSnapshots(slateDate);
      datesProcessed += 1;
      totalCandidates += result.candidatesFound;
      totalWritten += result.snapshotsWritten;
      totalSkipped += result.snapshotsSkipped;
      if (result.notes.length > 0) notes.push(...result.notes.map((n) => `[${slateDate}] ${n}`));
    }

    if (datesProcessed === 0) {
      notes.push(`No market research candidates found between ${fromDate} and ${toDate}.`);
    }

    return {
      fromDate,
      toDate,
      datesProcessed,
      candidatesFound: totalCandidates,
      snapshotsWritten: totalWritten,
      snapshotsSkipped: totalSkipped,
      processingMs: Date.now() - started,
      notes,
      error: null,
    };
  } catch (error) {
    return {
      fromDate,
      toDate,
      datesProcessed,
      candidatesFound: totalCandidates,
      snapshotsWritten: totalWritten,
      snapshotsSkipped: totalSkipped,
      processingMs: Date.now() - started,
      notes,
      error: String(error),
    };
  }
}

// ── Historical outcomes (append-only) ────────────────────────────────────────

export type WriteOutcomeInput = {
  playerId: number;
  gamePk: number;
  slateDate: string;
  market: "TB" | "XBH" | "WALK" | "HR";
  singles: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  walks: number;
  plateAppearances: number;
  atBats: number;
  sourceId: string;
  ingestRunId?: string | null;
};

function assertOfficialOutcomeInput(input: WriteOutcomeInput): void {
  if (input.sourceId !== "MLB_OFFICIAL") {
    throw new FeatureStoreValidationError(
      "Only MLB_OFFICIAL may stage an outcome observation. Official settlement is performed by the MLB feed workflow.",
    );
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === "ingestRunId") continue;
    const prohibited = prohibitedBettingTerm(key);
    if (prohibited) {
      throw new FeatureStoreValidationError(`Outcome payload contains prohibited betting key "${key}"`);
    }
    if (key === "sourceId" && typeof value === "string" && prohibitedBettingTerm(value)) {
      throw new FeatureStoreValidationError("Outcome sourceId may not identify a betting source");
    }
  }
  for (const key of [
    "singles",
    "doubles",
    "triples",
    "homeRuns",
    "walks",
    "plateAppearances",
    "atBats",
  ] as const) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new FeatureStoreValidationError(`Outcome ${key} must be a non-negative integer`);
    }
  }
}

function computeOutcome(market: WriteOutcomeInput["market"], input: WriteOutcomeInput): { value: number; hit: boolean } {
  switch (market) {
    case "TB": {
      const tb = input.singles + input.doubles * 2 + input.triples * 3 + input.homeRuns * 4;
      return { value: tb, hit: tb >= 2 };
    }
    case "XBH": {
      const xbh = input.doubles + input.triples + input.homeRuns;
      return { value: xbh, hit: xbh >= 1 };
    }
    case "WALK":
      return { value: input.walks, hit: input.walks >= 1 };
    case "HR":
      return { value: input.homeRuns, hit: input.homeRuns >= 1 };
  }
}

/**
 * Writes an append-only pending official-stat observation.
 * This service NEVER updates existing outcome rows.
 * It cannot create a SETTLED result; only the MLB Stats API settlement engine
 * may write a verified settlement with official-run provenance.
 */
export async function writeHistoricalOutcome(input: WriteOutcomeInput): Promise<string> {
  await ensureFeatureStoreSource();
  assertOfficialOutcomeInput(input);
  const { value, hit } = computeOutcome(input.market, input);

  const r = await pool.query<{ outcome_id: string }>(
    `INSERT INTO historical_outcomes
       (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
        plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
        settlement_state, source_id, ingest_run_id, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING', $14, $15, $16)
     RETURNING outcome_id`,
    [
      input.playerId, input.gamePk, input.slateDate, marketToDb(input.market),
      value, hit,
      input.plateAppearances, input.atBats,
      input.singles, input.doubles, input.triples, input.homeRuns, input.walks,
       input.sourceId, input.ingestRunId ?? null, JSON.stringify({}),
    ],
  );
  return r.rows[0].outcome_id;
}

// ── Query layer ───────────────────────────────────────────────────────────────

export type FeatureStoreSnapshot = {
  snapshotId: string;
  playerId: number;
  playerName: string;
  gamePk: number;
  slateDate: string;
  market: "TB" | "XBH" | "WALK" | "HR";
  frozenAt: string;
  researchRank: number | null;
  researchState: string | null;
  primaryMechanism: string | null;
  features: JsonObject;
  correctionOf: string | null;
  correctionReason: string | null;
  correctionNote: string | null;
  isCorrection: boolean;
  createdAt: string;
};

export type FeatureStoreStats = {
  totalSnapshots: number;
  originalSnapshots: number;
  correctionSnapshots: number;
  snapshotsByMarket: Record<string, number>;
  oldestSlateDate: string | null;
  newestSlateDate: string | null;
  distinctSlateDates: number;
  totalOutcomes: number;
  outcomesByMarket: Record<string, number>;
};

export type FeatureStoreQueryResult = {
  snapshots: FeatureStoreSnapshot[];
  total: number;
  stats: FeatureStoreStats;
  filters: {
    playerId: number | null;
    market: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  };
  correctionTaxonomy: string[];
  systemNote: string;
};

export async function queryFeatureStore(filters: {
  playerId?: number | null;
  market?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
}): Promise<FeatureStoreQueryResult> {
  const { playerId, market, dateFrom, dateTo, limit = 200 } = filters;
  const params: unknown[] = [];
  const where: string[] = [];

  if (playerId != null) {
    params.push(playerId);
    where.push(`pfs.player_id = $${params.length}`);
  }
  if (market != null) {
    params.push(marketToDb(market));
    where.push(`pfs.market = $${params.length}`);
  }
  if (dateFrom != null) {
    params.push(dateFrom);
    where.push(`pfs.slate_date >= $${params.length}`);
  }
  if (dateTo != null) {
    params.push(dateTo);
    where.push(`pfs.slate_date <= $${params.length}`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const limitClause = `LIMIT $${params.length}`;

  const snapshotsRes = await pool.query<{
    snapshot_id: string;
    player_id: number;
    full_name: string;
    game_pk: number;
    slate_date: string;
    market: string;
    frozen_at: string;
    research_rank: number | null;
    research_state: string | null;
    primary_mechanism: string | null;
    features: JsonObject;
    correction_of: string | null;
    correction_reason: string | null;
    correction_note: string | null;
    created_at: string;
  }>(
    `SELECT pfs.snapshot_id, pfs.player_id, p.full_name, pfs.game_pk::bigint AS game_pk,
            pfs.slate_date::text AS slate_date, pfs.market, pfs.frozen_at,
            pfs.research_rank, pfs.research_state, pfs.primary_mechanism,
            pfs.features, pfs.correction_of, pfs.correction_reason,
            pfs.correction_note, pfs.created_at
     FROM pregame_feature_snapshots pfs
     JOIN players p ON p.player_id = pfs.player_id
     ${whereClause}
     ORDER BY pfs.slate_date DESC, pfs.created_at DESC
     ${limitClause}`,
    params,
  );

  // Stats query
  const statsRes = await pool.query<{
    total_snapshots: string;
    original_snapshots: string;
    correction_snapshots: string;
    oldest_slate_date: string | null;
    newest_slate_date: string | null;
    distinct_slate_dates: string;
  }>(
    `SELECT count(*)::text AS total_snapshots,
            count(*) FILTER (WHERE correction_of IS NULL)::text AS original_snapshots,
            count(*) FILTER (WHERE correction_of IS NOT NULL)::text AS correction_snapshots,
            min(slate_date)::text AS oldest_slate_date,
            max(slate_date)::text AS newest_slate_date,
            count(DISTINCT slate_date)::text AS distinct_slate_dates
     FROM pregame_feature_snapshots`,
  );

  const byMarketRes = await pool.query<{ market: string; cnt: string }>(
    `SELECT market, count(*)::text AS cnt FROM pregame_feature_snapshots
     WHERE correction_of IS NULL GROUP BY market`,
  );

  const outcomeStatsRes = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM historical_outcomes`,
  );

  const outcomeByMarketRes = await pool.query<{ market: string; cnt: string }>(
    `SELECT market, count(*)::text AS cnt FROM historical_outcomes GROUP BY market`,
  );

  const stats = statsRes.rows[0];
  const snapshotsByMarket: Record<string, number> = {};
  for (const row of byMarketRes.rows) snapshotsByMarket[dbToMarketShort(row.market)] = Number(row.cnt);
  const outcomesByMarket: Record<string, number> = {};
  for (const row of outcomeByMarketRes.rows) outcomesByMarket[dbToMarketShort(row.market)] = Number(row.cnt);

  return {
    snapshots: snapshotsRes.rows.map((row) => ({
      snapshotId: row.snapshot_id,
      playerId: row.player_id,
      playerName: row.full_name,
      gamePk: Number(row.game_pk),
      slateDate: String(row.slate_date),
      market: dbToMarketShort(row.market),
      frozenAt: String(row.frozen_at),
      researchRank: row.research_rank,
      researchState: row.research_state,
      primaryMechanism: row.primary_mechanism,
      features: (row.features as JsonObject) ?? {},
      correctionOf: row.correction_of,
      correctionReason: row.correction_reason,
      correctionNote: row.correction_note,
      isCorrection: row.correction_of !== null,
      createdAt: String(row.created_at),
    })),
    total: snapshotsRes.rows.length,
    stats: {
      totalSnapshots: Number(stats?.total_snapshots ?? 0),
      originalSnapshots: Number(stats?.original_snapshots ?? 0),
      correctionSnapshots: Number(stats?.correction_snapshots ?? 0),
      snapshotsByMarket,
      oldestSlateDate: stats?.oldest_slate_date ?? null,
      newestSlateDate: stats?.newest_slate_date ?? null,
      distinctSlateDates: Number(stats?.distinct_slate_dates ?? 0),
      totalOutcomes: Number(outcomeStatsRes.rows[0]?.total ?? 0),
      outcomesByMarket,
    },
    filters: {
      playerId: playerId ?? null,
      market: market ?? null,
      dateFrom: dateFrom ?? null,
      dateTo: dateTo ?? null,
    },
    correctionTaxonomy: [...CORRECTION_REASONS],
    systemNote:
      "IMMUTABILITY CONTRACT: pregame_feature_snapshots rows are NEVER updated. " +
      "Corrections create new rows with correction_of FK. " +
      "historical_outcomes is append-only. " +
      "No odds, EV, CLV, or sportsbook data is stored.",
  };
}
