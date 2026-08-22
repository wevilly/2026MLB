/**
 * Phase 5A – Model Training and Versioning Framework
 *
 * Validates:
 * M1 four market-specific candidate versions train from frozen official rows
 * M2 version/run records pin a private artifact key and SHA-256 content hash
 * M3 market parameters are isolated and no manual ACTIVE transition is allowed
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const API = "http://127.0.0.1:8080";
const FIXTURE = {
  playerId: 9991801,
  homeTeamId: 9990801,
  awayTeamId: 9990802,
  gamePk: 9998801,
  slateDate: "2026-10-15",
};
const MARKETS = [
  ["TB", "TOTAL_BASES_2_PLUS", 2, true],
  ["XBH", "EXTRA_BASE_HIT", 1, true],
  ["WALK", "BATTER_WALK", 1, true],
  ["HR", "HOME_RUN", 1, true],
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const trainingRunIds = [];
const versionIds = [];

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.bypass_immutability = 'true'");
    if (trainingRunIds.length) {
      await client.query("DELETE FROM model_training_runs WHERE training_run_id = ANY($1)", [trainingRunIds]);
    }
    if (versionIds.length) {
      await client.query("DELETE FROM model_walk_forward_acceptances WHERE model_version_id = ANY($1)", [versionIds]);
      await client.query("DELETE FROM model_versions WHERE version_id = ANY($1)", [versionIds]);
    }
    await client.query("DELETE FROM historical_outcomes WHERE player_id = $1", [FIXTURE.playerId]);
    await client.query(`DELETE FROM feature_snapshot_provenance WHERE snapshot_id IN (
      SELECT snapshot_id FROM pregame_feature_snapshots WHERE player_id = $1
    )`, [FIXTURE.playerId]);
    await client.query("DELETE FROM pregame_feature_snapshots WHERE player_id = $1", [FIXTURE.playerId]);
    await client.query("DELETE FROM games WHERE game_pk = $1", [FIXTURE.gamePk]);
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
      ($1, 'M5AH', 'Phase 5A Home'), ($2, 'M5AA', 'Phase 5A Away')
     ON CONFLICT (team_id) DO NOTHING`,
    [FIXTURE.homeTeamId, FIXTURE.awayTeamId],
  );
  await pool.query(
    `INSERT INTO players (player_id, full_name) VALUES ($1, 'Phase 5A Batter')
     ON CONFLICT (player_id) DO NOTHING`,
    [FIXTURE.playerId],
  );
  await pool.query(
    `INSERT INTO games (game_pk, game_date, home_team_id, away_team_id, game_status)
     VALUES ($1, $2, $3, $4, 'Final')`,
    [FIXTURE.gamePk, FIXTURE.slateDate, FIXTURE.homeTeamId, FIXTURE.awayTeamId],
  );
  const run = await pool.query(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ('MLB_OFFICIAL', 'mlb-official-settlement', 'SUCCESS', $1)
     RETURNING ingest_run_id`,
    [FIXTURE.slateDate],
  );
  const ingestRunId = run.rows[0].ingest_run_id;
  for (const [index, [, dbMarket, value, hit]] of MARKETS.entries()) {
    await pool.query(
      `INSERT INTO pregame_feature_snapshots
         (player_id, game_pk, slate_date, market, features, feature_hash, research_rank, research_state)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'POSITIVE')`,
      [FIXTURE.playerId, FIXTURE.gamePk, FIXTURE.slateDate, dbMarket,
        { fixtureSignal: index + 1, nested: { opportunity: index + 2 } }, `phase-5a-${dbMarket}-hash`],
    );
    await pool.query(
      `INSERT INTO historical_outcomes
         (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
          plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
          settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata)
       VALUES ($1, $2, $3, $4, $5, $6,
               4, 3, 1, 1, 0, 1, 1,
               'SETTLED', now(), 'MLB_OFFICIAL', $7,
               '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}')`,
      [FIXTURE.playerId, FIXTURE.gamePk, FIXTURE.slateDate, dbMarket, value, hit, ingestRunId],
    );
  }
}

describe("Phase 5A – Model Training and Versioning Framework", () => {
  before(async () => {
    await cleanup();
    await setup();
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test("M1/M2: training produces one independent candidate and pinned artifact per market", async () => {
    const trained = [];
    for (const [market] of MARKETS) {
      const response = await fetch(`${API}/api/analyst/models/train?market=${market}`, { method: "POST" });
      assert.equal(response.status, 201, `${market} should train from official frozen records`);
      const body = await response.json();
      trained.push(body);
      trainingRunIds.push(body.trainingRunId);
      versionIds.push(body.versionId);
      assert.equal(body.market, market);
      assert.equal(body.status, "CANDIDATE");
      assert.equal(body.trainingSampleCount, 1);
      assert.match(body.artifactKey, /^gs:\/\/[^/]+\/.+\/model-artifacts\//);
      assert.match(body.artifactGeneration, /^\d+$/);
      assert.match(body.artifactContentHash, /^[a-f0-9]{64}$/);
    }
    assert.equal(new Set(trained.map((row) => row.versionId)).size, 4);
    assert.equal(new Set(trained.map((row) => row.artifactContentHash)).size, 4, "market artifacts must not share serialized parameters");

    const listed = await fetch(`${API}/api/analyst/models`);
    assert.equal(listed.status, 200);
    const list = await listed.json();
    const fixtureVersions = list.versions.filter((version) => versionIds.includes(version.versionId));
    assert.equal(fixtureVersions.length, 4);
    assert.deepEqual(new Set(fixtureVersions.map((version) => version.market)), new Set(MARKETS.map(([market]) => market)));

    const lineage = await pool.query(
      `SELECT r.market, r.status AS run_status, r.model_version_id, r.artifact_content_hash AS run_hash,
              v.artifact_content_hash AS version_hash, v.hyperparameters
         FROM model_training_runs r
         JOIN model_versions v ON v.version_id = r.model_version_id
        WHERE r.training_run_id = ANY($1)`,
      [trainingRunIds],
    );
    assert.equal(lineage.rows.length, 4);
    for (const row of lineage.rows) {
      assert.equal(row.run_status, "SUCCESS");
      assert.equal(row.run_hash, row.version_hash, "training run must pin the version artifact hash");
      assert.ok(row.hyperparameters.market, "each model records its own market-scoped parameters");
    }
  });

  test("M3: no model can become ACTIVE before Phase 5B, even with a spoofed caller context", async () => {
    const acceptance = await pool.query(
      `INSERT INTO model_walk_forward_acceptances (model_version_id, validation_run_id, metrics)
       VALUES ($1, 'spoofed-phase-5b-run', '{"accepted":true}')
       RETURNING acceptance_id`,
      [versionIds[0]],
    );
    await pool.query(
      "UPDATE model_versions SET walk_forward_acceptance_id = $1 WHERE version_id = $2",
      [acceptance.rows[0].acceptance_id, versionIds[0]],
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.writer_context = 'WALK_FORWARD'");
      await assert.rejects(
        client.query("UPDATE model_versions SET status = 'ACTIVE' WHERE version_id = $1", [versionIds[0]]),
        /Phase 5A candidates cannot be activated/i,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const blocked = await pool.query("SELECT status, walk_forward_acceptance_id FROM model_versions WHERE version_id = $1", [versionIds[0]]);
    assert.equal(blocked.rows[0].status, "CANDIDATE");
    assert.equal(blocked.rows[0].walk_forward_acceptance_id, acceptance.rows[0].acceptance_id);
  });
});