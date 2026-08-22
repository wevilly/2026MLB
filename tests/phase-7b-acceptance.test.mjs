/**
 * Phase 7B – Bettor Intelligence Evaluation and Dashboard
 *
 * Proves that settled, official outcomes drive source evaluation, likely
 * copied picks receive less independent weight, and each market remains
 * isolated. Bettor records are observational only: no model or confidence
 * table is touched by this suite.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const API = "http://127.0.0.1:8080";
const DATE = "2026-12-14";
const FIXTURE = {
  players: [9999721, 9999722, 9999723, 9999724, 9999725],
  teams: [9990621, 9990622],
  games: [9998621, 9998622, 9998623, 9998624, 9998625, 9998626],
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let alpha;
let beta;
let settlementRunId;

async function createSource(accountHandle) {
  const response = await fetch(`${API}/api/analyst/bettor/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "Phase 7B Acceptance", accountHandle }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function ingest(payload) {
  const response = await fetch(`${API}/api/analyst/bettor/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.bypass_immutability = 'true'");
    await client.query(`DELETE FROM pick_duplication_lineage
      WHERE pick_id IN (SELECT pick_id FROM bettor_picks WHERE player_id = ANY($1::int[]))
         OR prior_pick_id IN (SELECT pick_id FROM bettor_picks WHERE player_id = ANY($1::int[]))`, [FIXTURE.players]);
    await client.query("DELETE FROM bettor_picks WHERE player_id = ANY($1::int[])", [FIXTURE.players]);
    await client.query("DELETE FROM bettor_sources WHERE platform = 'Phase 7B Acceptance'");
    await client.query("DELETE FROM historical_outcomes WHERE player_id = ANY($1::int[])", [FIXTURE.players]);
    await client.query("DELETE FROM games WHERE game_pk = ANY($1::bigint[])", [FIXTURE.games]);
    await client.query("DELETE FROM players WHERE player_id = ANY($1::int[])", [FIXTURE.players]);
    await client.query("DELETE FROM teams WHERE team_id = ANY($1::int[])", [FIXTURE.teams]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
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
      ($1, 'P7BH', 'Phase 7B Home'), ($2, 'P7BA', 'Phase 7B Away')`,
    FIXTURE.teams,
  );
  await pool.query(
    `INSERT INTO players (player_id, full_name) VALUES
      ($1, 'Phase 7B Independent'), ($2, 'Phase 7B Copied'), ($3, 'Phase 7B Walk'),
      ($4, 'Phase 7B Late Post'), ($5, 'Phase 7B Unknown Start')`,
    FIXTURE.players,
  );
  for (const [index, gamePk] of FIXTURE.games.entries()) {
    await pool.query(
      `INSERT INTO games (game_pk, game_date, start_time_utc, home_team_id, away_team_id, game_status)
       VALUES ($1, $2, $3, $4, $5, 'Final')`,
      [gamePk, DATE, index === 5 ? null : "2026-12-14T15:00:00.000Z", FIXTURE.teams[0], FIXTURE.teams[1]],
    );
  }
  const run = await pool.query(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ('MLB_OFFICIAL', 'mlb-official-settlement', 'SUCCESS', $1)
     RETURNING ingest_run_id`,
    [DATE],
  );
  settlementRunId = run.rows[0].ingest_run_id;
  for (const [playerId, gamePk, market, value, hit] of [
    [FIXTURE.players[0], FIXTURE.games[0], "HOME_RUN", 1, true],
    [FIXTURE.players[1], FIXTURE.games[1], "HOME_RUN", 1, true],
    [FIXTURE.players[2], FIXTURE.games[2], "BATTER_WALK", 1, true],
    [FIXTURE.players[0], FIXTURE.games[3], "HOME_RUN", 0, false],
    [FIXTURE.players[3], FIXTURE.games[4], "HOME_RUN", 1, true],
    [FIXTURE.players[4], FIXTURE.games[5], "HOME_RUN", 1, true],
  ]) {
    await pool.query(
      `INSERT INTO historical_outcomes
         (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
          plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
          settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata, raw)
       VALUES ($1, $2, $3, $4, $5, $6,
               4, 3, 0, 0, 0, 0, 0,
               'SETTLED', now(), 'MLB_OFFICIAL', $7,
               '{"provider":"MLB Stats API","endpoint":"https://statsapi.mlb.com/fixture"}', '{}')`,
      [playerId, gamePk, DATE, market, value, hit, settlementRunId],
    );
  }

  alpha = await createSource("@evaluation-alpha");
  beta = await createSource("@evaluation-beta");
  await ingest({
    sourceId: alpha.sourceId,
    slateDate: DATE,
    playerId: FIXTURE.players[0],
    market: "HR",
    pickDirection: "YES",
    mechanismTags: ["BARREL_POWER"],
    reasoning: "Independent barrel power support.",
    postedAt: "2026-12-14T12:00:00.000Z",
  });
  await ingest({
    sourceId: alpha.sourceId,
    slateDate: DATE,
    playerId: FIXTURE.players[1],
    market: "HR",
    pickDirection: "YES",
    mechanismTags: ["PULL_AIR"],
    reasoning: "Lift and pull profile support the homer path.",
    postedAt: "2026-12-14T13:00:00.000Z",
  });
  await ingest({
    sourceId: beta.sourceId,
    slateDate: DATE,
    playerId: FIXTURE.players[1],
    market: "HR",
    pickDirection: "YES",
    mechanismTags: ["PULL_AIR"],
    reasoning: "Lift and pull profile support the homer path.",
    postedAt: "2026-12-14T14:00:00.000Z",
  });
  await ingest({
    sourceId: alpha.sourceId,
    slateDate: DATE,
    playerId: FIXTURE.players[2],
    market: "WALK",
    pickDirection: "NO",
    mechanismTags: ["PATIENCE_VS_COMMAND"],
    reasoning: "This is intentionally a NO-direction walk pick.",
    postedAt: "2026-12-14T13:30:00.000Z",
  });
  await ingest({
    sourceId: beta.sourceId,
    slateDate: DATE,
    playerId: FIXTURE.players[3],
    market: "HR",
    pickDirection: "YES",
    mechanismTags: ["HOME_RUN_ROUTE"],
    reasoning: "This pick is intentionally posted after first pitch.",
    postedAt: "2026-12-14T16:00:00.000Z",
  });
  await ingest({
    sourceId: alpha.sourceId,
    slateDate: DATE,
    playerId: FIXTURE.players[4],
    market: "HR",
    pickDirection: "YES",
    mechanismTags: ["MULTI_PATH"],
    reasoning: "This pick has no known first-pitch time.",
    postedAt: "2026-12-14T12:00:00.000Z",
  });
}

describe("Phase 7B – Bettor Intelligence Evaluation and Dashboard", () => {
  before(async () => {
    await cleanup();
    await setup();
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test("down-weights likely copied picks in the effective count and independence score", async () => {
    const response = await fetch(`${API}/api/analyst/bettor/evaluation?market=HR`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const alphaRecord = body.records.find((record) => record.sourceId === alpha.sourceId && record.mechanism === "PULL_AIR");
    const betaRecord = body.records.find((record) => record.sourceId === beta.sourceId && record.mechanism === "PULL_AIR");
    assert.equal(body.evaluationWindow, "ALL_SETTLED");
    assert.equal(alphaRecord.settledPickCount, 1);
    assert.equal(alphaRecord.independenceScore, 1);
    assert.equal(betaRecord.settledPickCount, 1);
    assert.equal(betaRecord.duplicationAdjustedCount, 0.25);
    assert.equal(betaRecord.independenceScore, 0.25);
    assert.ok(betaRecord.independenceScore < alphaRecord.independenceScore);
    assert.equal(betaRecord.outcomeRate, 1, "copy weighting does not change the direction-aware official result");
  });

  test("does not score ambiguous doubleheaders or picks posted after first pitch", async () => {
    const response = await fetch(`${API}/api/analyst/bettor/evaluation?market=HR`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const ambiguous = body.records.find((record) => record.sourceId === alpha.sourceId && record.mechanism === "BARREL_POWER");
    const late = body.records.find((record) => record.sourceId === beta.sourceId && record.mechanism === "HOME_RUN_ROUTE");
    assert.equal(ambiguous.pickCount, 1);
    assert.equal(ambiguous.settledPickCount, 0, "a player with two eligible game outcomes is not scored without game identity");
    assert.equal(late.pickCount, 1);
    assert.equal(late.settledPickCount, 0, "a post-first-pitch pick is observational but ineligible for scoring");
    const unknownStart = body.records.find((record) => record.sourceId === alpha.sourceId && record.mechanism === "MULTI_PATH");
    assert.equal(unknownStart.settledPickCount, 0, "a missing first-pitch time is not eligible for scoring");
    const ambiguousPick = body.picks.find((pick) => pick.playerId === FIXTURE.players[0]);
    assert.equal(ambiguousPick.settledOutcome, null);
    assert.match(ambiguousPick.slateDate, /^\d{4}-\d{2}-\d{2}$/, "slate dates remain date-only on the wire");
  });

  test("keeps markets independent and scores NO directions against official outcomes", async () => {
    const hrResponse = await fetch(`${API}/api/analyst/bettor/evaluation?sourceId=${alpha.sourceId}&market=HR`);
    assert.equal(hrResponse.status, 200);
    const hrBody = await hrResponse.json();
    assert.ok(hrBody.records.length > 0);
    assert.ok(hrBody.records.every((record) => record.market === "HR"));
    assert.ok(hrBody.picks.every((pick) => pick.market === "HR"));

    const walkResponse = await fetch(`${API}/api/analyst/bettor/evaluation?sourceId=${alpha.sourceId}&market=WALK`);
    assert.equal(walkResponse.status, 200);
    const walkBody = await walkResponse.json();
    assert.equal(walkBody.records.length, 1);
    assert.equal(walkBody.records[0].market, "WALK");
    assert.equal(walkBody.picks[0].pickDirection, "NO");
    assert.equal(walkBody.picks[0].settledOutcome.outcomeHit, true);
    assert.equal(walkBody.picks[0].predictionCorrect, false);
  });

  test("rejects invalid evaluation filters and never writes model or confidence tables", async () => {
    const invalid = await fetch(`${API}/api/analyst/bettor/evaluation?sourceId=not-a-uuid`);
    assert.equal(invalid.status, 400);
    const [models, boards] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM model_versions"),
      pool.query("SELECT count(*)::int AS count FROM daily_market_board"),
    ]);
    const response = await fetch(`${API}/api/analyst/bettor/evaluation`);
    assert.equal(response.status, 200);
    const [modelsAfter, boardsAfter] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM model_versions"),
      pool.query("SELECT count(*)::int AS count FROM daily_market_board"),
    ]);
    assert.equal(modelsAfter.rows[0].count, models.rows[0].count);
    assert.equal(boardsAfter.rows[0].count, boards.rows[0].count);
  });
});