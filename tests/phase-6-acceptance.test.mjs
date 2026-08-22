/**
 * Phase 6 – Daily Market Rankings and Confidence Board
 *
 * Covers the persisted server-side board contract without introducing any
 * betting-derived fields. This fixture intentionally has no ACTIVE model, so
 * every market must remain NONE / RESEARCH_ONLY.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const API = "http://127.0.0.1:8080";
const DATE = "2026-12-01";
const FIXTURE = { teamAway: 9999601, teamHome: 9999602, player: 9999603, game: 9999604 };
const prohibited = /odds|price|ev|clv|implied|vig|juice|kelly|edge|recommend/i;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function cleanup() {
  await pool.query("DELETE FROM daily_market_board WHERE slate_date = $1", [DATE]);
  await pool.query("DELETE FROM market_research_candidates WHERE slate_date = $1", [DATE]);
  await pool.query("DELETE FROM games WHERE game_pk = $1", [FIXTURE.game]);
  await pool.query("DELETE FROM players WHERE player_id = $1", [FIXTURE.player]);
  await pool.query("DELETE FROM teams WHERE team_id IN ($1, $2)", [FIXTURE.teamAway, FIXTURE.teamHome]);
}

async function setup() {
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name, active) VALUES
       ($1, 'P6A', 'Phase 6 Away', true), ($2, 'P6H', 'Phase 6 Home', true)
     ON CONFLICT (team_id) DO NOTHING`,
    [FIXTURE.teamAway, FIXTURE.teamHome],
  );
  await pool.query(
    `INSERT INTO players (player_id, full_name, active) VALUES ($1, 'Phase 6 Batter', true)
     ON CONFLICT (player_id) DO NOTHING`,
    [FIXTURE.player],
  );
  await pool.query(
    `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id, game_status)
     VALUES ($1, $2, $3, $4, 'Scheduled')`,
    [FIXTURE.game, DATE, FIXTURE.teamAway, FIXTURE.teamHome],
  );
  for (const market of ["TOTAL_BASES_2_PLUS", "EXTRA_BASE_HIT", "BATTER_WALK", "HOME_RUN"]) {
    await pool.query(
      `INSERT INTO market_research_candidates
         (slate_date, game_pk, player_id, market, research_rank, research_state, primary_mechanism)
       VALUES ($1, $2, $3, $4, 1, 'STRONG', 'PHASE_6_FIXTURE')`,
      [DATE, FIXTURE.game, FIXTURE.player, market],
    );
  }
}

describe("Phase 6 – Daily Market Rankings and Confidence Board", () => {
  before(async () => { await cleanup(); await setup(); });
  after(async () => { await cleanup(); await pool.end(); });

  test("persists four independent markets and never invents FIRE without ACTIVE calibration", async () => {
    const refresh = await fetch(`${API}/api/analyst/market-board/refresh?date=${DATE}`, { method: "POST" });
    assert.equal(refresh.status, 201);
    const refreshBody = await refresh.json();
    assert.equal(refreshBody.candidatesFound, 4);
    assert.equal(refreshBody.modeledRows, 0);

    const response = await fetch(`${API}/api/analyst/market-board?date=${DATE}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 4);
    assert.deepEqual(body.entries.map((entry) => entry.market).sort(), ["HR", "TB", "WALK", "XBH"]);
    for (const entry of body.entries) {
      assert.equal(entry.confidenceLabel, "NONE");
      assert.equal(entry.confidenceBasis, "RESEARCH_ONLY");
      assert.equal(entry.modelPrediction, null);
      assert.equal(entry.calibratedProbability, null);
      assert.equal(prohibited.test(JSON.stringify(entry)), false);
    }
  });

  test("refresh is idempotent, removes obsolete candidates, and game summary contains only baseball context", async () => {
    const first = await fetch(`${API}/api/analyst/market-board/refresh?date=${DATE}`, { method: "POST" });
    const second = await fetch(`${API}/api/analyst/market-board/refresh?date=${DATE}`, { method: "POST" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const count = await pool.query("SELECT count(*)::int AS count FROM daily_market_board WHERE slate_date = $1", [DATE]);
    assert.equal(count.rows[0].count, 4);

    await pool.query(
      `DELETE FROM market_research_candidates
        WHERE slate_date = $1 AND market = 'HOME_RUN' AND player_id = $2 AND game_pk = $3`,
      [DATE, FIXTURE.player, FIXTURE.game],
    );
    const reconciliation = await fetch(`${API}/api/analyst/market-board/refresh?date=${DATE}`, { method: "POST" });
    assert.equal(reconciliation.status, 201);
    const reconciledCount = await pool.query("SELECT count(*)::int AS count FROM daily_market_board WHERE slate_date = $1", [DATE]);
    assert.equal(reconciledCount.rows[0].count, 3, "a removed research candidate must not remain on the board");

    const response = await fetch(`${API}/api/analyst/market-board/game-summary?date=${DATE}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 1);
    assert.equal(body.games[0].gamePk, FIXTURE.game);
    assert.equal(body.games[0].awayTeam, "P6A");
    assert.equal(body.games[0].homeTeam, "P6H");
    assert.equal(body.games[0].bullpenContext.awayAvailableArms, 0);
    assert.equal(prohibited.test(JSON.stringify(body)), false);
  });

  test("rejects malformed calendar dates with a client error", async () => {
    const response = await fetch(`${API}/api/analyst/market-board?date=2026-99-99`);
    assert.equal(response.status, 400);
  });
});