/**
 * Phase 3 – Shared Market Research Contract Acceptance Tests
 *
 * Verifies:
 *  A1  GET /api/analyst/market-research returns 200 with required contract shape
 *  A2  Response contains rankSemantics and prohibitedFields arrays (never ev/clv/odds)
 *  A3  All four markets (TB, XBH, WALK, HR) can be written to and read from the DB
 *  A4  All five research states (STRONG, POSITIVE, NEUTRAL, NEGATIVE, BLOCKED) round-trip correctly
 *  A5  Market filter (?market=TB) returns only TB candidates
 *  A6  Game filter (?gameId=) returns only candidates for that game
 *  A7  Prohibited analytics fields are absent from the API response
 *  A8  DB schema enforces market enum — invalid market value is rejected
 *  A9  DB schema enforces research_state enum — invalid state is rejected
 *  A10 Candidates table unique constraint prevents duplicate player-market-game rows
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const BASE = "http://127.0.0.1:8080";
const today = new Date().toISOString().slice(0, 10);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensurePlayer(playerId, name) {
  await pool.query(
    `INSERT INTO players (player_id, full_name, primary_position)
     VALUES ($1, $2, 'H')
     ON CONFLICT (player_id) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = now()`,
    [playerId, name],
  );
}

async function ensureGame(gamePk, gameDate) {
  // Need away and home team IDs that actually exist
  const teamResult = await pool.query(`SELECT team_id FROM teams LIMIT 2`);
  if (teamResult.rows.length < 2) return null; // skip if no teams in DB
  const awayId = teamResult.rows[0].team_id;
  const homeId = teamResult.rows[1].team_id;
  await pool.query(
    `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (game_pk) DO NOTHING`,
    [gamePk, gameDate, awayId, homeId],
  );
  return { gamePk, awayId, homeId };
}

async function insertCandidate({ gamePk, playerId, market, researchRank, researchState, slateDate }) {
  const result = await pool.query(
    `INSERT INTO market_research_candidates
       (slate_date, game_pk, player_id, market, research_rank, research_state)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slate_date, market, player_id, game_pk) DO UPDATE SET
       research_rank = EXCLUDED.research_rank,
       research_state = EXCLUDED.research_state,
       updated_at = now()
     RETURNING candidate_id`,
    [slateDate ?? today, gamePk, playerId, market, researchRank, researchState],
  );
  return result.rows[0].candidate_id;
}

async function cleanupCandidates(playerId) {
  await pool.query(`DELETE FROM market_research_candidates WHERE player_id = $1`, [playerId]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("A1: GET /api/analyst/market-research returns 200 with contract shape", async () => {
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${today}`);
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert.ok(typeof body.date === "string", "date must be a string");
  assert.ok(Array.isArray(body.candidates), "candidates must be an array");
  assert.ok(typeof body.candidateCount === "number", "candidateCount must be a number");
  assert.equal(body.candidateCount, body.candidates.length, "candidateCount must match candidates.length");
  assert.ok(typeof body.rankSemantics === "string", "rankSemantics must be a string");
  assert.ok(Array.isArray(body.prohibitedFields), "prohibitedFields must be an array");
  assert.ok(typeof body.systemNote === "string", "systemNote must be a string");
});

test("A2: rankSemantics encodes RANK_DONT_GATE and prohibitedFields contains ev/clv/odds", async () => {
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${today}`);
  const body = await res.json();
  assert.ok(body.rankSemantics.includes("RANK_DONT_GATE"), "rankSemantics must include RANK_DONT_GATE");
  assert.ok(body.rankSemantics.toLowerCase().includes("ordinal"), "rankSemantics must mention ordinal");
  const prohibited = body.prohibitedFields.map((f) => f.toLowerCase());
  assert.ok(prohibited.includes("ev"), "prohibitedFields must include 'ev'");
  assert.ok(prohibited.includes("clv"), "prohibitedFields must include 'clv'");
  assert.ok(prohibited.includes("odds"), "prohibitedFields must include 'odds'");
  assert.ok(prohibited.some((f) => f.includes("implied")), "prohibitedFields must include implied probability");
});

test("A3: All four markets (TB, XBH, WALK, HR) can be written to and read from the DB", async () => {
  const testPlayerId = 9999901;
  const testGamePk = 799990001;
  await ensurePlayer(testPlayerId, "Phase3 Contract Test Player");
  const gameResult = await ensureGame(testGamePk, today);
  if (!gameResult) { return; } // skip if no team fixture

  const dbMarkets = ["TOTAL_BASES_2_PLUS", "EXTRA_BASE_HIT", "BATTER_WALK", "HOME_RUN"];
  const apiMarkets = ["TB", "XBH", "WALK", "HR"];

  for (let i = 0; i < dbMarkets.length; i++) {
    await insertCandidate({
      gamePk: testGamePk, playerId: testPlayerId,
      market: dbMarkets[i], researchRank: i + 1, researchState: "NEUTRAL",
    });
  }

  // Verify via API — all markets appear
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${today}`);
  const body = await res.json();
  const playerCandidates = body.candidates.filter((c) => c.playerId === testPlayerId);
  const foundMarkets = new Set(playerCandidates.map((c) => c.market));
  for (const apiMarket of apiMarkets) {
    assert.ok(foundMarkets.has(apiMarket), `Market ${apiMarket} should appear in response`);
  }

  // Verify DB enum uses full enum names, not shortcodes
  const dbResult = await pool.query(
    `SELECT market FROM market_research_candidates WHERE player_id = $1`,
    [testPlayerId],
  );
  const dbMarketValues = new Set(dbResult.rows.map((r) => r.market));
  for (const dbMarket of dbMarkets) {
    assert.ok(dbMarketValues.has(dbMarket), `DB should store enum value '${dbMarket}'`);
  }

  await cleanupCandidates(testPlayerId);
});

test("A4: All five research states round-trip correctly through DB and API", async () => {
  const testPlayerId = 9999902;
  const testGamePk = 799990002;
  await ensurePlayer(testPlayerId, "Phase3 ResearchState Test");
  const gameResult = await ensureGame(testGamePk, today);
  if (!gameResult) { return; }

  const states = ["STRONG", "POSITIVE", "NEUTRAL", "NEGATIVE", "BLOCKED"];
  const markets = ["TOTAL_BASES_2_PLUS", "EXTRA_BASE_HIT", "BATTER_WALK", "HOME_RUN", "TOTAL_BASES_2_PLUS"];
  // Use different players for each state to avoid unique constraint
  const playerIds = [9999902, 9999903, 9999904, 9999905, 9999906];
  for (let i = 0; i < states.length; i++) {
    await ensurePlayer(playerIds[i], `Phase3 State Test ${states[i]}`);
    await insertCandidate({
      gamePk: testGamePk, playerId: playerIds[i],
      market: markets[i], researchRank: i + 1, researchState: states[i],
    });
  }

  // Verify all states appear in API response
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${today}`);
  const body = await res.json();
  const foundStates = new Set(
    body.candidates
      .filter((c) => playerIds.includes(c.playerId))
      .map((c) => c.researchState),
  );
  for (const state of states) {
    assert.ok(foundStates.has(state), `Research state '${state}' should round-trip through DB and API`);
  }

  // Cleanup
  for (const pid of playerIds) {
    await pool.query(`DELETE FROM market_research_candidates WHERE player_id = $1`, [pid]);
  }
});

test("A5: Market filter ?market=TB returns only TB candidates", async () => {
  const testPlayerId = 9999910;
  const testGamePk = 799990010;
  await ensurePlayer(testPlayerId, "Phase3 MarketFilter Test");
  const gameResult = await ensureGame(testGamePk, today);
  if (!gameResult) { return; }

  await insertCandidate({ gamePk: testGamePk, playerId: testPlayerId, market: "TOTAL_BASES_2_PLUS", researchRank: 1, researchState: "POSITIVE" });
  await pool.query(`DELETE FROM market_research_candidates WHERE player_id = $1 AND market != 'TOTAL_BASES_2_PLUS'`, [testPlayerId]);

  const res = await fetch(`${BASE}/api/analyst/market-research?date=${today}&market=TB`);
  const body = await res.json();
  assert.equal(body.market, "TB", "Response market should echo filter param");
  for (const c of body.candidates) {
    assert.equal(c.market, "TB", `All candidates must have market=TB, got '${c.market}'`);
  }

  await cleanupCandidates(testPlayerId);
});

test("A6: gameId filter returns only candidates for that game", async () => {
  const testPlayerId = 9999911;
  const testGamePk = 799990011;
  const otherGamePk = 799990012;
  await ensurePlayer(testPlayerId, "Phase3 GameFilter Test");
  const gameResult = await ensureGame(testGamePk, today);
  const otherGame = await ensureGame(otherGamePk, today);
  if (!gameResult || !otherGame) { return; }

  await insertCandidate({ gamePk: testGamePk, playerId: testPlayerId, market: "HOME_RUN", researchRank: 1, researchState: "NEUTRAL" });

  const res = await fetch(`${BASE}/api/analyst/market-research?date=${today}&gameId=${testGamePk}`);
  const body = await res.json();
  assert.equal(body.gameId, String(testGamePk), "Response should echo gameId filter");
  for (const c of body.candidates) {
    assert.equal(c.gamePk, testGamePk, `All candidates must have gamePk=${testGamePk}`);
  }

  await cleanupCandidates(testPlayerId);
});

/**
 * Recursively collect all object keys at any depth within a value.
 */
function collectKeys(val) {
  const keys = new Set();
  function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) { keys.add(k); walk(child); }
    }
  }
  walk(val);
  return keys;
}

test("A7: Prohibited analytics fields are absent from response — including nested inside evidence JSONB", async () => {
  // First, insert a candidate with prohibited keys nested inside evidence payloads
  const testPlayerId = 9999940;
  const testGamePk = 799990040;
  await ensurePlayer(testPlayerId, "Phase3 ProhibitedNested Test");
  const gameResult = await ensureGame(testGamePk, today);
  if (!gameResult) { return; }

  // Write a candidate with prohibited keys buried in JSONB evidence
  await pool.query(
    `INSERT INTO market_research_candidates
       (slate_date, game_pk, player_id, market, research_state, opportunity_evidence, counter_evidence)
     VALUES ($1, $2, $3, 'HOME_RUN', 'NEUTRAL',
       $4::jsonb, $5::jsonb)
     ON CONFLICT (slate_date, market, player_id, game_pk) DO UPDATE SET
       opportunity_evidence = EXCLUDED.opportunity_evidence,
       counter_evidence = EXCLUDED.counter_evidence,
       updated_at = now()`,
    [
      today, testGamePk, testPlayerId,
      JSON.stringify({ xba: 0.42, ev: 99.5, clv: 2.1, nested: { odds: "110", kellyFraction: 0.04 } }),
      JSON.stringify({ impliedProbability: 0.47, vigJuice: 0.05 }),
    ],
  );

  const res = await fetch(`${BASE}/api/analyst/market-research?date=${today}`);
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await res.json();

  const prohibited = ["ev", "clv", "odds", "impliedProbability", "vigJuice",
    "edgePercent", "kellyFraction", "expectedValue"];
  const prohibitedLower = new Set(prohibited.map((k) => k.toLowerCase()));

  // Check top-level response
  for (const field of prohibited) {
    assert.ok(!(field in body), `Prohibited field '${field}' must not appear at top level`);
  }

  // Check all candidates including the one we just inserted
  const target = body.candidates.find((c) => c.playerId === testPlayerId);
  assert.ok(target, "Test candidate must appear in response");

  for (const c of body.candidates) {
    // Direct candidate properties
    for (const field of prohibited) {
      assert.ok(!(field in c), `Prohibited field '${field}' must not appear on candidate object`);
    }
    // Recursive check inside all evidence payloads
    const evidenceFields = [
      c.opportunityEvidence, c.starterMatchupEvidence, c.bullpenPathEvidence,
      c.parkEvidence, c.recentVsSeasonVsCareer, c.counterEvidence,
    ];
    const allNestedKeys = collectKeys(evidenceFields);
    for (const k of allNestedKeys) {
      assert.ok(
        !prohibitedLower.has(k.toLowerCase()),
        `Prohibited key '${k}' found nested inside evidence payload of candidate ${c.candidateId}`,
      );
    }
  }

  // Verify non-prohibited evidence keys (like xba) survived the sanitization
  assert.ok(
    "xba" in (target?.opportunityEvidence ?? {}),
    "Legitimate evidence key 'xba' must survive sanitization",
  );

  await cleanupCandidates(testPlayerId);
});

test("A8: DB schema rejects invalid market enum value", async () => {
  const testPlayerId = 9999920;
  const testGamePk = 799990020;
  await ensurePlayer(testPlayerId, "Phase3 EnumReject Test");
  const gameResult = await ensureGame(testGamePk, today);
  if (!gameResult) { return; }

  await assert.rejects(
    () => pool.query(
      `INSERT INTO market_research_candidates (slate_date, game_pk, player_id, market, research_state)
       VALUES ($1, $2, $3, 'INVALID_MARKET', 'NEUTRAL')`,
      [today, testGamePk, testPlayerId],
    ),
    (err) => {
      // PostgreSQL raises a 22P02 (invalid_text_representation) or 42804 for invalid enum
      return err.message.toLowerCase().includes("invalid") || err.code === "22P02" || err.code === "42804";
    },
    "Invalid market enum value should be rejected by DB",
  );
});

test("A9: DB schema rejects invalid research_state enum value", async () => {
  const testPlayerId = 9999921;
  const testGamePk = 799990021;
  await ensurePlayer(testPlayerId, "Phase3 StateEnumReject Test");
  const gameResult = await ensureGame(testGamePk, today);
  if (!gameResult) { return; }

  await assert.rejects(
    () => pool.query(
      `INSERT INTO market_research_candidates (slate_date, game_pk, player_id, market, research_state)
       VALUES ($1, $2, $3, 'TOTAL_BASES_2_PLUS', 'FIRE')`,
      [today, testGamePk, testPlayerId],
    ),
    (err) => {
      return err.message.toLowerCase().includes("invalid") || err.code === "22P02" || err.code === "42804";
    },
    "Invalid research_state enum value should be rejected by DB",
  );
});

test("A10: Unique constraint prevents duplicate player-market-slate_date-game rows", async () => {
  const testPlayerId = 9999930;
  const testGamePk = 799990030;
  await ensurePlayer(testPlayerId, "Phase3 UniqueConstraint Test");
  const gameResult = await ensureGame(testGamePk, today);
  if (!gameResult) { return; }

  // First insert should succeed
  await pool.query(
    `INSERT INTO market_research_candidates (slate_date, game_pk, player_id, market, research_state)
     VALUES ($1, $2, $3, 'BATTER_WALK', 'NEUTRAL')`,
    [today, testGamePk, testPlayerId],
  );

  // Second insert with same (slate_date, market, player_id, game_pk) must raise unique violation
  await assert.rejects(
    () => pool.query(
      `INSERT INTO market_research_candidates (slate_date, game_pk, player_id, market, research_state)
       VALUES ($1, $2, $3, 'BATTER_WALK', 'POSITIVE')`,
      [today, testGamePk, testPlayerId],
    ),
    (err) => err.code === "23505",
    "Duplicate candidate insert must raise unique constraint violation (23505)",
  );

  await cleanupCandidates(testPlayerId);
});

// Cleanup pool on exit
process.on("exit", () => pool.end());
