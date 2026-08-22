/**
 * Phase 4B – Official Settlement and Postmortem Engine
 *
 * Validates:
 * F1 official outcome component/count storage and XBH = 2B + 3B + HR
 * F2 FantasyPros cannot be persisted as a settlement source
 * F3 settled outcomes are immutable; correction rows require approved taxonomy
 * F4 AI writer context cannot insert settlement or postmortem rows
 * F5 postmortems link one frozen snapshot to one SETTLED official outcome
 * F6 one original settled result is canonical and invalid refresh dates return 400
 * F7 NO_ACTION rows remain visible and are not treated as official losses
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

const API = "http://127.0.0.1:8080";
const FIXTURE = {
  playerId: 9991501,
  otherPlayerId: 9991502,
  homeTeamId: 9990501,
  awayTeamId: 9990502,
  gamePk: 9998501,
  slateDate: "2026-11-02",
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let snapshotId;
let outcomeId;
let ingestRunId;

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.bypass_immutability = 'true'");
    await client.query(`DELETE FROM market_postmortems WHERE player_id IN ($1, $2)`, [FIXTURE.playerId, FIXTURE.otherPlayerId]);
    await client.query(`DELETE FROM historical_outcomes WHERE player_id IN ($1, $2)`, [FIXTURE.playerId, FIXTURE.otherPlayerId]);
    await client.query(`DELETE FROM feature_snapshot_provenance WHERE snapshot_id IN (
      SELECT snapshot_id FROM pregame_feature_snapshots WHERE player_id IN ($1, $2)
    )`, [FIXTURE.playerId, FIXTURE.otherPlayerId]);
    await client.query(`DELETE FROM pregame_feature_snapshots WHERE player_id IN ($1, $2)`, [FIXTURE.playerId, FIXTURE.otherPlayerId]);
    await client.query(`DELETE FROM games WHERE game_pk = $1`, [FIXTURE.gamePk]);
    await client.query(`DELETE FROM players WHERE player_id IN ($1, $2)`, [FIXTURE.playerId, FIXTURE.otherPlayerId]);
    await client.query(`DELETE FROM teams WHERE team_id IN ($1, $2)`, [FIXTURE.homeTeamId, FIXTURE.awayTeamId]);
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
     VALUES ('MLB_OFFICIAL', 'MLB Official', 'OFFICIAL'),
            ('FANTASYPROS', 'FantasyPros', 'PROJECTION')
     ON CONFLICT (source_id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name) VALUES
      ($1, 'F4BH', 'Phase 4B Home'), ($2, 'F4BA', 'Phase 4B Away')
     ON CONFLICT (team_id) DO NOTHING`,
    [FIXTURE.homeTeamId, FIXTURE.awayTeamId],
  );
  await pool.query(
    `INSERT INTO players (player_id, full_name) VALUES
      ($1, 'Phase 4B Batter'), ($2, 'Phase 4B Other Batter')
     ON CONFLICT (player_id) DO NOTHING`,
    [FIXTURE.playerId, FIXTURE.otherPlayerId],
  );
  await pool.query(
    `INSERT INTO games (game_pk, game_date, home_team_id, away_team_id, game_status)
     VALUES ($1, $2, $3, $4, 'Final')`,
    [FIXTURE.gamePk, FIXTURE.slateDate, FIXTURE.homeTeamId, FIXTURE.awayTeamId],
  );
  const snapshot = await pool.query(
    `INSERT INTO pregame_feature_snapshots
       (player_id, game_pk, slate_date, market, features, feature_hash, research_rank, research_state, primary_mechanism)
     VALUES ($1, $2, $3, 'EXTRA_BASE_HIT', '{"fixture":"phase-4b"}', 'phase-4b-fixture-hash', 3, 'POSITIVE', 'BARREL_POWER')
     RETURNING snapshot_id`,
    [FIXTURE.playerId, FIXTURE.gamePk, FIXTURE.slateDate],
  );
  snapshotId = snapshot.rows[0].snapshot_id;
  const run = await pool.query(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ('MLB_OFFICIAL', 'mlb-official-settlement', 'SUCCESS', $1)
     RETURNING ingest_run_id`,
    [FIXTURE.slateDate],
  );
  ingestRunId = run.rows[0].ingest_run_id;
  const outcome = await pool.query(
    `INSERT INTO historical_outcomes
       (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
        plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
        settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata, raw)
     VALUES ($1, $2, $3, 'EXTRA_BASE_HIT', 1, true,
             4, 3, 1, 1, 0, 0, 0,
             'SETTLED', now(), 'MLB_OFFICIAL',
             $4, '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}', '{}')
     RETURNING outcome_id`,
    [FIXTURE.playerId, FIXTURE.gamePk, FIXTURE.slateDate, ingestRunId],
  );
  outcomeId = outcome.rows[0].outcome_id;
}

describe("Phase 4B – Official Settlement and Postmortem Engine", () => {
  before(async () => {
    await cleanup();
    await setup();
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test("F1: official settlement stores full counts and excludes singles from XBH", async () => {
    const row = await pool.query(
      `SELECT singles, doubles, triples, home_runs, outcome_value, outcome_hit,
              settlement_state, source_id, official_source_metadata
       FROM historical_outcomes WHERE outcome_id = $1`,
      [outcomeId],
    );
    assert.equal(row.rows[0].singles, 1);
    assert.equal(row.rows[0].doubles, 1);
    assert.equal(row.rows[0].triples, 0);
    assert.equal(row.rows[0].home_runs, 0);
    assert.equal(Number(row.rows[0].outcome_value), 1, "XBH must be doubles + triples + home runs, never singles");
    assert.equal(row.rows[0].outcome_hit, true);
    assert.equal(row.rows[0].settlement_state, "SETTLED");
    assert.equal(row.rows[0].source_id, "MLB_OFFICIAL");
    assert.equal(row.rows[0].official_source_metadata.provider, "MLB Stats API");

    const route = await fetch(`${API}/api/analyst/settlements?gamePk=${FIXTURE.gamePk}&market=XBH`);
    assert.equal(route.status, 200);
    const body = await route.json();
    assert.equal(body.source, "MLB Official");
    assert.equal(body.total, 1);
    assert.equal(body.settlements[0].outcomeValue, 1);
    assert.equal(body.settlements[0].components.singles, 1);
    assert.equal(body.settlements[0].components.doubles, 1);

    const service = await import("node:fs/promises").then((fs) => fs.readFile("artifacts/api-server/src/services/settlement.ts", "utf8"));
    assert.match(service, /line\.doubles \+ line\.triples \+ line\.homeRuns/, "settlement ingest must calculate XBH from extra-base hits only");
    assert.match(service, /statsapi\.mlb\.com/, "settlement ingest must call MLB Stats API");
  });

  test("F2: FantasyPros is rejected as a settlement source", async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO historical_outcomes
           (player_id, game_pk, slate_date, market, outcome_value, outcome_hit, settlement_state, source_id)
         VALUES ($1, $2, $3, 'HOME_RUN', 0, false, 'SETTLED', 'FANTASYPROS')`,
        [FIXTURE.otherPlayerId, FIXTURE.gamePk, FIXTURE.slateDate],
      ),
      /MLB_OFFICIAL|historical_outcome_official_source|check constraint/i,
    );
  });

  test("F3: settled rows cannot change and correction rows require approved taxonomy", async () => {
    const originalOutcomeId = outcomeId;
    await assert.rejects(
      pool.query(`UPDATE historical_outcomes SET outcome_value = 2 WHERE outcome_id = $1`, [outcomeId]),
      /append-only|immutable/i,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO historical_outcomes
           (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
            settlement_state, source_id, ingest_run_id, official_source_metadata,
            correction_of, process_error_taxonomy)
         VALUES ($1, $2, $3, 'EXTRA_BASE_HIT', 0, false,
                 'SETTLED', 'MLB_OFFICIAL', $4,
                 '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}',
                 $5, 'NOT_A_TAXONOMY_CODE')`,
        [FIXTURE.playerId, FIXTURE.gamePk, FIXTURE.slateDate, ingestRunId, originalOutcomeId],
      ),
      /invalid input value for enum|process_error_taxonomy/i,
    );
    const correction = await pool.query(
      `INSERT INTO historical_outcomes
         (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
          settlement_state, source_id, ingest_run_id, official_source_metadata,
          correction_of, process_error_taxonomy, correction_note)
       VALUES ($1, $2, $3, 'EXTRA_BASE_HIT', 0, false,
               'SETTLED', 'MLB_OFFICIAL', $4,
               '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}',
               $5, 'DATA_INGEST_FAILURE', 'Official correction')
        RETURNING outcome_id, correction_of, process_error_taxonomy`,
      [FIXTURE.playerId, FIXTURE.gamePk, FIXTURE.slateDate, ingestRunId, originalOutcomeId],
    );
    assert.equal(correction.rows[0].correction_of, originalOutcomeId);
    assert.equal(correction.rows[0].process_error_taxonomy, "DATA_INGEST_FAILURE");
    outcomeId = correction.rows[0].outcome_id;
  });

  test("F4: AI writer context cannot create official settlements or postmortems", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.writer_context = 'AI'");
      await assert.rejects(
        client.query(
          `INSERT INTO historical_outcomes
             (player_id, game_pk, slate_date, market, outcome_value, outcome_hit, settlement_state, source_id)
           VALUES ($1, $2, $3, 'HOME_RUN', 0, false, 'SETTLED', 'MLB_OFFICIAL')`,
          [FIXTURE.otherPlayerId, FIXTURE.gamePk, FIXTURE.slateDate],
        ),
        /AI writers cannot write/i,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const postmortemClient = await pool.connect();
    try {
      await postmortemClient.query("BEGIN");
      await postmortemClient.query("SET LOCAL app.writer_context = 'AI'");
      await assert.rejects(
        postmortemClient.query(
          `INSERT INTO market_postmortems
             (snapshot_id, outcome_id, player_id, game_pk, market, snapshot_feature_hash, outcome_value, outcome_hit)
           VALUES ($1, $2, $3, $4, 'EXTRA_BASE_HIT', 'phase-4b-fixture-hash', 1, true)`,
          [snapshotId, outcomeId, FIXTURE.playerId, FIXTURE.gamePk],
        ),
        /AI writers cannot write/i,
      );
      await postmortemClient.query("ROLLBACK");
    } finally {
      postmortemClient.release();
    }
  });

  test("F5: postmortems require a matching SETTLED outcome and are immutable", async () => {
    const created = await fetch(`${API}/api/analyst/postmortems`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId, outcomeId, notes: "Official final result." }),
    });
    assert.equal(created.status, 201);
    const postmortem = await created.json();
    assert.equal(postmortem.snapshotId, snapshotId);
    assert.equal(postmortem.outcomeId, outcomeId);
    assert.equal(postmortem.market, "XBH");
    assert.equal(postmortem.outcomeValue, 0, "postmortems must use the current corrected official outcome");

    const rejectedPayload = await fetch(`${API}/api/analyst/postmortems`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId, outcomeId, sportsbook: "not permitted" }),
    });
    assert.equal(rejectedPayload.status, 400, "arbitrary betting payload fields must be rejected");

    await assert.rejects(
      pool.query(`UPDATE market_postmortems SET notes = 'tampered' WHERE postmortem_id = $1`, [postmortem.postmortemId]),
      /market_postmortems is immutable/i,
    );
    const listed = await fetch(`${API}/api/analyst/postmortems?playerId=${FIXTURE.playerId}&market=XBH`);
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.equal(listBody.total, 1);
    assert.equal(listBody.postmortems[0].postmortemId, postmortem.postmortemId);
  });

  test("F6: one settled original is canonical and malformed refresh dates are rejected", async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO historical_outcomes
           (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
            settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata)
         VALUES ($1, $2, $3, 'EXTRA_BASE_HIT', 1, true,
                 'SETTLED', now(), 'MLB_OFFICIAL', $4,
                 '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}')`,
        [FIXTURE.playerId, FIXTURE.gamePk, FIXTURE.slateDate, ingestRunId],
      ),
      /historical_outcomes_settled_original_idx|duplicate key/i,
    );
    const invalidDate = await fetch(`${API}/api/analyst/settlement/refresh?date=2026-99-99`, { method: "POST" });
    assert.equal(invalidDate.status, 400);
    const service = await import("node:fs/promises").then((fs) => fs.readFile("artifacts/api-server/src/services/settlement.ts", "utf8"));
    assert.match(service, /pg_advisory_xact_lock/, "settlement refresh must serialize each game transaction");
  });

  test("F7: players without a plate appearance are retained as NO_ACTION, not losses", async () => {
    const noAction = await pool.query(
      `INSERT INTO historical_outcomes
         (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
          plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
          settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata)
       VALUES ($1, $2, $3, 'HOME_RUN', 0, false,
               0, 0, 0, 0, 0, 0, 0,
               'NO_ACTION', now(), 'MLB_OFFICIAL', $4,
               '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}')
       RETURNING outcome_id`,
      [FIXTURE.otherPlayerId, FIXTURE.gamePk, FIXTURE.slateDate, ingestRunId],
    );
    assert.ok(noAction.rows[0].outcome_id);
    const response = await fetch(`${API}/api/analyst/settlements?gamePk=${FIXTURE.gamePk}&playerId=${FIXTURE.otherPlayerId}&market=HR`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 1);
    assert.equal(body.settlements[0].settlementState, "NO_ACTION");
    assert.equal(body.settlements[0].outcomeHit, false);

    const service = await import("node:fs/promises").then((fs) => fs.readFile("artifacts/api-server/src/services/settlement.ts", "utf8"));
    assert.match(service, /observed && observed\.plateAppearances > 0 \? "SETTLED" : "NO_ACTION"/);
    assert.match(service, /"POSTPONED"/);
  });
});