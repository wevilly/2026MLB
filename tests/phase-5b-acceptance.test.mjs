/**
 * Phase 5B – Walk-Forward Validation and Calibration
 *
 * Validates:
 * V1 chronological folds only train on dates before their held-out test date
 * V2 a specified signal beats its market benchmark and passes calibration
 * V3 a noise-only market fails its independent benchmark and is marked FAILED
 * V4 ACTIVE requires the linked PASS run to have passed calibration
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const apiRequire = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { Storage } = apiRequire("@google-cloud/storage");
const API = "http://127.0.0.1:8080";
const FIXTURE = {
  playerId: 9991901,
  homeTeamId: 9990901,
  awayTeamId: 9990902,
  firstGamePk: 9998901,
};
const DATES = Array.from({ length: 10 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const versionIds = [];
const runIds = [];
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: "http://127.0.0.1:1106/token",
    type: "external_account",
    credential_source: {
      url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.bypass_immutability = 'true'");
    if (runIds.length) {
      await client.query("DELETE FROM walk_forward_runs WHERE walk_forward_run_id = ANY($1)", [runIds]);
    }
    if (versionIds.length) {
      await client.query("DELETE FROM model_training_runs WHERE model_version_id = ANY($1)", [versionIds]);
      await client.query("DELETE FROM model_walk_forward_acceptances WHERE model_version_id = ANY($1)", [versionIds]);
      await client.query("DELETE FROM model_versions WHERE version_id = ANY($1)", [versionIds]);
    }
    await client.query("DELETE FROM historical_outcomes WHERE player_id = $1", [FIXTURE.playerId]);
    await client.query(`DELETE FROM feature_snapshot_provenance WHERE snapshot_id IN (
      SELECT snapshot_id FROM pregame_feature_snapshots WHERE player_id = $1
    )`, [FIXTURE.playerId]);
    await client.query("DELETE FROM pregame_feature_snapshots WHERE player_id = $1", [FIXTURE.playerId]);
    await client.query(`DELETE FROM games WHERE game_pk >= $1 AND game_pk < $2`, [FIXTURE.firstGamePk, FIXTURE.firstGamePk + DATES.length]);
    await client.query("DELETE FROM players WHERE player_id = $1", [FIXTURE.playerId]);
    await client.query("DELETE FROM teams WHERE team_id IN ($1, $2)", [FIXTURE.homeTeamId, FIXTURE.awayTeamId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setup() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type)
     VALUES ('MLB_OFFICIAL', 'MLB Official', 'OFFICIAL')
     ON CONFLICT (source_id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name) VALUES
      ($1, 'M5BH', 'Phase 5B Home'), ($2, 'M5BA', 'Phase 5B Away')
     ON CONFLICT (team_id) DO NOTHING`,
    [FIXTURE.homeTeamId, FIXTURE.awayTeamId],
  );
  await pool.query(
    `INSERT INTO players (player_id, full_name) VALUES ($1, 'Phase 5B Batter')
     ON CONFLICT (player_id) DO NOTHING`,
    [FIXTURE.playerId],
  );
  const ingest = await pool.query(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ('MLB_OFFICIAL', 'mlb-official-settlement', 'SUCCESS', $1)
     RETURNING ingest_run_id`,
    [DATES[0]],
  );
  const ingestRunId = ingest.rows[0].ingest_run_id;
  const signal = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
  const noiseLabels = [true, false, true, false, false, true, false, true, false, true];

  for (const [index, date] of DATES.entries()) {
    const gamePk = FIXTURE.firstGamePk + index;
    await pool.query(
      `INSERT INTO games (game_pk, game_date, home_team_id, away_team_id, game_status)
       VALUES ($1, $2, $3, $4, 'Final')`,
      [gamePk, date, FIXTURE.homeTeamId, FIXTURE.awayTeamId],
    );
    for (const [market, features, value, hit] of [
      ["TOTAL_BASES_2_PLUS", { signal: signal[index] }, signal[index] ? 3 : 0, Boolean(signal[index])],
      ["EXTRA_BASE_HIT", { randomNoise: 0 }, noiseLabels[index] ? 1 : 0, noiseLabels[index]],
      ["BATTER_WALK", { signal: signal[index] }, signal[index], Boolean(signal[index])],
      ["HOME_RUN", { signal: signal[index] }, signal[index], Boolean(signal[index])],
    ]) {
      await pool.query(
        `INSERT INTO pregame_feature_snapshots
           (player_id, game_pk, slate_date, market, frozen_at, features, feature_hash,
            research_rank, research_state, created_at)
         VALUES ($1, $2, $3, $4, ($3::date + interval '12 hours'), $5, $6, 1, 'POSITIVE',
                 ($3::date + interval '12 hours'))`,
        [FIXTURE.playerId, gamePk, date, market, features, `phase-5b-${market}-${index}`],
      );
      await pool.query(
        `INSERT INTO historical_outcomes
           (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
            plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
            settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 4, 3, 0, 1, 0, 0, 0,
                 'SETTLED', ($3::date + interval '23 hours'), 'MLB_OFFICIAL', $7,
                 '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}',
                 ($3::date + interval '23 hours'))`,
        [FIXTURE.playerId, gamePk, date, market, value, hit, ingestRunId],
      );
    }
  }
}

async function train(market) {
  const response = await fetch(`${API}/api/analyst/models/train?market=${market}`, { method: "POST" });
  assert.equal(response.status, 201, `${market} model training should complete`);
  const result = await response.json();
  versionIds.push(result.versionId);
  return result;
}

async function withValidationWriter(sql, values) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE mlb_walk_forward_validator");
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createConstantNoiseModel() {
  const versionId = `xbh-noise-${randomUUID()}`;
  const featureSetHash = createHash("sha256").update("randomNoise").digest("hex");
  const content = JSON.stringify({
    schemaVersion: 1,
    market: "XBH",
    algorithm: "deterministic-centered-linear-v1",
    featureSetHash,
    featureNames: ["randomNoise"],
    coefficients: { randomNoise: 0 },
    intercept: 0.5,
  });
  const contentHash = createHash("sha256").update(content).digest("hex");
  const [bucketName, ...prefixParts] = process.env.PRIVATE_OBJECT_DIR.replace(/^\/+/, "").split("/");
  const objectName = [...prefixParts, "model-artifacts", `${versionId}.json`].join("/");
  const file = storage.bucket(bucketName).file(objectName);
  await file.save(Buffer.from(content), {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    contentType: "application/json",
    metadata: { metadata: { sha256: contentHash, modelVersionId: versionId } },
  });
  const [metadata] = await file.getMetadata();
  await pool.query(
    `INSERT INTO model_versions
       (version_id, market, training_seasons, feature_set_hash, algorithm, hyperparameters,
        training_sample_count, status, artifact_key, artifact_generation, artifact_content_hash)
     VALUES ($1, 'EXTRA_BASE_HIT', '["2026"]', $2, 'deterministic-centered-linear-v1',
             '{"market":"XBH","fixture":"constant-noise"}', 10, 'CANDIDATE', $3, $4, $5)`,
    [versionId, featureSetHash, `gs://${bucketName}/${objectName}`, String(metadata.generation), contentHash],
  );
  versionIds.push(versionId);
  return { versionId };
}

describe("Phase 5B – Walk-Forward Validation and Calibration", () => {
  let signalModel;
  let signalValidation;

  before(async () => {
    await cleanup();
    await setup();
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test("V1/V2: specified TB, WALK, and HR signals pass chronological walk-forward validation", async () => {
    for (const market of ["TB", "WALK", "HR"]) {
      const model = await train(market);
      const response = await fetch(`${API}/api/analyst/models/validate?modelVersionId=${model.versionId}`, { method: "POST" });
      assert.equal(response.status, 201);
      const validation = await response.json();
      runIds.push(validation.walkForwardRunId);
      assert.equal(validation.status, "PASS", `${market} signal should pass`);
      assert.equal(validation.benchmarkBeat, true);
      assert.equal(validation.calibrationPassed, true);
      assert.equal(typeof validation.calibrationSlope, "number");
      assert.equal(typeof validation.calibrationIntercept, "number");
      assert.ok(validation.foldCount >= 2);
      for (const fold of validation.foldResults) {
        assert.ok(fold.trainThrough < fold.testDate, "a fold must only train on prior dates");
        assert.ok(fold.trainRowCount >= 2);
        assert.ok(fold.testRowCount >= 1);
        assert.equal(fold.asOfCutoff, `${fold.testDate}T00:00:00.000Z`);
        assert.equal(fold.testSnapshotWindowEnd, `${fold.testDate}T24:00:00.000Z`);
        assert.equal(fold.testOutcomeCutoff, `${fold.testDate} + 2 calendar days`);
      }
      if (market === "TB") {
        signalModel = model;
        signalValidation = validation;
        const version = await pool.query(
          `SELECT calibration_method, calibration_slope, calibration_intercept
             FROM model_versions WHERE version_id = $1`,
          [model.versionId],
        );
        assert.equal(version.rows[0].calibration_method, "platt-grid-fold-weighted-v1");
        assert.notEqual(version.rows[0].calibration_slope, null);
        assert.notEqual(version.rows[0].calibration_intercept, null);
      }
    }

    const history = await fetch(`${API}/api/analyst/models/validation?market=TB`);
    assert.equal(history.status, 200);
    const listed = await history.json();
    assert.equal(listed.runs.some((run) => run.walkForwardRunId === signalValidation.walkForwardRunId), true);
  });

  test("V1b: a correction created after all fold cutoffs cannot change validation history", async () => {
    const heldOutGamePk = FIXTURE.firstGamePk + 2;
    const originalSnapshot = await pool.query(
      `SELECT snapshot_id FROM pregame_feature_snapshots
        WHERE player_id = $1 AND game_pk = $2 AND market = 'TOTAL_BASES_2_PLUS'
        ORDER BY created_at LIMIT 1`,
      [FIXTURE.playerId, heldOutGamePk],
    );
    await pool.query(
      `INSERT INTO pregame_feature_snapshots
         (player_id, game_pk, slate_date, market, frozen_at, features, feature_hash,
          research_rank, research_state, correction_of, correction_reason, correction_note, created_at)
       VALUES ($1, $2, $3, 'TOTAL_BASES_2_PLUS', '2026-09-20T00:00:00Z',
               '{"signal":999}', 'phase-5b-future-correction', 1, 'POSITIVE',
               $4, 'HUMAN_CORRECTION', 'Future-dated test correction', '2026-09-20T00:00:00Z')`,
      [FIXTURE.playerId, heldOutGamePk, DATES[2], originalSnapshot.rows[0].snapshot_id],
    );
    const originalOutcome = await pool.query(
      `SELECT outcome_id, ingest_run_id FROM historical_outcomes
        WHERE player_id = $1 AND game_pk = $2 AND market = 'TOTAL_BASES_2_PLUS'
        ORDER BY created_at LIMIT 1`,
      [FIXTURE.playerId, heldOutGamePk],
    );
    await pool.query(
      `INSERT INTO historical_outcomes
         (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
          plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
          settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata,
          correction_of, process_error_taxonomy, correction_note, created_at)
       VALUES ($1, $2, $3, 'TOTAL_BASES_2_PLUS', 99, true,
               4, 3, 0, 1, 0, 0, 0,
               'SETTLED', '2026-09-20T00:00:00Z', 'MLB_OFFICIAL', $4,
               '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}',
               $5, 'HUMAN_CORRECTION', 'Future-dated test settlement correction', '2026-09-20T00:00:00Z')`,
      [FIXTURE.playerId, heldOutGamePk, DATES[2], originalOutcome.rows[0].ingest_run_id, originalOutcome.rows[0].outcome_id],
    );
    const response = await fetch(`${API}/api/analyst/models/validate?modelVersionId=${signalModel.versionId}`, { method: "POST" });
    assert.equal(response.status, 201);
    const replay = await response.json();
    runIds.push(replay.walkForwardRunId);
    assert.equal(replay.status, signalValidation.status);
    assert.equal(replay.overallMetric, signalValidation.overallMetric);
    assert.equal(replay.benchmarkMetric, signalValidation.benchmarkMetric);
    assert.deepEqual(replay.foldResults, signalValidation.foldResults);
  });

  test("V3: a random-noise feature cannot beat the XBH benchmark", async () => {
    const noiseModel = await createConstantNoiseModel();
    const response = await fetch(`${API}/api/analyst/models/validate?modelVersionId=${noiseModel.versionId}`, { method: "POST" });
    assert.equal(response.status, 201);
    const validation = await response.json();
    runIds.push(validation.walkForwardRunId);
    assert.equal(validation.status, "FAIL");
    assert.equal(validation.benchmarkBeat, false);
    const version = await pool.query("SELECT status FROM model_versions WHERE version_id = $1", [noiseModel.versionId]);
    assert.equal(version.rows[0].status, "FAILED");
  });

  test("V4: calibration must pass on the linked run before ACTIVE is allowed", async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO walk_forward_runs
           (model_version_id, market, fold_count, fold_results, overall_metric, benchmark_metric,
            benchmark_beat, benchmark_method, calibration_method, calibration_curve,
            calibration_error, calibration_passed, status, finished_at)
         VALUES ($1, 'TOTAL_BASES_2_PLUS', 2, '[]', 0.9, 0.8,
                 true, 'tb-historical-base-rate-v1', 'platt-grid-v1', '[]',
                 0.5, false, 'PASS', now())`,
        [signalModel.versionId],
      ),
      /must be inserted as an unfinished INCOMPLETE record/i,
    );
    const client = await pool.connect();
    let failedCalibration;
    try {
      await client.query("BEGIN");
      failedCalibration = await client.query(
        `INSERT INTO walk_forward_runs
           (model_version_id, market, status, benchmark_method, calibration_method)
         VALUES ($1, 'TOTAL_BASES_2_PLUS', 'INCOMPLETE', 'tb-historical-base-rate-v1', 'platt-grid-v1')
         RETURNING walk_forward_run_id`,
        [signalModel.versionId],
      );
      await client.query("SET LOCAL ROLE mlb_walk_forward_validator");
      await client.query(
        `UPDATE walk_forward_runs
            SET finished_at = now(), status = 'FAIL', fold_count = 2, fold_results = '[]',
                overall_metric = 0.9, benchmark_metric = 0.8, benchmark_beat = true,
                calibration_curve = '[]', calibration_error = 0.5, calibration_passed = false
          WHERE walk_forward_run_id = $1`,
        [failedCalibration.rows[0].walk_forward_run_id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    runIds.push(failedCalibration.rows[0].walk_forward_run_id);
    await withValidationWriter(
      "UPDATE model_versions SET walk_forward_acceptance_id = $1 WHERE version_id = $2",
      [failedCalibration.rows[0].walk_forward_run_id, signalModel.versionId],
    );
    await assert.rejects(
      pool.query("UPDATE model_versions SET status = 'ACTIVE' WHERE version_id = $1", [signalModel.versionId]),
      /controlled validation writer|require.*linked PASS walk-forward run/i,
    );
    await withValidationWriter(
      "UPDATE model_versions SET walk_forward_acceptance_id = $1 WHERE version_id = $2",
      [signalValidation.walkForwardRunId, signalModel.versionId],
    );
    const activationClient = await pool.connect();
    try {
      await activationClient.query("BEGIN");
      await activationClient.query("SET LOCAL ROLE mlb_walk_forward_validator");
      await activationClient.query("UPDATE model_versions SET status = 'ACTIVE' WHERE version_id = $1", [signalModel.versionId]);
      await activationClient.query("COMMIT");
    } catch (error) {
      await activationClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      activationClient.release();
    }
    const active = await pool.query("SELECT status FROM model_versions WHERE version_id = $1", [signalModel.versionId]);
    assert.equal(active.rows[0].status, "ACTIVE");
    await assert.rejects(
      pool.query(
        "UPDATE walk_forward_runs SET calibration_error = 0.9 WHERE walk_forward_run_id = $1",
        [signalValidation.walkForwardRunId],
      ),
      /Completed walk_forward_runs are immutable/i,
    );
  });

  test("V5: a normal writer cannot forge validation completion with a session flag", async () => {
    const client = await pool.connect();
    let forgedRunId;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE mlb_analyst_writer");
      await client.query("SET LOCAL app.writer_context = 'WALK_FORWARD'");
      const inserted = await client.query(
        `INSERT INTO walk_forward_runs
           (model_version_id, market, status, benchmark_method, calibration_method)
         VALUES ($1, 'TOTAL_BASES_2_PLUS', 'INCOMPLETE', 'tb-historical-base-rate-v1', 'platt-grid-v1')
         RETURNING walk_forward_run_id`,
        [signalModel.versionId],
      );
      forgedRunId = inserted.rows[0].walk_forward_run_id;
      await assert.rejects(
        client.query(
          `UPDATE walk_forward_runs
              SET finished_at = now(), status = 'PASS', fold_count = 2, fold_results = '[]',
                  overall_metric = 0.9, benchmark_metric = 0.8, benchmark_beat = true,
                  calibration_curve = '[]', calibration_error = 0.1, calibration_passed = true,
                  calibration_slope = 1, calibration_intercept = 0
            WHERE walk_forward_run_id = $1`,
          [forgedRunId],
        ),
        /controlled validation writer role|permission denied/i,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});