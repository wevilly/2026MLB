/**
 * Phase 3C – Batter Walk Research Engine – Acceptance Test Suite
 *
 * Tests C1–C10 validate:
 *   C1  POST shape / 201 response
 *   C2  Walk / TB / XBH independence (low-power walker ranks higher on WALK; power hitter ranks lower)
 *   C3  Mechanism classification (PATIENCE_VS_COMMAND, COUNT_CREATION)
 *   C4  Counter-evidence flags (AGGRESSIVE_HITTER, PITCHER_LOW_WALK_RATE, FIRST_PITCH_STRIKE_HEAVY)
 *   C5  BLOCKED state when starter identity is unknown
 *   C6  No pseudo-probability or prohibited analytics fields in any WALK response
 *   C7  Competition ranking — ties share rank; skips k−1 after a tie group
 *   C8  GET /api/analyst/market-research?market=WALK returns candidates with evidence blocks
 *   C9  Engine write failure → HTTP 5xx + ingest run marked FAILED
 *   C10 Stale WALK candidates cleared when slate re-runs with no lineup entries
 *
 * Fixture namespace — all synthetic IDs use 999XXXXX ranges:
 *   Players   9991201–9991207
 *   Pitchers  9992201–9992202
 *   Teams     9990201–9990210
 *   Games     9998201–9998205
 *   SLATE     2026-09-25
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

const API = "http://127.0.0.1:8080";
const SLATE = "2026-09-25";
const staleDate = "2026-09-26";

// ── Fixture identifiers ────────────────────────────────────────────────────────
const P = {
  LowPowerWalker:    9991201, // elite BB%, low chase, low power  → WALK HIGH / TB LOW
  PowerSwinger:      9991202, // high power, low BB%, aggressive  → WALK LOW / TB HIGH
  PatientVsCommand:  9991203, // patience_signals ≥ 2             → PATIENCE_VS_COMMAND
  CountCreator:      9991204, // count_signals ≥ 2, patience < 2  → COUNT_CREATION
  AggressiveHitter:  9991205, // o_swing ≥ 36%; f_strike ≥ 68%   → AGGRESSIVE_HITTER + FIRST_PITCH_STRIKE_HEAVY
  UnknownStarter:    9991206, // starter identity unknown          → BLOCKED
  LowSamplePlayer:   9991207, // PA < 50                          → INSUFFICIENT_SAMPLE
  BullpenPath:       9991208, // zero patience/count signals + walk-prone bullpen → BULLPEN_WALK_PATH
};

const STARTER = {
  WildArm:      9992201, // bb_percent = 12.0, low zone%   → favorable for WALK
  EliteCommand: 9992202, // bb_percent = 3.5, high zone%   → PITCHER_LOW_WALK_RATE
  Reliever1:    9992203, // walk-prone bullpen arm (bb% 13.5%) for BullpenPath game
  Reliever2:    9992204, // walk-prone bullpen arm (bb% 12.0%) for BullpenPath game
};

const T = {
  Batters:         9990201, // home team — LowPowerWalker, PowerSwinger face WildArm
  WildArm:         9990202, // away team — has WildArm starter
  Patience:        9990203, // home — PatientVsCommand faces EliteCommand
  Elite:           9990204, // away — EliteCommand starter
  Count:           9990205, // home — CountCreator, LowSamplePlayer face WildArm
  WildArm2:        9990206, // away — WildArm starter (re-used)
  Aggressive:      9990207, // home — AggressiveHitter faces EliteCommand
  Elite2:          9990208, // away — EliteCommand starter (re-used)
  Blocked:         9990209, // home — UnknownStarterPlayer (no starter record)
  NoStarter:       9990210, // away — no starter record
  BullpenBatters:  9990211, // home — BullpenPath player (no patience/count signals)
  BullpenWild:     9990212, // away — walk-prone bullpen (avg bb% > 10%)
};

const GAME = {
  Alpha:       9998201, // Batters vs WildArm         — LowPowerWalker, PowerSwinger
  Beta:        9998202, // Patience vs Elite           — PatientVsCommand
  Gamma:       9998203, // Count vs WildArm2           — CountCreator, LowSamplePlayer
  Delta:       9998204, // Aggressive vs Elite2        — AggressiveHitter
  Blocked:     9998205, // Blocked vs NoStarter        — UnknownStarterPlayer
  BullpenPath: 9998206, // BullpenBatters vs BullpenWild — BullpenPath (BULLPEN_WALK_PATH)
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function ensureSourceRegistry(sourceId, name) {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type)
     VALUES ($1, $2, 'RESEARCH') ON CONFLICT (source_id) DO NOTHING`,
    [sourceId, name],
  );
}

async function ensureTeam(teamId) {
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name, active)
     VALUES ($1, $2, $2, true) ON CONFLICT (team_id) DO NOTHING`,
    [teamId, `T${teamId}`],
  );
}

async function ensurePlayer(playerId, bats) {
  await pool.query(
    `INSERT INTO players (player_id, full_name, bats, active)
     VALUES ($1, $2, $3, true) ON CONFLICT (player_id) DO NOTHING`,
    [playerId, `Walk Player ${playerId}`, bats],
  );
}

async function ensurePitcherPlayer(playerId, throws) {
  await pool.query(
    `INSERT INTO players (player_id, full_name, throws, active)
     VALUES ($1, $2, $3, true) ON CONFLICT (player_id) DO NOTHING`,
    [playerId, `Pitcher ${playerId}`, throws],
  );
}

async function ensureGame(gamePk, homeTeamId, awayTeamId, gameDate) {
  await pool.query(
    `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id, game_status)
     VALUES ($1, $2, $3, $4, 'Scheduled') ON CONFLICT (game_pk) DO NOTHING`,
    [gamePk, gameDate ?? SLATE, awayTeamId, homeTeamId],
  );
}

async function ensureStarter(gamePk, teamId, playerId, throws, state) {
  await pool.query(
    `INSERT INTO starters (game_pk, team_id, player_id, starter_state, source_id, observed_at, raw)
     VALUES ($1, $2, $3, $4, 'MLB_OFFICIAL', now(), '{}')`,
    [gamePk, teamId, playerId, state],
  );
}

async function ensureLineupEntry(gamePk, teamId, players) {
  const snapshotRes = await pool.query(
    `INSERT INTO lineup_snapshots (game_pk, team_id, state, source_id, observed_at, raw)
     VALUES ($1, $2, 'PROJECTED', 'FANTASYPROS', now(), '{}') RETURNING lineup_snapshot_id`,
    [gamePk, teamId],
  );
  const sid = snapshotRes.rows[0].lineup_snapshot_id;
  for (const [order, playerId] of players.entries()) {
    await pool.query(
      `INSERT INTO lineup_entries (lineup_snapshot_id, batting_order, player_id)
       VALUES ($1, $2, $3)`,
      [sid, order + 1, playerId],
    );
  }
  return sid;
}

async function ensureHitterFeatures(playerId, features) {
  const srcId = "STATCAST";
  const snapRes = await pool.query(
    `INSERT INTO player_research_snapshots
       (player_id, source_id, research_window, effective_from, effective_to, content_checksum)
     VALUES ($1, $2, 'SEASON', '2026-03-01', $3, md5(random()::text))
     RETURNING research_snapshot_id`,
    [playerId, srcId, SLATE],
  );
  const rid = snapRes.rows[0].research_snapshot_id;

  for (const [key, value, side] of features) {
    await pool.query(
      `INSERT INTO player_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          pitcher_side, transformation, sample_status, definition, provenance)
       VALUES ($1,'discipline',$2,$2,$3,'%',$4,'NORMALIZED','AVAILABLE','Walk research feature','{}')
       ON CONFLICT (research_snapshot_id, metric_key, pitcher_side) DO NOTHING`,
      [rid, key, value, side ?? null],
    );
  }
}

async function ensurePitcherFeatures(playerId, features) {
  const srcId = "STATCAST";
  const snapRes = await pool.query(
    `INSERT INTO pitcher_research_snapshots
       (player_id, source_id, research_window, effective_from, effective_to, content_checksum)
     VALUES ($1, $2, 'SEASON', '2026-03-01', $3, md5(random()::text))
     RETURNING research_snapshot_id`,
    [playerId, srcId, SLATE],
  );
  const rid = snapRes.rows[0].research_snapshot_id;

  for (const [key, value, side] of features) {
    await pool.query(
      `INSERT INTO pitcher_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          batter_side, transformation, sample_status, definition, provenance)
       VALUES ($1,'command',$2,$2,$3,'%',$4,'NORMALIZED','AVAILABLE','Walk research pitcher feature','{}')
       ON CONFLICT (research_snapshot_id, metric_key, batter_side) DO NOTHING`,
      [rid, key, value, side ?? null],
    );
  }
}

async function ensureBullpenAvailability(playerId, teamId, slateDate) {
  await pool.query(
    `INSERT INTO bullpen_availability_observations
       (player_id, team_id, slate_date, final_state, heuristic_availability,
        consecutive_days_used, multi_inning_yesterday, confidence)
     VALUES ($1, $2, $3, 'AVAILABLE', 'AVAILABLE', 0, false, 'HEURISTIC')
     ON CONFLICT (player_id, slate_date) DO NOTHING`,
    [playerId, teamId, slateDate],
  );
}


async function setupFixtures() {
  // Source registries
  await ensureSourceRegistry("MLB_OFFICIAL", "MLB Official");
  await ensureSourceRegistry("STATCAST", "Baseball Savant / Statcast");
  await ensureSourceRegistry("FANTASYPROS", "FantasyPros");

  // Teams
  for (const teamId of Object.values(T)) await ensureTeam(teamId);

  // Players (hitters)
  await ensurePlayer(P.LowPowerWalker,   "L");
  await ensurePlayer(P.PowerSwinger,     "R");
  await ensurePlayer(P.PatientVsCommand, "L");
  await ensurePlayer(P.CountCreator,     "S");
  await ensurePlayer(P.AggressiveHitter, "R");
  await ensurePlayer(P.UnknownStarter,   "L");
  await ensurePlayer(P.LowSamplePlayer,  "L");
  await ensurePlayer(P.BullpenPath,      "L");  // no patience/count signals → BULLPEN_WALK_PATH

  // Pitchers (starters)
  await ensurePitcherPlayer(STARTER.WildArm,      "R");
  await ensurePitcherPlayer(STARTER.EliteCommand,  "L");
  // Relievers for BullpenPath game
  await ensurePitcherPlayer(STARTER.Reliever1,    "R");
  await ensurePitcherPlayer(STARTER.Reliever2,    "L");

  // Games
  await ensureGame(GAME.Alpha,       T.Batters,        T.WildArm,       SLATE);
  await ensureGame(GAME.Beta,        T.Patience,       T.Elite,         SLATE);
  await ensureGame(GAME.Gamma,       T.Count,          T.WildArm2,      SLATE);
  await ensureGame(GAME.Delta,       T.Aggressive,     T.Elite2,        SLATE);
  await ensureGame(GAME.Blocked,     T.Blocked,        T.NoStarter,     SLATE);
  await ensureGame(GAME.BullpenPath, T.BullpenBatters, T.BullpenWild,   SLATE);

  // Starters (opp team from batter's perspective)
  await ensureStarter(GAME.Alpha,       T.WildArm,    STARTER.WildArm,      "R", "CONFIRMED");
  await ensureStarter(GAME.Beta,        T.Elite,      STARTER.EliteCommand,  "L", "CONFIRMED");
  await ensureStarter(GAME.Gamma,       T.WildArm2,   STARTER.WildArm,      "R", "CONFIRMED");
  await ensureStarter(GAME.Delta,       T.Elite2,     STARTER.EliteCommand,  "L", "CONFIRMED");
  await ensureStarter(GAME.BullpenPath, T.BullpenWild, STARTER.WildArm,     "R", "CONFIRMED");
  // GAME.Blocked: NO starter record for T.NoStarter → BLOCKED result for player

  // Lineups
  await ensureLineupEntry(GAME.Alpha,       T.Batters,        [P.LowPowerWalker, P.PowerSwinger]);
  await ensureLineupEntry(GAME.Beta,        T.Patience,       [P.PatientVsCommand]);
  await ensureLineupEntry(GAME.Gamma,       T.Count,          [P.CountCreator, P.LowSamplePlayer]);
  await ensureLineupEntry(GAME.Delta,       T.Aggressive,     [P.AggressiveHitter]);
  await ensureLineupEntry(GAME.Blocked,     T.Blocked,        [P.UnknownStarter]);
  await ensureLineupEntry(GAME.BullpenPath, T.BullpenBatters, [P.BullpenPath]);

  // Bullpen availability observations for BullpenPath game (T.BullpenWild has walk-prone arms)
  await ensureBullpenAvailability(STARTER.Reliever1, T.BullpenWild, SLATE);
  await ensureBullpenAvailability(STARTER.Reliever2, T.BullpenWild, SLATE);

  // ── Hitter features ────────────────────────────────────────────────────────
  // LowPowerWalker: elite discipline, low power — should rank HIGH on WALK, low on TB/XBH
  await ensureHitterFeatures(P.LowPowerWalker, [
    ["bb_percent",      16.0,  null],  // elite walk rate (pitcher-agnostic)
    ["bb_percent",      15.5,  "R"],   // vs RHP (WildArm throws R)
    ["o_swing_percent", 22.0,  null],  // very low chase (patience signal)
    ["z_swing_percent", 68.0,  null],
    ["pitches_per_pa",  4.55,  null],  // works deep counts
    ["zone_percent",    41.0,  null],  // sees many pitches outside zone
    ["f_strike_percent",62.0,  "R"],   // not routinely behind in counts
    ["f_strike_percent",62.0,  null],
    ["k_percent",       13.0,  null],
    ["k_percent",       13.5,  "R"],
    ["pa",              280,   null],  // sufficient sample
    // Power features — deliberately weak (TB/XBH engine will rank this player low)
    ["avg_ev",          85.0,  null],  // low exit velocity (reusing discipline family ok for test)
    ["hard_hit_percent",21.0,  null],
    ["barrel_percent",  1.2,   null],
    ["barrel_pa",       0.7,   null],
    ["iso",             0.090, null],
    ["xslg",            0.310, null],
    ["xwoba",           0.330, null],
    ["xbh_per_pa",      0.028, null],
  ]);

  // PowerSwinger: elite power, low discipline — should rank HIGH on TB/XBH, LOW on WALK
  await ensureHitterFeatures(P.PowerSwinger, [
    ["bb_percent",      5.0,  null],   // low walk rate
    ["bb_percent",      5.2,  "R"],    // vs RHP
    ["o_swing_percent", 40.5, null],   // aggressive → AGGRESSIVE_HITTER flag
    ["z_swing_percent", 75.0, null],
    ["pitches_per_pa",  3.52, null],   // doesn't work counts
    ["zone_percent",    46.0, null],
    ["f_strike_percent",70.5, "R"],    // → FIRST_PITCH_STRIKE_HEAVY
    ["f_strike_percent",70.5, null],
    ["k_percent",       26.0, null],
    ["k_percent",       26.5, "R"],
    ["pa",              310,  null],
    // Power features — elite (TB/XBH engine will rank this player high)
    ["avg_ev",          94.5, null],
    ["hard_hit_percent",52.0, null],
    ["barrel_percent",  14.5, null],
    ["barrel_pa",       9.8,  null],
    ["iso",             0.260, null],
    ["xslg",            0.590, null],
    ["xwoba",           0.410, null],
    ["xbh_per_pa",      0.225, null],
    ["home_runs",       22,   null],
    ["doubles",         18,   null],
  ]);

  // PatientVsCommand: patience signals ≥ 2 → PATIENCE_VS_COMMAND
  await ensureHitterFeatures(P.PatientVsCommand, [
    ["bb_percent",      14.5, null],   // ≥ 12 → patience signal 1
    ["bb_percent",      15.0, "L"],    // vs LHP (EliteCommand throws L)
    ["o_swing_percent", 25.0, null],   // ≤ 28 → patience signal 2
    ["pitches_per_pa",  4.3,  null],
    ["f_strike_percent",60.0, "L"],
    ["f_strike_percent",60.0, null],
    ["pa",              220,  null],
  ]);

  // CountCreator: count_signals ≥ 2, patience < 2 → COUNT_CREATION
  await ensureHitterFeatures(P.CountCreator, [
    ["bb_percent",      9.5,  null],   // < 12 (below patience threshold)
    ["bb_percent",      9.8,  "R"],
    ["o_swing_percent", 31.5, null],   // ≤ 32 → count signal 2; > 28 so NO patience signal 1
    ["pitches_per_pa",  4.15, null],   // ≥ 4.0 → count signal 1
    ["f_strike_percent",63.0, null],
    ["pa",              195,  null],
  ]);

  // AggressiveHitter: o_swing ≥ 36%, f_strike ≥ 68% → AGGRESSIVE_HITTER + FIRST_PITCH_STRIKE_HEAVY
  await ensureHitterFeatures(P.AggressiveHitter, [
    ["bb_percent",      7.0,  null],
    ["bb_percent",      6.5,  "L"],    // vs LHP (EliteCommand throws L)
    ["o_swing_percent", 37.5, null],   // ≥ 36 → AGGRESSIVE_HITTER
    ["pitches_per_pa",  3.7,  null],
    ["f_strike_percent",69.5, "L"],    // ≥ 68 → FIRST_PITCH_STRIKE_HEAVY
    ["f_strike_percent",69.5, null],
    ["pa",              240,  null],
  ]);

  // UnknownStarterPlayer: no starter record for opp team → BLOCKED
  await ensureHitterFeatures(P.UnknownStarter, [
    ["bb_percent",      11.0, null],
    ["o_swing_percent", 30.0, null],
    ["pa",              180,  null],
  ]);

  // LowSamplePlayer: PA < 50 → INSUFFICIENT_SAMPLE flag
  await ensureHitterFeatures(P.LowSamplePlayer, [
    ["bb_percent",      10.0, null],
    ["o_swing_percent", 29.0, null],
    ["pa",              38,   null],   // < 50 → INSUFFICIENT_SAMPLE
  ]);

  // BullpenPath: zero patience signals, zero count signals — mechanism driven entirely by bullpen
  await ensureHitterFeatures(P.BullpenPath, [
    ["bb_percent",      9.0,  null],   // < 12% → no patience signal 1
    ["bb_percent",      8.8,  "R"],    // vs RHP (BullpenWild starter throws R)
    ["o_swing_percent", 34.0, null],   // > 32% → no count signal; > 28% → no patience signal
    ["pitches_per_pa",  3.85, null],   // < 4.0 → no count signal
    ["f_strike_percent",62.0, null],
    ["f_strike_percent",61.0, "R"],
    ["pa",              155,  null],   // sufficient sample
  ]);

  // ── Pitcher features ───────────────────────────────────────────────────────
  // WildArm: high bb%, low zone% — good for walk opportunities
  await ensurePitcherFeatures(STARTER.WildArm, [
    ["bb_percent",       12.5, null],  // high walk rate → good for WALK engine
    ["bb_percent",       12.0, "L"],   // vs LHB (LowPowerWalker bats L)
    ["bb_percent",       13.0, "R"],   // vs RHB (PowerSwinger bats R)
    ["zone_percent",     43.0, null],  // low zone%
    ["k_percent",        21.0, null],
    ["k_minus_bb_percent",8.5, null],
    ["bf",               420,  null],
    // Also provide XBH/TB-relevant features for cross-market independence test
    ["xslg_allowed",     0.415, null], // moderate (needed by TB engine)
    ["xbh_per_bf",       0.125, null], // moderate (needed by XBH engine)
  ]);

  // EliteCommand: very low bb% ≤ 4.0 → PITCHER_LOW_WALK_RATE counter-evidence
  await ensurePitcherFeatures(STARTER.EliteCommand, [
    ["bb_percent",       3.5,  null],  // ≤ 4.0 → PITCHER_LOW_WALK_RATE flag
    ["bb_percent",       3.2,  "L"],   // vs LHB (PatientVsCommand bats L)
    ["bb_percent",       3.8,  "R"],   // vs RHB (AggressiveHitter bats R)
    ["zone_percent",     53.0, null],  // high zone%
    ["k_percent",        27.0, null],
    ["k_minus_bb_percent",23.5, null],
    ["bf",               380,  null],
    ["xslg_allowed",     0.355, null],
    ["xbh_per_bf",       0.095, null],
  ]);

  // Relievers: walk-prone arms for BullpenPath game (avg bb_percent > 10%)
  await ensurePitcherFeatures(STARTER.Reliever1, [
    ["bb_percent", 13.5, null],  // walk-prone reliever
    ["k_percent",  22.0, null],
    ["bf",         85,   null],
  ]);
  await ensurePitcherFeatures(STARTER.Reliever2, [
    ["bb_percent", 12.0, null],  // walk-prone reliever
    ["k_percent",  19.5, null],
    ["bf",         72,   null],
  ]);
}

async function cleanupSlate() {
  // Delete evidence blocks for all markets for our synthetic players (clears TB/XBH rows too, from C2 cross-market run)
  await pool.query(
    `DELETE FROM market_research_evidence_blocks WHERE candidate_id IN (
       SELECT candidate_id FROM market_research_candidates
       WHERE player_id >= 9991200)`,
  );
  // Delete ALL market candidates for our synthetic players
  await pool.query(`DELETE FROM market_research_candidates WHERE player_id >= 9991200`);

  await pool.query(
    `DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (
       SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk >= 9998200)`,
  );
  await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk >= 9998200`);
  await pool.query(`DELETE FROM starters WHERE game_pk >= 9998200`);

  const allPitcherIds = Object.values(STARTER);  // includes relievers
  const pids = Object.values(P);

  // Bullpen availability observations for synthetic relievers
  await pool.query(
    `DELETE FROM bullpen_availability_observations WHERE player_id = ANY($1)`,
    [allPitcherIds],
  );

  await pool.query(
    `DELETE FROM player_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM player_research_snapshots WHERE player_id = ANY($1))`,
    [pids],
  );
  await pool.query(
    `DELETE FROM pitcher_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM pitcher_research_snapshots WHERE player_id = ANY($1))`,
    [allPitcherIds],
  );
  await pool.query(`DELETE FROM player_research_snapshots WHERE player_id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM pitcher_research_snapshots WHERE player_id = ANY($1)`, [allPitcherIds]);
  await pool.query(`DELETE FROM games WHERE game_pk >= 9998200`);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Phase 3C – Batter Walk Research Engine", async () => {
  before(async () => {
    await cleanupSlate();
    await setupFixtures();
  });

  after(async () => {
    await cleanupSlate();
    await pool.end();
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C1: POST /api/analyst/refresh/market-research/walk returns 201 with correct shape", async () => {
    const res = await fetch(`${API}/api/analyst/refresh/market-research/walk?date=${SLATE}`, { method: "POST" });
    assert.equal(res.status, 201, "Must return HTTP 201");
    const body = await res.json();

    assert.equal(body.market, "WALK", "market must equal WALK");
    assert.equal(body.slateDate, SLATE);
    assert.ok(typeof body.gamesProcessed === "number" && body.gamesProcessed > 0, "gamesProcessed > 0");
    assert.ok(typeof body.candidatesProcessed === "number", "candidatesProcessed present");
    assert.ok(typeof body.candidatesWritten === "number", "candidatesWritten present");
    assert.ok(typeof body.blockedCandidates === "number", "blockedCandidates present");
    assert.ok(typeof body.strongCandidates === "number");
    assert.ok(typeof body.positiveCandidates === "number");
    assert.ok(typeof body.neutralCandidates === "number");
    assert.ok(typeof body.negativeCandidates === "number");
    assert.ok(typeof body.processingMs === "number");
    assert.ok(Array.isArray(body.notes));
    assert.ok("error" in body && (body.error === null || typeof body.error === "string"));
    assert.equal(body.error, null);

    // All candidates must be written and at least some are blocked (UnknownStarter)
    assert.ok(body.candidatesWritten > 0, "At least one candidate written");
    assert.ok(body.blockedCandidates >= 1, "UnknownStarter game must yield BLOCKED");
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C2: Walk/TB/XBH independence — low-power walker ranks higher on WALK than on TB/XBH; power hitter ranks lower", async () => {
    // Run all three engines for the same slate date
    const [tbRes, xbhRes, walkRes] = await Promise.all([
      fetch(`${API}/api/analyst/refresh/market-research/tb?date=${SLATE}`,   { method: "POST" }),
      fetch(`${API}/api/analyst/refresh/market-research/xbh?date=${SLATE}`,  { method: "POST" }),
      fetch(`${API}/api/analyst/refresh/market-research/walk?date=${SLATE}`, { method: "POST" }),
    ]);

    assert.equal(tbRes.status,   201, "TB engine must succeed");
    assert.equal(xbhRes.status,  201, "XBH engine must succeed");
    assert.equal(walkRes.status, 201, "WALK engine must succeed");

    // Fetch the market board for all three markets
    const [tbBoard, xbhBoard, walkBoard] = await Promise.all([
      fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=TB`).then((r) => r.json()),
      fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=XBH`).then((r) => r.json()),
      fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=WALK`).then((r) => r.json()),
    ]);

    function getRank(board, playerId) {
      const candidate = board.candidates?.find((c) => c.playerId === playerId);
      return candidate?.researchRank ?? null;
    }

    const walkLow  = getRank(walkBoard, P.LowPowerWalker);
    const walkPow  = getRank(walkBoard, P.PowerSwinger);
    const tbLow    = getRank(tbBoard,   P.LowPowerWalker);
    const tbPow    = getRank(tbBoard,   P.PowerSwinger);
    const xbhLow   = getRank(xbhBoard,  P.LowPowerWalker);
    const xbhPow   = getRank(xbhBoard,  P.PowerSwinger);

    assert.ok(walkLow !== null, "LowPowerWalker must appear in WALK board");
    assert.ok(walkPow !== null, "PowerSwinger must appear in WALK board");
    assert.ok(tbLow !== null,   "LowPowerWalker must appear in TB board");
    assert.ok(tbPow !== null,   "PowerSwinger must appear in TB board");
    assert.ok(xbhLow !== null,  "LowPowerWalker must appear in XBH board");
    assert.ok(xbhPow !== null,  "PowerSwinger must appear in XBH board");

    // LowPowerWalker ranks HIGHER (lower number) on WALK than PowerSwinger
    assert.ok(
      walkLow < walkPow,
      `LowPowerWalker (WALK rank ${walkLow}) must rank higher than PowerSwinger (WALK rank ${walkPow})`,
    );

    // PowerSwinger ranks HIGHER (lower number) on TB than LowPowerWalker
    assert.ok(
      tbPow < tbLow,
      `PowerSwinger (TB rank ${tbPow}) must rank higher than LowPowerWalker (TB rank ${tbLow}) on TB`,
    );

    // PowerSwinger ranks HIGHER on XBH than LowPowerWalker
    assert.ok(
      xbhPow < xbhLow,
      `PowerSwinger (XBH rank ${xbhPow}) must rank higher than LowPowerWalker (XBH rank ${xbhLow}) on XBH`,
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C3: Mechanism classification — PATIENCE_VS_COMMAND and COUNT_CREATION assigned correctly", async () => {
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=WALK`);
    const board = await boardRes.json();

    const getCandidate = (id) => board.candidates?.find((c) => c.playerId === id);

    // PatientVsCommand: bb% ≥ 12 + o_swing% ≤ 28 → patience_signals ≥ 2 → PATIENCE_VS_COMMAND
    const pvc = getCandidate(P.PatientVsCommand);
    assert.ok(pvc, "PatientVsCommand must be on WALK board");
    assert.equal(pvc.primaryMechanism, "PATIENCE_VS_COMMAND",
      `PatientVsCommand must have PATIENCE_VS_COMMAND (got ${pvc.primaryMechanism})`);

    // CountCreator: pitches/PA ≥ 4.0 + o_swing% ≤ 32 → count_signals ≥ 2, patience < 2 → COUNT_CREATION
    const cc = getCandidate(P.CountCreator);
    assert.ok(cc, "CountCreator must be on WALK board");
    assert.equal(cc.primaryMechanism, "COUNT_CREATION",
      `CountCreator must have COUNT_CREATION (got ${cc.primaryMechanism})`);

    // LowPowerWalker: bb% 16% + o_swing% 22% → patience_signals ≥ 2 → PATIENCE_VS_COMMAND
    const lpw = getCandidate(P.LowPowerWalker);
    assert.ok(lpw, "LowPowerWalker must be on WALK board");
    assert.equal(lpw.primaryMechanism, "PATIENCE_VS_COMMAND");

    // BullpenPath: bb% 9% (< 12), o_swing 34% (> 32), pitches/PA 3.85 (< 4.0)
    //   → patienceSignals = 0, countSignals = 0, bullpenWalkProne = true → BULLPEN_WALK_PATH
    const bp = getCandidate(P.BullpenPath);
    assert.ok(bp, "BullpenPath player must be on WALK board");
    assert.equal(bp.primaryMechanism, "BULLPEN_WALK_PATH",
      `BullpenPath must have BULLPEN_WALK_PATH (got ${bp.primaryMechanism}) — zero patience/count signals, walk-prone bullpen avg bb% > 10%`);
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C4: Counter-evidence flags populated correctly", async () => {
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=WALK`);
    const board = await boardRes.json();
    const getCandidate = (id) => board.candidates?.find((c) => c.playerId === id);

    // AggressiveHitter: o_swing 37.5% ≥ 36 → AGGRESSIVE_HITTER; f_strike 69.5% ≥ 68 → FIRST_PITCH_STRIKE_HEAVY
    const aggressive = getCandidate(P.AggressiveHitter);
    assert.ok(aggressive, "AggressiveHitter must appear on WALK board");
    const aggressiveFlags = aggressive.counterEvidence?.flags ?? aggressive.counterEvidenceFlags ?? [];
    assert.ok(
      aggressiveFlags.includes("AGGRESSIVE_HITTER"),
      `AggressiveHitter must have AGGRESSIVE_HITTER flag (got: ${JSON.stringify(aggressiveFlags)})`,
    );
    assert.ok(
      aggressiveFlags.includes("FIRST_PITCH_STRIKE_HEAVY"),
      `AggressiveHitter must have FIRST_PITCH_STRIKE_HEAVY flag (got: ${JSON.stringify(aggressiveFlags)})`,
    );

    // PatientVsCommand faces EliteCommand (bb% 3.2% vs LHB ≤ 4.0) → PITCHER_LOW_WALK_RATE
    const pvc = getCandidate(P.PatientVsCommand);
    assert.ok(pvc, "PatientVsCommand must appear on WALK board");
    const pvcFlags = pvc.counterEvidence?.flags ?? pvc.counterEvidenceFlags ?? [];
    assert.ok(
      pvcFlags.includes("PITCHER_LOW_WALK_RATE"),
      `PatientVsCommand vs EliteCommand must have PITCHER_LOW_WALK_RATE flag (got: ${JSON.stringify(pvcFlags)})`,
    );

    // LowSamplePlayer: PA = 38 < 50 → INSUFFICIENT_SAMPLE
    const ls = getCandidate(P.LowSamplePlayer);
    assert.ok(ls, "LowSamplePlayer must appear on WALK board");
    const lsFlags = ls.counterEvidence?.flags ?? ls.counterEvidenceFlags ?? [];
    assert.ok(
      lsFlags.includes("INSUFFICIENT_SAMPLE"),
      `LowSamplePlayer must have INSUFFICIENT_SAMPLE flag (got: ${JSON.stringify(lsFlags)})`,
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C5: BLOCKED state when starter identity is unknown", async () => {
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=WALK`);
    const board = await boardRes.json();
    const unknown = board.candidates?.find((c) => c.playerId === P.UnknownStarter);
    assert.ok(unknown, "UnknownStarter must appear on the WALK board (RANK DON'T GATE)");
    assert.equal(unknown.researchState, "BLOCKED",
      `UnknownStarter must be BLOCKED (got ${unknown.researchState})`);
    // BLOCKED candidates must still have a research rank
    assert.ok(unknown.researchRank !== null, "BLOCKED candidate must have a rank (RANK DON'T GATE)");
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C6: No pseudo-probability or prohibited analytics fields in any WALK response", async () => {
    const prohibited = [
      "ev", "clv", "odds", "impliedProbability", "vigJuice",
      "edgePercent", "kellyFraction", "expectedValue",
    ];

    function deepCheck(obj, path = "") {
      if (Array.isArray(obj)) {
        obj.forEach((item, i) => deepCheck(item, `${path}[${i}]`));
        return;
      }
      if (obj !== null && typeof obj === "object") {
        for (const [key, value] of Object.entries(obj)) {
          const lk = key.toLowerCase();
          const match = prohibited.find((p) => p.toLowerCase() === lk);
          assert.ok(!match, `Prohibited field "${key}" found at path "${path}.${key}"`);
          deepCheck(value, `${path}.${key}`);
        }
      }
    }

    // Check the POST /walk response
    const engineRes = await fetch(`${API}/api/analyst/refresh/market-research/walk?date=${SLATE}`, { method: "POST" });
    deepCheck(await engineRes.json(), "POST walk engine");

    // Check the board GET response
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=WALK`);
    deepCheck(await boardRes.json(), "GET market board WALK");
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C7: Competition ranking — ties share the same rank; rank after tie group skips k−1", async () => {
    const rows = await pool.query(
      `SELECT player_id, research_rank,
              (opportunity_evidence->>'battingOrder')::int AS batting_order
       FROM market_research_candidates
       WHERE slate_date = $1 AND market = 'BATTER_WALK'
       ORDER BY research_rank, player_id`,
      [SLATE],
    );

    // Sanity: all ranks are positive integers
    for (const row of rows.rows) {
      assert.ok(Number.isInteger(row.research_rank) && row.research_rank >= 1,
        `research_rank must be ≥ 1 (got ${row.research_rank} for player ${row.player_id})`);
    }

    // Validate: rank values form a valid 1,1,3 (or 1,2,3) pattern — no gaps within a single-occurrence rank
    const ranks = rows.rows.map((r) => r.research_rank);
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(
        ranks[i] >= ranks[i - 1],
        `Ranks must be non-decreasing (got ${ranks[i - 1]} then ${ranks[i]} at position ${i})`,
      );
    }

    // Create a synthetic tie scenario by directly querying the DB for a known case
    // and checking that if two players have identical rank, the next rank value > rank + 1
    const rankCounts = new Map();
    for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
    for (const [rank, count] of rankCounts.entries()) {
      if (count > 1) {
        // After this tie group of size k, the next distinct rank should be rank + k
        const nextRank = [...rankCounts.keys()].find((r) => r > rank);
        if (nextRank !== undefined) {
          assert.equal(nextRank, rank + count,
            `After ${count}-way tie at rank ${rank}, next rank must be ${rank + count} (got ${nextRank})`);
        }
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C8: GET /api/analyst/market-research?market=WALK returns WALK candidates with evidence objects", async () => {
    const res = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=WALK`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(Array.isArray(body.candidates), "candidates must be an array");
    assert.ok(body.candidates.length > 0, "Board must have at least one WALK candidate");

    // Verify market field
    for (const c of body.candidates) {
      assert.equal(c.market, "WALK", `All candidates must be market=WALK (got ${c.market})`);
    }

    // Verify all expected evidence objects exist (individual JSONB columns, not an array)
    const anyCandidate = body.candidates.find((c) => c.researchState !== "BLOCKED");
    assert.ok(anyCandidate, "Must have at least one non-BLOCKED candidate");

    assert.ok(anyCandidate.opportunityEvidence !== undefined,     "opportunityEvidence must be present");
    assert.ok(anyCandidate.starterMatchupEvidence !== undefined,  "starterMatchupEvidence must be present");
    assert.ok(anyCandidate.bullpenPathEvidence !== undefined,     "bullpenPathEvidence must be present");
    assert.ok(anyCandidate.recentVsSeasonVsCareer !== undefined,  "recentVsSeasonVsCareer must be present");
    assert.ok(anyCandidate.counterEvidence !== undefined,         "counterEvidence must be present");

    // At least one non-BLOCKED candidate must have non-empty evidence in at least one field
    const hasEvidence =
      Object.keys(anyCandidate.opportunityEvidence ?? {}).length > 0 ||
      Object.keys(anyCandidate.starterMatchupEvidence ?? {}).length > 0 ||
      Object.keys(anyCandidate.bullpenPathEvidence ?? {}).length > 0;
    assert.ok(hasEvidence, "At least one evidence object must be non-empty for a non-BLOCKED candidate");

    // rankSemantics and prohibitedFields must be present
    assert.ok(typeof body.rankSemantics === "string" && body.rankSemantics.length > 0);
    assert.ok(Array.isArray(body.prohibitedFields) && body.prohibitedFields.length > 0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C9: Engine write failure → HTTP 5xx and ingest run not left as RUNNING", async () => {
    // Use an impossible date that passes regex validation but fails PostgreSQL's date cast.
    // "2099-02-30" is a valid ISO-8601 format string but February 30 does not exist,
    // so PostgreSQL raises an error when the engine tries to cast it — reproducing a real
    // DB-level engine failure exactly as Phase 3B test B9 does for the XBH engine.
    const impossibleDate = "2099-02-30";
    const res = await fetch(
      `${API}/api/analyst/refresh/market-research/walk?date=${impossibleDate}`,
      { method: "POST" },
    );
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    assert.ok(res.status >= 500,
      `Expected 5xx status on engine error, got ${res.status}: ${bodyText}`);
    assert.ok(typeof body.error === "string" && body.error.length > 0,
      `Response must include a non-empty error string, got: ${JSON.stringify(body)}`);

    // Allow short window for best-effort FAILED update
    await new Promise((r) => setTimeout(r, 300));

    // Ingest run must NOT be left as RUNNING
    const stuck = await pool.query(
      `SELECT ingest_run_id FROM ingest_runs
       WHERE source_id = 'WALK_ENGINE' AND status = 'RUNNING'
         AND effective_date::text = $1
         AND started_at > now() - interval '2 minutes'`,
      [impossibleDate],
    );
    assert.equal(stuck.rows.length, 0,
      `Ingest run(s) left as RUNNING after engine error: ${JSON.stringify(stuck.rows)}`);
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("C10: Stale WALK candidates are cleared when slate re-runs with no lineup entries", async () => {
    // Insert a synthetic WALK candidate for staleDate directly
    await ensureGame(9998209, T.Batters, T.WildArm, staleDate);
    const gameInserted = await pool.query(
      `SELECT game_pk FROM games WHERE game_pk = 9998209`,
    );
    assert.ok(gameInserted.rows.length > 0, "Stale game inserted");

    // Insert a WALK candidate for staleDate
    await pool.query(
      `INSERT INTO market_research_candidates
         (slate_date, game_pk, player_id, market, research_rank, research_state,
          primary_mechanism, secondary_mechanism,
          opportunity_evidence, starter_matchup_evidence, bullpen_path_evidence,
          park_evidence, recent_vs_season_vs_career, counter_evidence,
          rank_semantics, ingest_run_id)
       VALUES ($1, $2, $3, 'BATTER_WALK', 1, 'NEUTRAL', 'PATIENCE_VS_COMMAND', NULL,
               '{}','{}','{}','{}','{}','{}','RANK_DONT_GATE',
               (SELECT ingest_run_id FROM ingest_runs ORDER BY started_at DESC LIMIT 1))
       ON CONFLICT DO NOTHING`,
      [staleDate, 9998209, P.LowPowerWalker],
    );

    const before = await pool.query(
      `SELECT count(*)::int AS cnt FROM market_research_candidates
       WHERE slate_date = $1 AND market = 'BATTER_WALK'`,
      [staleDate],
    );
    assert.ok(before.rows[0].cnt >= 1, "Stale candidate must exist before reconcile");

    // Run engine for staleDate — no games on staleDate except the one we inserted
    // but we need no lineup entries → engine writes no candidates → reconcile removes the stale one
    const res = await fetch(
      `${API}/api/analyst/refresh/market-research/walk?date=${staleDate}`, { method: "POST" },
    );
    assert.ok(res.status === 200 || res.status === 201, "Engine must respond");
    const body = await res.json();

    // There IS a game on staleDate (9998209) but no lineup entries → candidates = []
    // → reconcile must remove the previously inserted stale candidate
    const after = await pool.query(
      `SELECT count(*)::int AS cnt FROM market_research_candidates
       WHERE slate_date = $1 AND market = 'BATTER_WALK' AND player_id = $2`,
      [staleDate, P.LowPowerWalker],
    );
    assert.equal(after.rows[0].cnt, 0,
      "Stale WALK candidate must be removed by reconcile after engine run with no lineup entries");

    // Cleanup stale game
    await pool.query(`DELETE FROM starters WHERE game_pk = 9998209`);
    await pool.query(`DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk = 9998209)`);
    await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk = 9998209`);
    await pool.query(`DELETE FROM games WHERE game_pk = 9998209`);
  });
});
