/**
 * Phase 3D – Home Run Research Engine – Acceptance Test Suite
 *
 * Tests D1–D10 validate:
 *   D1  POST shape / 201 response
 *   D2  HR/WALK/TB/XBH independence — pull-air/barrel hitter ranks higher on HR; contact hitter ranks lower
 *   D3  Mechanism classification (PULL_AIR, BARREL_POWER, PITCH_SHAPE_MISMATCH, PARK_ENVIRONMENT as primary)
 *   D4  Counter-evidence flags (LOW_BARREL_RATE, GROUND_BALL_DOMINANT, PITCHER_LOW_HR_RATE, NEUTRAL_PARK, INSUFFICIENT_SAMPLE)
 *   D5  BLOCKED state when starter identity is unknown
 *   D6  No pseudo-probability or prohibited analytics fields in any HR response
 *   D7  Competition ranking — ties share rank; skips k−1 after a tie group
 *   D8  GET /api/analyst/market-research?market=HR returns candidates with evidence blocks
 *   D9  Engine failure → HTTP 5xx + ingest run not left as RUNNING
 *   D10 Stale HR candidates cleared when slate re-runs with no lineup entries
 *
 * Fixture namespace — all synthetic IDs use 999XXXXX ranges:
 *   Players   9991301–9991308
 *   Pitchers  9992301–9992302
 *   Teams     9990301–9990310
 *   Games     9998301–9998305
 *   Venues    9997301–9997302
 *   SLATE     2026-10-01
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

const API = "http://127.0.0.1:8080";
const SLATE = "2026-10-01";
const staleDate = "2026-10-02";

// ── Fixture identifiers ────────────────────────────────────────────────────────
const P = {
  PullAirHitter:   9991301, // pull% 43, fb% 45 → PULL_AIR (primary); high power → high HR rank
  ContactHitter:   9991302, // low power, gb% 55, barrel_pa 1.8 → LOW_BARREL_RATE + GROUND_BALL_DOMINANT
  BarrelPower:     9991303, // barrel_pa 8.5, avg_ev 96 → BARREL_POWER; no pull (< 38) → not PULL_AIR
  ParkHitter:      9991304, // park hr_factor 1.18 + no other mechanism threshold met → PARK_ENVIRONMENT
  LowBarrel:       9991305, // barrel_pa 1.5 → LOW_BARREL_RATE; gb% 54 → GROUND_BALL_DOMINANT
  PitchMismatch:   9991306, // moderate power signal + high pitcher barrel% → PITCH_SHAPE_MISMATCH
  UnknownStarter:  9991307, // no starter record → BLOCKED
  LowSample:       9991308, // pa < 50 → INSUFFICIENT_SAMPLE
};

const STARTER = {
  PowerPitcher:  9992301, // barrel% 10%, 18 HR in 250 BF (7.2%) → favorable for HR; xSLG 0.520
  ElitePitcher:  9992302, // barrel% 3%, 4 HR in 310 BF (1.3%) → PITCHER_LOW_HR_RATE; xSLG 0.330
};

const T = {
  Batters:       9990301, // home — PullAirHitter, ContactHitter, LowSample face PowerPitcher
  PowerTeam:     9990302, // away — has PowerPitcher starter
  BarrelTeam:    9990303, // home — BarrelPower faces ElitePitcher
  EliteTeam:     9990304, // away — ElitePitcher starter
  ParkTeam:      9990305, // home — ParkHitter faces ElitePitcher (re-used) at HR-friendly venue
  MidTeam:       9990306, // away — ElitePitcher starter (re-used)
  CounterTeam:   9990307, // home — LowBarrel, PitchMismatch face PowerPitcher (re-used)
  PowerTeam2:    9990308, // away — PowerPitcher starter (re-used)
  BlockedTeam:   9990309, // home — UnknownStarter (no starter for opp team → BLOCKED)
  NoStarterTeam: 9990310, // away — no starter record
};

const GAME = {
  Alpha:   9998301, // Batters vs PowerTeam  — PullAirHitter, ContactHitter, LowSample
  Beta:    9998302, // BarrelTeam vs EliteTeam — BarrelPower
  Gamma:   9998303, // ParkTeam vs MidTeam    — ParkHitter (HR-friendly park)
  Delta:   9998304, // CounterTeam vs PowerTeam2 — LowBarrel, PitchMismatch
  Epsilon: 9998305, // BlockedTeam vs NoStarterTeam — UnknownStarter
};

// Venues for park tests
const VENUE = {
  HRFriendly: 9997301, // hr_factor 1.18 → PARK_ENVIRONMENT
  PitchersPark: 9997302, // hr_factor 0.88 → NEUTRAL_PARK counter-evidence
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

async function ensureVenue(venueId, name) {
  await pool.query(
    `INSERT INTO venues (venue_id, name) VALUES ($1, $2) ON CONFLICT (venue_id) DO NOTHING`,
    [venueId, name],
  );
}

async function ensurePlayer(playerId, bats) {
  await pool.query(
    `INSERT INTO players (player_id, full_name, bats, active)
     VALUES ($1, $2, $3, true) ON CONFLICT (player_id) DO NOTHING`,
    [playerId, `HR Player ${playerId}`, bats],
  );
}

async function ensurePitcherPlayer(playerId, throws) {
  await pool.query(
    `INSERT INTO players (player_id, full_name, throws, active)
     VALUES ($1, $2, $3, true) ON CONFLICT (player_id) DO NOTHING`,
    [playerId, `HR Pitcher ${playerId}`, throws],
  );
}

async function ensureGame(gamePk, homeTeamId, awayTeamId, gameDate, venueId) {
  if (venueId != null) {
    await pool.query(
      `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id, venue_id, game_status)
       VALUES ($1, $2, $3, $4, $5, 'Scheduled') ON CONFLICT (game_pk) DO NOTHING`,
      [gamePk, gameDate ?? SLATE, awayTeamId, homeTeamId, venueId],
    );
  } else {
    await pool.query(
      `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id, game_status)
       VALUES ($1, $2, $3, $4, 'Scheduled') ON CONFLICT (game_pk) DO NOTHING`,
      [gamePk, gameDate ?? SLATE, awayTeamId, homeTeamId],
    );
  }
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
       VALUES ($1,'power',$2,$2,$3,'pct',$4,'NORMALIZED','AVAILABLE','HR research feature','{}')
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
       VALUES ($1,'power',$2,$2,$3,'pct',$4,'NORMALIZED','AVAILABLE','HR research pitcher feature','{}')
       ON CONFLICT (research_snapshot_id, metric_key, batter_side) DO NOTHING`,
      [rid, key, value, side ?? null],
    );
  }
}

async function ensureParkFeatures(venueId, hrFactor) {
  // Ensure source registry for park factors
  await ensureSourceRegistry("PARK_FACTORS", "Park Factors");

  const snapRes = await pool.query(
    `INSERT INTO park_research_snapshots
       (venue_id, source_id, season, span, content_checksum)
     VALUES ($1, 'PARK_FACTORS', 2026, '3yr', md5(random()::text))
     RETURNING park_research_snapshot_id`,
    [venueId],
  );
  const sid = snapRes.rows[0].park_research_snapshot_id;

  await pool.query(
    `INSERT INTO park_research_features
       (park_research_snapshot_id, metric_key, metric_label, value, definition)
     VALUES ($1, 'hr_factor', 'Park HR Factor', $2, 'HR park factor — ratio of HR rate at this venue vs average')
     ON CONFLICT (park_research_snapshot_id, metric_key, batter_side) DO NOTHING`,
    [sid, hrFactor],
  );
}

async function setupFixtures() {
  // Source registries
  await ensureSourceRegistry("MLB_OFFICIAL", "MLB Official");
  await ensureSourceRegistry("STATCAST", "Baseball Savant / Statcast");
  await ensureSourceRegistry("FANTASYPROS", "FantasyPros");

  // Teams
  for (const teamId of Object.values(T)) await ensureTeam(teamId);

  // Venues for park factor tests
  await ensureVenue(VENUE.HRFriendly,   "HR Friendly Ballpark");
  await ensureVenue(VENUE.PitchersPark, "Pitcher's Ballpark");

  // Players (hitters)
  await ensurePlayer(P.PullAirHitter,  "L");
  await ensurePlayer(P.ContactHitter,  "R");
  await ensurePlayer(P.BarrelPower,    "R");
  await ensurePlayer(P.ParkHitter,     "L");
  await ensurePlayer(P.LowBarrel,      "R");
  await ensurePlayer(P.PitchMismatch,  "R");
  await ensurePlayer(P.UnknownStarter, "L");
  await ensurePlayer(P.LowSample,      "L");

  // Pitchers (starters)
  await ensurePitcherPlayer(STARTER.PowerPitcher, "R");
  await ensurePitcherPlayer(STARTER.ElitePitcher, "L");

  // Games
  await ensureGame(GAME.Alpha,   T.Batters,      T.PowerTeam,     SLATE, null);
  await ensureGame(GAME.Beta,    T.BarrelTeam,   T.EliteTeam,     SLATE, null);
  await ensureGame(GAME.Gamma,   T.ParkTeam,     T.MidTeam,       SLATE, VENUE.HRFriendly);
  await ensureGame(GAME.Delta,   T.CounterTeam,  T.PowerTeam2,    SLATE, VENUE.PitchersPark);
  await ensureGame(GAME.Epsilon, T.BlockedTeam,  T.NoStarterTeam, SLATE, null);

  // Starters (opp team from batter's perspective)
  await ensureStarter(GAME.Alpha,   T.PowerTeam,     STARTER.PowerPitcher, "R", "CONFIRMED");
  await ensureStarter(GAME.Beta,    T.EliteTeam,     STARTER.ElitePitcher, "L", "CONFIRMED");
  await ensureStarter(GAME.Gamma,   T.MidTeam,       STARTER.ElitePitcher, "L", "CONFIRMED");
  await ensureStarter(GAME.Delta,   T.PowerTeam2,    STARTER.PowerPitcher, "R", "CONFIRMED");
  // GAME.Epsilon: NO starter for T.NoStarterTeam → BLOCKED

  // Lineups
  await ensureLineupEntry(GAME.Alpha,   T.Batters,     [P.PullAirHitter, P.ContactHitter, P.LowSample]);
  await ensureLineupEntry(GAME.Beta,    T.BarrelTeam,  [P.BarrelPower]);
  await ensureLineupEntry(GAME.Gamma,   T.ParkTeam,    [P.ParkHitter]);
  await ensureLineupEntry(GAME.Delta,   T.CounterTeam, [P.LowBarrel, P.PitchMismatch]);
  await ensureLineupEntry(GAME.Epsilon, T.BlockedTeam, [P.UnknownStarter]);

  // Park features
  await ensureParkFeatures(VENUE.HRFriendly,   1.18); // ≥ 1.10 → PARK_ENVIRONMENT
  await ensureParkFeatures(VENUE.PitchersPark, 0.88); // < 0.95 → NEUTRAL_PARK counter

  // ── Hitter features ────────────────────────────────────────────────────────
  // PullAirHitter: pull% 43, fb% 45 → PULL_AIR; barrel_pa 7.5, avg_ev 94 → also BARREL_POWER
  // Low bb%/high o_swing → low WALK rank (D2 independence)
  await ensureHitterFeatures(P.PullAirHitter, [
    ["pull_percent",     43.0,  null],  // ≥ 38 → PULL_AIR signal 1
    ["fb_percent",       45.0,  null],  // ≥ 38 → PULL_AIR signal 2
    ["barrel_pa",         7.5,  null],  // ≥ 5.0 → BARREL_POWER; ≥ 3.0 → power signal
    ["barrel_percent",    9.8,  null],
    ["avg_ev",           94.0,  null],  // ≥ 92 → BARREL_POWER
    ["gb_percent",       28.0,  null],  // low → no GROUND_BALL_DOMINANT
    ["launch_angle",     16.5,  null],
    ["hard_hit_percent", 52.0,  null],  // ≥ 42 → power signal
    ["home_runs",        24,    null],
    ["iso",               0.265, null],
    ["xslg",              0.580, null],
    ["pa",              285,    null],  // sufficient sample
    // Walk-unfavorable metrics (for D2 cross-market independence)
    ["bb_percent",        8.0,  null],  // low walk rate
    ["o_swing_percent",  39.0,  null],  // aggressive → bad for WALK
  ]);

  // ContactHitter: low power, high gb% — low HR, good WALK (for D2 independence)
  await ensureHitterFeatures(P.ContactHitter, [
    ["pull_percent",     28.0,  null],  // < 38 → no PULL_AIR
    ["fb_percent",       25.0,  null],  // < 38 → no PULL_AIR
    ["barrel_pa",         1.8,  null],  // < 2.5 → LOW_BARREL_RATE; < 3.0 → no power signal
    ["barrel_percent",    1.2,  null],
    ["avg_ev",           85.0,  null],  // < 90 → no power signal
    ["gb_percent",       55.0,  null],  // ≥ 50 → GROUND_BALL_DOMINANT
    ["launch_angle",      6.5,  null],
    ["hard_hit_percent", 21.0,  null],  // < 42 → no power signal
    ["home_runs",         4,    null],
    ["iso",               0.085, null], // < 0.160 → no power signal
    ["xslg",              0.310, null],
    ["pa",              295,    null],
    // Walk-favorable (for D2 — should rank higher on WALK)
    ["bb_percent",       15.0,  null],  // high walk rate
    ["o_swing_percent",  23.0,  null],  // disciplined → good for WALK
  ]);

  // BarrelPower: high barrel_pa, high avg_ev → BARREL_POWER
  // pull% 35 (< 38) and fb% 37 (< 38) → NOT PULL_AIR
  await ensureHitterFeatures(P.BarrelPower, [
    ["pull_percent",     35.0,  null],  // < 38 → no PULL_AIR
    ["fb_percent",       37.0,  null],  // < 38 → no PULL_AIR
    ["barrel_pa",         8.5,  null],  // ≥ 5.0 → BARREL_POWER
    ["barrel_percent",   11.2,  null],
    ["avg_ev",           96.0,  null],  // ≥ 92 → BARREL_POWER
    ["gb_percent",       34.0,  null],
    ["launch_angle",     14.5,  null],
    ["hard_hit_percent", 55.0,  null],
    ["home_runs",        28,    null],
    ["iso",               0.290, null],
    ["xslg",              0.610, null],
    ["pa",              270,    null],
  ]);

  // ParkHitter: moderate hitter, park hr_factor 1.18 → PARK_ENVIRONMENT
  // pull% < 38 (not PULL_AIR), barrel_pa < 5 (not BARREL_POWER)
  // Faces ElitePitcher: barrel% 3% < 8 (not PITCH_SHAPE_MISMATCH pitcher threshold)
  // → only PARK_ENVIRONMENT fires
  await ensureHitterFeatures(P.ParkHitter, [
    ["pull_percent",     32.0,  null],  // < 38 → no PULL_AIR
    ["fb_percent",       34.0,  null],  // < 38 → no PULL_AIR
    ["barrel_pa",         2.2,  null],  // < 5.0, < 3.0 → no power signal → no PITCH_SHAPE_MISMATCH
    ["barrel_percent",    2.8,  null],
    ["avg_ev",           88.0,  null],  // < 90 → no power signal
    ["gb_percent",       38.0,  null],
    ["launch_angle",     11.0,  null],
    ["hard_hit_percent", 36.0,  null],  // < 42 → no power signal
    ["home_runs",        10,    null],
    ["iso",               0.135, null], // < 0.160 → no power signal
    ["xslg",              0.395, null],
    ["pa",              200,    null],
  ]);

  // LowBarrel: barrel_pa < 2.5 → LOW_BARREL_RATE; gb% 54 → GROUND_BALL_DOMINANT
  // Faces PowerPitcher at PitchersPark (hr_factor 0.88 < 0.95 → NEUTRAL_PARK)
  await ensureHitterFeatures(P.LowBarrel, [
    ["pull_percent",     28.0,  null],
    ["fb_percent",       24.0,  null],
    ["barrel_pa",         1.5,  null],  // < 2.5 → LOW_BARREL_RATE
    ["barrel_percent",    1.0,  null],
    ["avg_ev",           87.0,  null],
    ["gb_percent",       54.0,  null],  // ≥ 50 → GROUND_BALL_DOMINANT
    ["launch_angle",      5.0,  null],
    ["hard_hit_percent", 19.0,  null],
    ["home_runs",         3,    null],
    ["iso",               0.075, null],
    ["xslg",              0.290, null],
    ["pa",              310,    null],
  ]);

  // PitchMismatch: moderate power (barrel_pa 4.0 ≥ 3.0 → power signal)
  // Faces PowerPitcher (barrel% 10% ≥ 8% → pitcher threshold met)
  // → PITCH_SHAPE_MISMATCH
  // pull% 30 (< 38), barrel_pa 4.0 (< 5.0) → not PULL_AIR or BARREL_POWER
  await ensureHitterFeatures(P.PitchMismatch, [
    ["pull_percent",     30.0,  null],  // < 38 → no PULL_AIR
    ["fb_percent",       32.0,  null],  // < 38 → no PULL_AIR
    ["barrel_pa",         4.0,  null],  // < 5.0 → no BARREL_POWER; ≥ 3.0 → power signal
    ["barrel_percent",    5.2,  null],
    ["avg_ev",           90.0,  null],  // ≥ 90 → power signal
    ["gb_percent",       40.0,  null],
    ["launch_angle",     12.0,  null],
    ["hard_hit_percent", 44.0,  null],  // ≥ 42 → power signal
    ["home_runs",        14,    null],
    ["iso",               0.175, null], // ≥ 0.160 → power signal
    ["xslg",              0.445, null],
    ["pa",              245,    null],
  ]);

  // UnknownStarter: adequate hitter, but no starter record for opp team → BLOCKED
  await ensureHitterFeatures(P.UnknownStarter, [
    ["pull_percent",     40.0,  null],
    ["fb_percent",       40.0,  null],
    ["barrel_pa",         5.5,  null],
    ["avg_ev",           93.0,  null],
    ["gb_percent",       30.0,  null],
    ["iso",               0.230, null],
    ["pa",              220,    null],
  ]);

  // LowSample: pa < 50 → INSUFFICIENT_SAMPLE
  await ensureHitterFeatures(P.LowSample, [
    ["pull_percent",     38.5,  null],
    ["fb_percent",       39.0,  null],
    ["barrel_pa",         5.2,  null],
    ["avg_ev",           92.5,  null],
    ["gb_percent",       31.0,  null],
    ["iso",               0.240, null],
    ["pa",              35,     null],  // < 50 → INSUFFICIENT_SAMPLE
  ]);

  // ── Pitcher features ───────────────────────────────────────────────────────
  // PowerPitcher: barrel% 10%, 18 HR in 250 BF → HR rate 7.2% ≥ 3% → power-contact prone
  await ensurePitcherFeatures(STARTER.PowerPitcher, [
    ["barrel_percent",    10.0, null],  // ≥ 8% → PITCH_SHAPE_MISMATCH pitcher threshold
    ["barrel_percent",     9.5, "L"],   // vs LHB
    ["barrel_percent",    10.5, "R"],   // vs RHB
    ["hard_hit_percent",  46.0, null],
    ["home_runs_allowed",  18,  null],  // 18/250 = 7.2% HR/BF ≥ 3%
    ["xslg_allowed",       0.520, null],
    ["xwoba_allowed",      0.390, null],
    ["bf",               250,   null],
  ]);

  // ElitePitcher: barrel% 3%, 4 HR in 310 BF → HR rate 1.3% < 2% → PITCHER_LOW_HR_RATE counter
  await ensurePitcherFeatures(STARTER.ElitePitcher, [
    ["barrel_percent",     3.0, null],  // < 8% → does NOT trigger PITCH_SHAPE_MISMATCH
    ["barrel_percent",     2.8, "L"],   // vs LHB
    ["barrel_percent",     3.2, "R"],   // vs RHB
    ["hard_hit_percent",   28.0, null],
    ["home_runs_allowed",    4,  null],  // 4/310 = 1.3% HR/BF < 2% → PITCHER_LOW_HR_RATE
    ["xslg_allowed",       0.330, null],
    ["xwoba_allowed",      0.290, null],
    ["bf",               310,   null],
  ]);
}

async function cleanupSlate() {
  const allPitcherIds = Object.values(STARTER);
  const pids = Object.values(P);

  // Delete park research features/snapshots for our synthetic venues
  await pool.query(
    `DELETE FROM park_research_snapshots WHERE venue_id = ANY($1)`,
    [[VENUE.HRFriendly, VENUE.PitchersPark]],
  );

  // Evidence blocks for all markets for our synthetic players
  await pool.query(
    `DELETE FROM market_research_evidence_blocks WHERE candidate_id IN (
       SELECT candidate_id FROM market_research_candidates
       WHERE player_id >= 9991300)`,
  );
  // ALL market candidates for our synthetic players
  await pool.query(`DELETE FROM market_research_candidates WHERE player_id >= 9991300`);

  await pool.query(
    `DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (
       SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk >= 9998300)`,
  );
  await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk >= 9998300`);
  await pool.query(`DELETE FROM starters WHERE game_pk >= 9998300`);

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
  await pool.query(`DELETE FROM games WHERE game_pk >= 9998300`);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Phase 3D – Home Run Research Engine", async () => {
  before(async () => {
    await cleanupSlate();
    await setupFixtures();
  });

  after(async () => {
    await cleanupSlate();
    await pool.end();
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D1: POST /api/analyst/refresh/market-research/hr returns 201 with correct shape", async () => {
    const res = await fetch(`${API}/api/analyst/refresh/market-research/hr?date=${SLATE}`, { method: "POST" });
    assert.equal(res.status, 201, "Must return HTTP 201");
    const body = await res.json();

    assert.equal(body.market, "HR", "market must equal HR");
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

    assert.ok(body.candidatesWritten > 0, "At least one candidate written");
    assert.ok(body.blockedCandidates >= 1, "UnknownStarter game must yield BLOCKED");
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D2: HR/WALK/TB/XBH independence — pull-air/barrel hitter ranks higher on HR; contact hitter ranks lower", async () => {
    // Run all four engines for the same slate
    const [hrRes, tbRes, xbhRes, walkRes] = await Promise.all([
      fetch(`${API}/api/analyst/refresh/market-research/hr?date=${SLATE}`,   { method: "POST" }),
      fetch(`${API}/api/analyst/refresh/market-research/tb?date=${SLATE}`,   { method: "POST" }),
      fetch(`${API}/api/analyst/refresh/market-research/xbh?date=${SLATE}`,  { method: "POST" }),
      fetch(`${API}/api/analyst/refresh/market-research/walk?date=${SLATE}`, { method: "POST" }),
    ]);

    assert.equal(hrRes.status,   201, "HR engine must succeed");
    assert.equal(tbRes.status,   201, "TB engine must succeed");
    assert.equal(xbhRes.status,  201, "XBH engine must succeed");
    assert.equal(walkRes.status, 201, "WALK engine must succeed");

    const [hrBoard, walkBoard] = await Promise.all([
      fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=HR`).then((r) => r.json()),
      fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=WALK`).then((r) => r.json()),
    ]);

    function getRank(board, playerId) {
      const candidate = board.candidates?.find((c) => c.playerId === playerId);
      return candidate?.researchRank ?? null;
    }

    const hrPull    = getRank(hrBoard,   P.PullAirHitter);
    const hrContact = getRank(hrBoard,   P.ContactHitter);
    const walkPull  = getRank(walkBoard, P.PullAirHitter);
    const walkContact = getRank(walkBoard, P.ContactHitter);

    assert.ok(hrPull    !== null, "PullAirHitter must appear in HR board");
    assert.ok(hrContact !== null, "ContactHitter must appear in HR board");
    assert.ok(walkPull  !== null, "PullAirHitter must appear in WALK board");
    assert.ok(walkContact !== null, "ContactHitter must appear in WALK board");

    // PullAirHitter ranks HIGHER (lower number) on HR than ContactHitter
    assert.ok(
      hrPull < hrContact,
      `PullAirHitter (HR rank ${hrPull}) must rank higher than ContactHitter (HR rank ${hrContact}) on HR`,
    );

    // ContactHitter ranks HIGHER (lower number) on WALK than PullAirHitter
    assert.ok(
      walkContact < walkPull,
      `ContactHitter (WALK rank ${walkContact}) must rank higher than PullAirHitter (WALK rank ${walkPull}) on WALK`,
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D3: Mechanism classification — PULL_AIR, BARREL_POWER, PITCH_SHAPE_MISMATCH, PARK_ENVIRONMENT assigned correctly", async () => {
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=HR`);
    const board = await boardRes.json();

    const getCandidate = (id) => board.candidates?.find((c) => c.playerId === id);

    // PullAirHitter: pull% 43 ≥ 38 AND fb% 45 ≥ 38 → PULL_AIR
    const pullAir = getCandidate(P.PullAirHitter);
    assert.ok(pullAir, "PullAirHitter must be on HR board");
    assert.equal(pullAir.primaryMechanism, "PULL_AIR",
      `PullAirHitter must have PULL_AIR (got ${pullAir.primaryMechanism})`);

    // BarrelPower: barrel_pa 8.5 ≥ 5.0 AND avg_ev 96 ≥ 92, pull% 35 < 38 → BARREL_POWER
    const barrelPwr = getCandidate(P.BarrelPower);
    assert.ok(barrelPwr, "BarrelPower must be on HR board");
    assert.equal(barrelPwr.primaryMechanism, "BARREL_POWER",
      `BarrelPower must have BARREL_POWER (got ${barrelPwr.primaryMechanism})`);

    // PitchMismatch: pitcher barrel% 10% ≥ 8% + hitter power signal (barrel_pa 4.0 ≥ 3.0)
    // pull% 30 < 38, barrel_pa 4.0 < 5.0 → not PULL_AIR or BARREL_POWER → PITCH_SHAPE_MISMATCH
    const pitchMis = getCandidate(P.PitchMismatch);
    assert.ok(pitchMis, "PitchMismatch must be on HR board");
    assert.equal(pitchMis.primaryMechanism, "PITCH_SHAPE_MISMATCH",
      `PitchMismatch must have PITCH_SHAPE_MISMATCH (got ${pitchMis.primaryMechanism})`);

    // ParkHitter: park hr_factor 1.18 ≥ 1.10; no other mechanism fires → PARK_ENVIRONMENT
    const parkH = getCandidate(P.ParkHitter);
    assert.ok(parkH, "ParkHitter must be on HR board");
    assert.equal(parkH.primaryMechanism, "PARK_ENVIRONMENT",
      `ParkHitter must have PARK_ENVIRONMENT as primary mechanism (got ${parkH.primaryMechanism})`);

    // Verify park evidence on ParkHitter shows the HR factor
    const parkEvidence = parkH.parkEvidence ?? {};
    assert.ok(
      parkEvidence.hrFactor !== undefined && parkEvidence.hrFactor >= 1.10,
      `ParkHitter parkEvidence.hrFactor must be ≥ 1.10 (got ${JSON.stringify(parkEvidence)})`,
    );
    assert.ok(
      parkEvidence.isParkFavorable === true,
      `ParkHitter parkEvidence.isParkFavorable must be true (got ${JSON.stringify(parkEvidence)})`,
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D4: Counter-evidence flags populated correctly", async () => {
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=HR`);
    const board = await boardRes.json();
    const getCandidate = (id) => board.candidates?.find((c) => c.playerId === id);

    // LowBarrel: barrel_pa 1.5 < 2.5 → LOW_BARREL_RATE; gb% 54 ≥ 50 → GROUND_BALL_DOMINANT
    const lb = getCandidate(P.LowBarrel);
    assert.ok(lb, "LowBarrel must appear on HR board");
    const lbFlags = lb.counterEvidence?.flags ?? [];
    assert.ok(
      lbFlags.includes("LOW_BARREL_RATE"),
      `LowBarrel must have LOW_BARREL_RATE flag (got: ${JSON.stringify(lbFlags)})`,
    );
    assert.ok(
      lbFlags.includes("GROUND_BALL_DOMINANT"),
      `LowBarrel must have GROUND_BALL_DOMINANT flag (got: ${JSON.stringify(lbFlags)})`,
    );

    // BarrelPower faces ElitePitcher: 4 HR / 310 BF = 1.3% < 2% → PITCHER_LOW_HR_RATE
    const bp = getCandidate(P.BarrelPower);
    assert.ok(bp, "BarrelPower must appear on HR board");
    const bpFlags = bp.counterEvidence?.flags ?? [];
    assert.ok(
      bpFlags.includes("PITCHER_LOW_HR_RATE"),
      `BarrelPower vs ElitePitcher must have PITCHER_LOW_HR_RATE flag (got: ${JSON.stringify(bpFlags)})`,
    );

    // LowBarrel in PitchersPark (hr_factor 0.88 < 0.95) → NEUTRAL_PARK
    assert.ok(
      lbFlags.includes("NEUTRAL_PARK"),
      `LowBarrel in PitchersPark must have NEUTRAL_PARK flag (got: ${JSON.stringify(lbFlags)})`,
    );

    // LowSample: pa 35 < 50 → INSUFFICIENT_SAMPLE
    const ls = getCandidate(P.LowSample);
    assert.ok(ls, "LowSample must appear on HR board");
    const lsFlags = ls.counterEvidence?.flags ?? [];
    assert.ok(
      lsFlags.includes("INSUFFICIENT_SAMPLE"),
      `LowSample must have INSUFFICIENT_SAMPLE flag (got: ${JSON.stringify(lsFlags)})`,
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D5: BLOCKED state when starter identity is unknown", async () => {
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=HR`);
    const board = await boardRes.json();
    const unknown = board.candidates?.find((c) => c.playerId === P.UnknownStarter);
    assert.ok(unknown, "UnknownStarter must appear on the HR board (RANK DON'T GATE)");
    assert.equal(unknown.researchState, "BLOCKED",
      `UnknownStarter must be BLOCKED (got ${unknown.researchState})`);
    // BLOCKED candidates must still have a research rank
    assert.ok(unknown.researchRank !== null, "BLOCKED candidate must have a rank (RANK DON'T GATE)");
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D6: No pseudo-probability or prohibited analytics fields in any HR response", async () => {
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

    // Check the POST /hr response
    const engineRes = await fetch(`${API}/api/analyst/refresh/market-research/hr?date=${SLATE}`, { method: "POST" });
    deepCheck(await engineRes.json(), "POST hr engine");

    // Check the board GET response
    const boardRes = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=HR`);
    deepCheck(await boardRes.json(), "GET market board HR");
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D7: Competition ranking — ties share the same rank; rank after tie group skips k−1", async () => {
    const rows = await pool.query(
      `SELECT player_id, research_rank
       FROM market_research_candidates
       WHERE slate_date = $1 AND market = 'HOME_RUN'
       ORDER BY research_rank, player_id`,
      [SLATE],
    );

    // Sanity: all ranks are positive integers
    for (const row of rows.rows) {
      assert.ok(Number.isInteger(row.research_rank) && row.research_rank >= 1,
        `research_rank must be ≥ 1 (got ${row.research_rank} for player ${row.player_id})`);
    }

    // Validate: rank values form a non-decreasing sequence
    const ranks = rows.rows.map((r) => r.research_rank);
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(
        ranks[i] >= ranks[i - 1],
        `Ranks must be non-decreasing (got ${ranks[i - 1]} then ${ranks[i]} at position ${i})`,
      );
    }

    // Validate: if a k-way tie exists at rank R, the next rank is R+k (1,1,3 pattern)
    const rankCounts = new Map();
    for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
    for (const [rank, count] of rankCounts.entries()) {
      if (count > 1) {
        const nextRank = [...rankCounts.keys()].find((r) => r > rank);
        if (nextRank !== undefined) {
          assert.equal(nextRank, rank + count,
            `After ${count}-way tie at rank ${rank}, next rank must be ${rank + count} (got ${nextRank})`);
        }
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D8: GET /api/analyst/market-research?market=HR returns HR candidates with evidence objects", async () => {
    const res = await fetch(`${API}/api/analyst/market-research?date=${SLATE}&market=HR`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(Array.isArray(body.candidates), "candidates must be an array");
    assert.ok(body.candidates.length > 0, "Board must have at least one HR candidate");

    // All candidates must have market = HR
    for (const c of body.candidates) {
      assert.equal(c.market, "HR", `All candidates must be market=HR (got ${c.market})`);
    }

    // At least one non-BLOCKED candidate must have all evidence objects
    const anyCandidate = body.candidates.find((c) => c.researchState !== "BLOCKED");
    assert.ok(anyCandidate, "Must have at least one non-BLOCKED candidate");

    assert.ok(anyCandidate.opportunityEvidence   !== undefined, "opportunityEvidence must be present");
    assert.ok(anyCandidate.starterMatchupEvidence !== undefined, "starterMatchupEvidence must be present");
    assert.ok(anyCandidate.bullpenPathEvidence    !== undefined, "bullpenPathEvidence must be present");
    assert.ok(anyCandidate.parkEvidence           !== undefined, "parkEvidence must be present");
    assert.ok(anyCandidate.recentVsSeasonVsCareer !== undefined, "recentVsSeasonVsCareer must be present");
    assert.ok(anyCandidate.counterEvidence        !== undefined, "counterEvidence must be present");

    // Park evidence must contain hrFactor key (may be null if unavailable)
    const parkEv = anyCandidate.parkEvidence ?? {};
    assert.ok(
      "hrFactor" in parkEv || "hrFactorPresent" in parkEv,
      `parkEvidence must contain hrFactor field (got: ${JSON.stringify(parkEv)})`,
    );

    // rankSemantics and prohibitedFields must be present
    assert.ok(typeof body.rankSemantics === "string" && body.rankSemantics.length > 0);
    assert.ok(Array.isArray(body.prohibitedFields) && body.prohibitedFields.length > 0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D9: Engine write failure → HTTP 5xx and ingest run not left as RUNNING", async () => {
    const impossibleDate = "2099-02-30";
    const res = await fetch(
      `${API}/api/analyst/refresh/market-research/hr?date=${impossibleDate}`,
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
       WHERE source_id = 'HR_ENGINE' AND status = 'RUNNING'
         AND effective_date::text = $1
         AND started_at > now() - interval '2 minutes'`,
      [impossibleDate],
    );
    assert.equal(stuck.rows.length, 0,
      `Ingest run(s) left as RUNNING after engine error: ${JSON.stringify(stuck.rows)}`);
  });

  // ────────────────────────────────────────────────────────────────────────────
  test("D10: Stale HR candidates are cleared when slate re-runs with no lineup entries", async () => {
    // Insert a game and candidate for staleDate
    await ensureGame(9998309, T.Batters, T.PowerTeam, staleDate, null);

    await pool.query(
      `INSERT INTO market_research_candidates
         (slate_date, game_pk, player_id, market, research_rank, research_state,
          primary_mechanism, secondary_mechanism,
          opportunity_evidence, starter_matchup_evidence, bullpen_path_evidence,
          park_evidence, recent_vs_season_vs_career, counter_evidence,
          rank_semantics, ingest_run_id)
       VALUES ($1, $2, $3, 'HOME_RUN', 1, 'NEUTRAL', 'BARREL_POWER', NULL,
               '{}','{}','{}','{}','{}','{}','RANK_DONT_GATE',
               (SELECT ingest_run_id FROM ingest_runs ORDER BY started_at DESC LIMIT 1))
       ON CONFLICT DO NOTHING`,
      [staleDate, 9998309, P.PullAirHitter],
    );

    const before = await pool.query(
      `SELECT count(*)::int AS cnt FROM market_research_candidates
       WHERE slate_date = $1 AND market = 'HOME_RUN'`,
      [staleDate],
    );
    assert.ok(before.rows[0].cnt >= 1, "Stale candidate must exist before reconcile");

    // Run engine for staleDate — game exists but no lineup entries → reconcile removes stale candidate
    const res = await fetch(
      `${API}/api/analyst/refresh/market-research/hr?date=${staleDate}`, { method: "POST" },
    );
    assert.ok(res.status === 200 || res.status === 201, "Engine must respond");

    const after = await pool.query(
      `SELECT count(*)::int AS cnt FROM market_research_candidates
       WHERE slate_date = $1 AND market = 'HOME_RUN' AND player_id = $2`,
      [staleDate, P.PullAirHitter],
    );
    assert.equal(after.rows[0].cnt, 0,
      "Stale HR candidate must be removed by reconcile after engine run with no lineup entries");

    // Cleanup stale game
    await pool.query(`DELETE FROM starters WHERE game_pk = 9998309`);
    await pool.query(`DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk = 9998309)`);
    await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk = 9998309`);
    await pool.query(`DELETE FROM games WHERE game_pk = 9998309`);
  });
});
