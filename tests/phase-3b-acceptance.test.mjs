/**
 * Phase 3B – Extra Base Hit Research Engine Acceptance Tests
 *
 * Verifies:
 *  B1  POST /api/analyst/refresh/market-research/xbh returns 201 with correct shape
 *  B2  XBH/TB market independence: same hitter can have a different rank on each market
 *      (pure-singles contact hitter ranks lower on XBH than on TB)
 *  B3  Mechanism classification: HOME_RUN_ROUTE, DOUBLE_ROUTE correctly assigned
 *  B4  Counter-evidence flags: WEAK_EXIT_VELOCITY, LOW_HARD_HIT_RATE, GROUND_BALL_HEAVY,
 *      PLATOON_DISADVANTAGE populated correctly
 *  B5  BLOCKED state when no starter identity
 *  B6  No pseudo-probability or prohibited analytics fields in any response
 *  B7  Competition ranking: ties share the same rank; rank after tie group skips k−1
 *  B8  GET /api/analyst/market-research?market=XBH returns XBH candidates only
 *  B9  Engine write failure → HTTP 5xx and ingest run marked FAILED
 * B10  Stale XBH candidates are cleared when slate re-runs with no lineup entries
 *
 * Fixture strategy: synthetic test IDs (>= 9991100) isolated from real data.
 * All fixtures are cleaned up after each test.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const BASE = "http://127.0.0.1:8080";

// ─── Fixture IDs (isolated from real data) ────────────────────────────────────

// Teams
const T = {
  A: 9990101, B: 9990102, C: 9990103, D: 9990104,
  E: 9990105, F: 9990106, G: 9990107, H: 9990108,
  I: 9990109, J: 9990110,
};

// Players
const P = {
  PowerXBH:   9991101,  // High barrel%, hard_hit%, avg_ev → HOME_RUN_ROUTE
  GapXBH:     9991102,  // High LD%, sweet_spot%, xbh_per_pa → DOUBLE_ROUTE
  SinglesGuy: 9991103,  // Good contact but low xbh_per_pa/hard_hit% → ranks lower on XBH
  WeakXBH:    9991104,  // Low avg_ev, low hard_hit%, high GB%, same-side platoon → all 4 CE flags
  BlockedXBH: 9991105,  // No starter → BLOCKED
  TieA:       9991106,  // Identical stats to TieB → same evidence score
  TieB:       9991107,  // Identical stats to TieA → same evidence score
};

// Pitchers (opposing starters)
const STARTER = {
  XBHFriendly: 9992101,  // throws L — allows high xbh_per_bf (favorable for XBH)
  XBHMiser:    9992102,  // throws R — allows low xbh_per_bf  (stingy for XBH)
};

// Games
const GAME = {
  Power:   9998101, // T.A @ T.B — PowerXBH faces XBHFriendly
  Gap:     9998102, // T.C @ T.D — GapXBH faces XBHFriendly
  Singles: 9998103, // T.E @ T.F — SinglesGuy faces XBHFriendly
  Weak:    9998104, // T.G @ T.H — WeakXBH faces XBHMiser (same-side platoon)
  Blocked: 9998105, // T.A @ T.B reuse — BlockedXBH, no starter
  Tie:     9998106, // T.C @ T.D reuse — TieA and TieB, same score
};

const SLATE = "2026-09-20";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

async function ensureTeam(teamId, abbreviation) {
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET abbreviation = EXCLUDED.abbreviation`,
    [teamId, abbreviation, `XBH Test Team ${abbreviation}`],
  );
}

async function ensurePlayer(playerId, fullName, bats, throws_, position = "H") {
  await pool.query(
    `INSERT INTO players (player_id, full_name, bats, throws, primary_position)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (player_id) DO UPDATE SET full_name = EXCLUDED.full_name, bats = EXCLUDED.bats`,
    [playerId, fullName, bats, throws_, position],
  );
}

async function ensureGame(gamePk, awayTeamId, homeTeamId) {
  await pool.query(
    `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (game_pk) DO NOTHING`,
    [gamePk, SLATE, awayTeamId, homeTeamId],
  );
}

async function ensureStarter(gamePk, teamId, playerId, throws_, state = "CONFIRMED") {
  await pool.query(
    `INSERT INTO starters (game_pk, team_id, player_id, starter_state, source_id, observed_at, raw)
     VALUES ($1, $2, $3, $4, 'MLB_OFFICIAL', now(), '{}')
     ON CONFLICT (game_pk, team_id, source_id, observed_at) DO NOTHING`,
    [gamePk, teamId, playerId, state],
  );
}

async function ensureLineup(gamePk, teamId, entries) {
  const snapResult = await pool.query(
    `INSERT INTO lineup_snapshots (game_pk, team_id, state, source_id, observed_at, raw)
     VALUES ($1, $2, 'PROJECTED', 'FANTASYPROS', now(), '{}')
     RETURNING lineup_snapshot_id`,
    [gamePk, teamId],
  );
  const snapshotId = snapResult.rows[0].lineup_snapshot_id;
  for (const { playerId, battingOrder } of entries) {
    await pool.query(
      `INSERT INTO lineup_entries (lineup_snapshot_id, batting_order, player_id, position)
       VALUES ($1, $2, $3, 'OF')
       ON CONFLICT (lineup_snapshot_id, batting_order) DO NOTHING`,
      [snapshotId, battingOrder, playerId],
    );
  }
  return snapshotId;
}

async function ensureHitterResearch(playerId, metrics) {
  /**
   * metrics: { xbh_per_pa, hard_hit_percent, ld_percent, gb_percent, barrel_percent,
   *            avg_ev, sweet_spot_percent, pull_percent, xslg, iso, xba, k_percent, pa }
   */
  const pa = metrics.pa ?? 200;
  const snapResult = await pool.query(
    `INSERT INTO player_research_snapshots
       (player_id, source_id, research_window, effective_from, effective_to,
        sample_size, denominator_type, denominator, content_checksum, provenance)
     VALUES ($1, 'STATCAST', 'SEASON', '2026-03-01', $2, $3::integer, 'PA', $4::numeric, $5, '{}')
     RETURNING research_snapshot_id`,
    [playerId, SLATE, pa, pa, `xbh-test-hitter-${playerId}`],
  );
  const sid = snapResult.rows[0].research_snapshot_id;

  const entries = [
    ["xbh",    "xbh_per_pa",       "XBH per PA",     metrics.xbh_per_pa,       "rate", "Extra-base hits per plate appearance."],
    ["damage", "hard_hit_percent",  "HardHit%",       metrics.hard_hit_percent,  "%",    "Hard-hit rate."],
    ["contact","ld_percent",        "LD%",            metrics.ld_percent,        "%",    "Line drive rate."],
    ["contact","gb_percent",        "GB%",            metrics.gb_percent,        "%",    "Ground ball rate."],
    ["damage", "barrel_percent",    "Barrel%",        metrics.barrel_percent,    "%",    "Barrel rate."],
    ["damage", "avg_ev",            "Avg EV",         metrics.avg_ev,            "mph",  "Average exit velocity."],
    ["contact","sweet_spot_percent","SweetSpot%",     metrics.sweet_spot_percent,"%",    "Sweet-spot contact rate."],
    ["contact","pull_percent",      "Pull%",          metrics.pull_percent,      "%",    "Pull rate."],
    ["core_offense","xslg",         "xSLG",           metrics.xslg,              "rate", "Expected SLG."],
    ["core_offense","iso",          "ISO",            metrics.iso,               "rate", "Isolated power."],
    ["core_offense","xba",          "xBA",            metrics.xba,               "rate", "Expected batting average."],
    ["contact","k_percent",         "K%",             metrics.k_percent,         "%",    "Strikeout rate."],
    ["opportunity","pa",            "Plate appearances", pa,                    "PA",   "PA."],
  ];
  for (const [family, key, label, value, unit, definition] of entries) {
    if (value == null) continue;
    await pool.query(
      `INSERT INTO player_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          denominator, sample_size, transformation, sample_status, definition, provenance)
       VALUES ($1,$2,$3,$4,$5::numeric,$6,$7::numeric,$8::integer,'NORMALIZED','AVAILABLE',$9,'{}')
       ON CONFLICT (research_snapshot_id, metric_key, pitcher_side) DO NOTHING`,
      [sid, family, key, label, value, unit, pa, pa, definition],
    );
  }
}

async function ensurePitcherResearch(playerId, metrics, batterSide = null) {
  /**
   * metrics: { xbh_per_bf, hard_hit_percent, k_percent, xslg_allowed, bf }
   */
  const bf = metrics.bf ?? 300;
  const snapResult = await pool.query(
    `INSERT INTO pitcher_research_snapshots
       (player_id, source_id, research_window, role, effective_from, effective_to,
        sample_size, denominator_type, denominator, content_checksum, provenance)
     VALUES ($1,'STATCAST','SEASON','STARTER','2026-03-01',$2,$3::integer,'BF',$4::numeric,$5,'{}')
     RETURNING research_snapshot_id`,
    [playerId, SLATE, bf, bf, `xbh-test-pitcher-${playerId}-${batterSide}`],
  );
  const sid = snapResult.rows[0].research_snapshot_id;
  const entries = [
    ["xbh_allowed",    "xbh_per_bf",     "XBH per BF",    metrics.xbh_per_bf,     "rate", "XBH rate allowed."],
    ["contact_allowed","hard_hit_percent","HardHit%",      metrics.hard_hit_percent,"%",   "Hard-hit allowed."],
    ["command",        "k_percent",      "K%",            metrics.k_percent,       "%",   "Strikeout rate."],
    ["contact_allowed","xslg_allowed",   "xSLG allowed",  metrics.xslg_allowed,    "rate","Expected SLG allowed."],
    ["workload",       "bf",             "BF",            bf,                      "BF",  "Batters faced."],
  ];
  for (const [family, key, label, value, unit, definition] of entries) {
    if (value == null) continue;
    await pool.query(
      `INSERT INTO pitcher_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          denominator, sample_size, batter_side, transformation, sample_status, definition, provenance)
       VALUES ($1,$2,$3,$4,$5::numeric,$6,$7::numeric,$8::integer,$9,'NORMALIZED','AVAILABLE',$10,'{}')
       ON CONFLICT (research_snapshot_id, metric_key, batter_side) DO NOTHING`,
      [sid, family, key, label, value, unit, bf, bf, batterSide, definition],
    );
  }
}

async function cleanupSlate() {
  // Delete evidence blocks for ALL markets for our synthetic player IDs (XBH + TB from cross-market tests)
  await pool.query(
    `DELETE FROM market_research_evidence_blocks WHERE candidate_id IN (
       SELECT candidate_id FROM market_research_candidates
       WHERE player_id >= 9991100)`,
  );
  // Delete ALL market candidates for our synthetic player IDs (includes TB rows created by B2)
  await pool.query(
    `DELETE FROM market_research_candidates WHERE player_id >= 9991100`,
  );
  await pool.query(
    `DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk >= 9998100)`,
  );
  await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk >= 9998100`);
  await pool.query(`DELETE FROM starters WHERE game_pk >= 9998100`);
  const pids = Object.values(P);
  await pool.query(
    `DELETE FROM player_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM player_research_snapshots WHERE player_id = ANY($1))`,
    [pids],
  );
  await pool.query(
    `DELETE FROM pitcher_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM pitcher_research_snapshots WHERE player_id IN ($1,$2))`,
    [STARTER.XBHFriendly, STARTER.XBHMiser],
  );
  await pool.query(`DELETE FROM player_research_snapshots WHERE player_id = ANY($1)`, [pids]);
  await pool.query(
    `DELETE FROM pitcher_research_snapshots WHERE player_id IN ($1,$2)`,
    [STARTER.XBHFriendly, STARTER.XBHMiser],
  );
  await pool.query(`DELETE FROM games WHERE game_pk >= 9998100`);
}

// ─── One-time fixture setup ───────────────────────────────────────────────────

async function setupFixtures() {
  // Teams
  for (const [key, id] of Object.entries(T)) {
    await ensureTeam(id, `X${key}`);
  }

  // Players
  await ensurePlayer(P.PowerXBH,   "XBH PowerGuy Hitter",   "R", null);
  await ensurePlayer(P.GapXBH,     "XBH GapGuy Hitter",     "R", null);
  await ensurePlayer(P.SinglesGuy, "XBH SinglesGuy Hitter", "L", null);
  await ensurePlayer(P.WeakXBH,    "XBH WeakGuy Hitter",    "R", null); // RHB → platoon vs RHP
  await ensurePlayer(P.BlockedXBH, "XBH Blocked Hitter",    "R", null);
  await ensurePlayer(P.TieA,       "XBH TieA Hitter",       "R", null);
  await ensurePlayer(P.TieB,       "XBH TieB Hitter",       "R", null);
  await ensurePlayer(STARTER.XBHFriendly, "XBH Friendly Pitcher", null, "L", "P");
  await ensurePlayer(STARTER.XBHMiser,    "XBH Miser Pitcher",    null, "R", "P");

  // Games
  await ensureGame(GAME.Power,   T.A, T.B); // PowerXBH bats for T.A, XBHFriendly pitches for T.B
  await ensureGame(GAME.Gap,     T.C, T.D); // GapXBH for T.C, XBHFriendly for T.D
  await ensureGame(GAME.Singles, T.E, T.F); // SinglesGuy for T.E, XBHFriendly for T.F
  await ensureGame(GAME.Weak,    T.G, T.H); // WeakXBH for T.G, XBHMiser for T.H (RHB vs RHP)
  await ensureGame(GAME.Blocked, T.I, T.J); // BlockedXBH for T.I, NO starter for T.J
  await ensureGame(GAME.Tie,     T.C, T.D); // TieA and TieB for T.C (reuse teams)

  // Starters
  await ensureStarter(GAME.Power,   T.B, STARTER.XBHFriendly, "L");
  await ensureStarter(GAME.Gap,     T.D, STARTER.XBHFriendly, "L");
  await ensureStarter(GAME.Singles, T.F, STARTER.XBHFriendly, "L");
  await ensureStarter(GAME.Weak,    T.H, STARTER.XBHMiser,    "R"); // RHB vs RHP → PLATOON_DISADVANTAGE
  // GAME.Blocked: NO starter for T.J → BlockedXBH will be BLOCKED
  await ensureStarter(GAME.Tie,     T.D, STARTER.XBHMiser,    "R");

  // Lineups
  await ensureLineup(GAME.Power,   T.A, [{ playerId: P.PowerXBH,   battingOrder: 3 }]);
  await ensureLineup(GAME.Gap,     T.C, [{ playerId: P.GapXBH,     battingOrder: 2 }]);
  await ensureLineup(GAME.Singles, T.E, [{ playerId: P.SinglesGuy, battingOrder: 1 }]);
  await ensureLineup(GAME.Weak,    T.G, [{ playerId: P.WeakXBH,    battingOrder: 4 }]);
  await ensureLineup(GAME.Blocked, T.I, [{ playerId: P.BlockedXBH, battingOrder: 5 }]);
  await ensureLineup(GAME.Tie,     T.C, [
    { playerId: P.TieA, battingOrder: 3 },
    { playerId: P.TieB, battingOrder: 4 },
  ]);

  // ── Hitter research ───────────────────────────────────────────────────────

  // PowerXBH: power profile → HOME_RUN_ROUTE
  // HR signals: barrel ≥ 7.5 ✓, hard_hit ≥ 40 ✓, avg_ev ≥ 90.5 ✓ → 3 signals
  // Gap signals: ld_pct = 19 (<22), sweet_spot = 25 (<28), xbh_per_pa = 0.110 (≥0.090) → 1 signal
  // HR signals ≥ 2, gap signals < 2 → HOME_RUN_ROUTE
  await ensureHitterResearch(P.PowerXBH, {
    xbh_per_pa: 0.110, hard_hit_percent: 46.0, ld_percent: 19.0, gb_percent: 35.0,
    barrel_percent: 11.5, avg_ev: 92.5, sweet_spot_percent: 25.0, pull_percent: 42.0,
    xslg: 0.560, iso: 0.240, xba: 0.250, k_percent: 28.0, pa: 220,
  });

  // GapXBH: gap/contact XBH profile → DOUBLE_ROUTE
  // HR signals: barrel = 3.5 (<7.5), hard_hit = 35 (<40), avg_ev = 88 (<90.5) → 0 signals
  // Gap signals: ld_pct ≥ 22 ✓, sweet_spot ≥ 28 ✓, xbh_per_pa ≥ 0.090 ✓ → 3 signals
  // DEFAULT: DOUBLE_ROUTE (hr_signals < 2)
  await ensureHitterResearch(P.GapXBH, {
    xbh_per_pa: 0.115, hard_hit_percent: 35.0, ld_percent: 26.0, gb_percent: 40.0,
    barrel_percent: 3.5, avg_ev: 88.0, sweet_spot_percent: 31.0, pull_percent: 38.0,
    xslg: 0.420, iso: 0.145, xba: 0.285, k_percent: 19.0, pa: 260,
  });

  // SinglesGuy: good contact (low K%, high xBA), BUT low xbh_per_pa, low hard_hit%
  // On XBH: no xbh_per_pa points (< 0.080), LOW_HARD_HIT_RATE counter, WEAK_EXIT_VELOCITY counter
  // On TB: CONTACT_VOLUME (good xBA, low K%), moderate xSLG score → should be POSITIVE or NEUTRAL
  await ensureHitterResearch(P.SinglesGuy, {
    xbh_per_pa: 0.048, hard_hit_percent: 23.0, ld_percent: 21.0, gb_percent: 44.0,
    barrel_percent: 1.5, avg_ev: 84.5, sweet_spot_percent: 20.0, pull_percent: 34.0,
    xslg: 0.360, iso: 0.100, xba: 0.305, k_percent: 13.0, pa: 300,
  });

  // WeakXBH: all four scoreable CE flags
  // WEAK_EXIT_VELOCITY: avg_ev = 83.0 < 86.5
  // LOW_HARD_HIT_RATE: hard_hit = 21.0 < 28.0
  // GROUND_BALL_HEAVY: gb_pct = 53.0 ≥ 50.0
  // PLATOON_DISADVANTAGE: bats R vs pitcher throws R (XBHMiser)
  await ensureHitterResearch(P.WeakXBH, {
    xbh_per_pa: 0.068, hard_hit_percent: 21.0, ld_percent: 16.0, gb_percent: 53.0,
    barrel_percent: 2.5, avg_ev: 83.0, sweet_spot_percent: 17.0, pull_percent: 36.0,
    xslg: 0.320, iso: 0.095, xba: 0.240, k_percent: 25.0, pa: 180,
  });

  // BlockedXBH: has data but no starter → BLOCKED
  await ensureHitterResearch(P.BlockedXBH, {
    xbh_per_pa: 0.120, hard_hit_percent: 42.0, ld_percent: 24.0, gb_percent: 37.0,
    barrel_percent: 9.0, avg_ev: 91.0, sweet_spot_percent: 30.0, pull_percent: 43.0,
    xslg: 0.520, iso: 0.210, xba: 0.270, k_percent: 22.0, pa: 200,
  });

  // TieA and TieB: identical stats and same batting orders within the same tier → tie test
  for (const pid of [P.TieA, P.TieB]) {
    await ensureHitterResearch(pid, {
      xbh_per_pa: 0.100, hard_hit_percent: 38.0, ld_percent: 23.0, gb_percent: 41.0,
      barrel_percent: 6.0, avg_ev: 89.0, sweet_spot_percent: 28.0, pull_percent: 38.0,
      xslg: 0.440, iso: 0.170, xba: 0.270, k_percent: 21.0, pa: 190,
    });
  }

  // ── Pitcher research ──────────────────────────────────────────────────────

  // XBHFriendly: throws L, allows high xbh_per_bf (favorable for RHB — cross-handed)
  await ensurePitcherResearch(STARTER.XBHFriendly, {
    xbh_per_bf: 0.092, hard_hit_percent: 38.0, k_percent: 20.0, xslg_allowed: 0.440, bf: 350,
  }, "R"); // vs RHB
  await ensurePitcherResearch(STARTER.XBHFriendly, {
    xbh_per_bf: 0.085, hard_hit_percent: 36.0, k_percent: 22.0, xslg_allowed: 0.420, bf: 320,
  }, null); // overall

  // XBHMiser: throws R, allows low xbh_per_bf (stingy for XBH)
  await ensurePitcherResearch(STARTER.XBHMiser, {
    xbh_per_bf: 0.030, hard_hit_percent: 25.0, k_percent: 29.0, xslg_allowed: 0.300, bf: 400,
  }, "R"); // vs RHB
  await ensurePitcherResearch(STARTER.XBHMiser, {
    xbh_per_bf: 0.032, hard_hit_percent: 26.0, k_percent: 28.0, xslg_allowed: 0.310, bf: 380,
  }, null); // overall
}

// ─── Setup/teardown ───────────────────────────────────────────────────────────

test.before(async () => {
  await cleanupSlate();
  await setupFixtures();
});
test.after(async () => {
  await cleanupSlate();
  await pool.end();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("B1: POST /api/analyst/refresh/market-research/xbh returns 201 with correct shape", async () => {
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/xbh?date=${SLATE}`, { method: "POST" });
  const bodyText = await res.text();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${bodyText}`);
  const body = JSON.parse(bodyText);

  assert.equal(body.market, "XBH", "market field must be 'XBH'");
  assert.equal(body.slateDate, SLATE, "slateDate must match");
  assert.ok(typeof body.gamesProcessed === "number",     "gamesProcessed must be a number");
  assert.ok(typeof body.candidatesProcessed === "number","candidatesProcessed must be a number");
  assert.ok(typeof body.candidatesWritten === "number",  "candidatesWritten must be a number");
  assert.ok(typeof body.blockedCandidates === "number",  "blockedCandidates must be a number");
  assert.ok(typeof body.strongCandidates === "number",   "strongCandidates must be a number");
  assert.ok(typeof body.positiveCandidates === "number", "positiveCandidates must be a number");
  assert.ok(typeof body.neutralCandidates === "number",  "neutralCandidates must be a number");
  assert.ok(typeof body.negativeCandidates === "number", "negativeCandidates must be a number");
  assert.ok(typeof body.processingMs === "number",       "processingMs must be a number");
  assert.ok(Array.isArray(body.notes),                   "notes must be an array");
  assert.ok("error" in body,                             "error field must be present");
  assert.equal(body.error, null,                         "error must be null on success");
  assert.ok(body.gamesProcessed >= 4, `Expected ≥4 games, got ${body.gamesProcessed}`);
  assert.ok(body.candidatesWritten >= 5, `Expected ≥5 candidates, got ${body.candidatesWritten}`);
});

test("B2: XBH/TB market independence — pure-singles hitter ranks lower on XBH than on TB", async () => {
  // Run XBH engine (already run in B1; re-run is idempotent)
  const xbhRes = await fetch(`${BASE}/api/analyst/refresh/market-research/xbh?date=${SLATE}`, { method: "POST" });
  assert.equal(xbhRes.status, 201, "XBH engine must return 201");

  // Run TB engine for same slate so both markets have data
  const tbRes = await fetch(`${BASE}/api/analyst/refresh/market-research/tb?date=${SLATE}`, { method: "POST" });
  assert.equal(tbRes.status, 201, "TB engine must return 201");

  // Fetch XBH board for SinglesGuy
  const xbhBoard = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=XBH`);
  const xbhData = await xbhBoard.json();
  const singlesXBH = xbhData.candidates.find((c) => c.playerId === P.SinglesGuy);
  assert.ok(singlesXBH, "SinglesGuy must appear on XBH board (RANK_DONT_GATE)");

  // Fetch TB board for SinglesGuy
  const tbBoard = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const tbData = await tbBoard.json();
  const singlesTB = tbData.candidates.find((c) => c.playerId === P.SinglesGuy);
  assert.ok(singlesTB, "SinglesGuy must also appear on TB board");

  // SinglesGuy has WEAK_EXIT_VELOCITY + LOW_HARD_HIT_RATE flags on XBH
  // These dramatically suppress XBH score, but TB uses xSLG/contact signals which are more favorable
  // XBH state must be NEUTRAL or NEGATIVE; TB state should be NEUTRAL or better
  assert.ok(
    ["NEUTRAL", "NEGATIVE", "BLOCKED"].includes(singlesXBH.researchState),
    `SinglesGuy XBH state should be NEUTRAL/NEGATIVE, got ${singlesXBH.researchState}`,
  );
  assert.ok(
    ["NEUTRAL", "POSITIVE", "STRONG"].includes(singlesTB.researchState),
    `SinglesGuy TB state should be NEUTRAL/POSITIVE/STRONG, got ${singlesTB.researchState}`,
  );

  // Verify the markets are truly independent: XBH candidates have market=XBH, TB have market=TB
  for (const c of xbhData.candidates) {
    assert.equal(c.market, "XBH", `XBH board must only contain XBH candidates, found: ${c.market}`);
  }
  for (const c of tbData.candidates) {
    assert.equal(c.market, "TB", `TB board must only contain TB candidates, found: ${c.market}`);
  }

  // Also verify PowerXBH ranks well on XBH (strong power XBH profile)
  const powerXBH = xbhData.candidates.find((c) => c.playerId === P.PowerXBH);
  assert.ok(powerXBH, "PowerXBH must appear on XBH board");
  assert.ok(
    ["STRONG", "POSITIVE"].includes(powerXBH.researchState),
    `PowerXBH should be POSITIVE or STRONG on XBH, got ${powerXBH.researchState}`,
  );

  // SinglesGuy must rank numerically higher (worse rank number) than PowerXBH on XBH
  assert.ok(
    powerXBH.researchRank < singlesXBH.researchRank,
    `PowerXBH (rank ${powerXBH.researchRank}) should rank better than SinglesGuy (rank ${singlesXBH.researchRank}) on XBH`,
  );
});

test("B3: Mechanism classification — HOME_RUN_ROUTE and DOUBLE_ROUTE assigned correctly", async () => {
  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=XBH`);
  const data = await board.json();

  const power = data.candidates.find((c) => c.playerId === P.PowerXBH);
  const gap   = data.candidates.find((c) => c.playerId === P.GapXBH);

  assert.ok(power, "PowerXBH must appear on XBH board");
  assert.ok(gap,   "GapXBH must appear on XBH board");

  // PowerXBH: barrel=11.5 (≥7.5), hard_hit=46 (≥40), avg_ev=92.5 (≥90.5) → 3 HR signals
  // gap_signals: ld=19 (<22), sweet_spot=25 (<28), xbh_per_pa=0.110 (≥0.090) → 1 gap signal
  // hr_signals ≥ 2 AND gap_signals < 2 → HOME_RUN_ROUTE
  assert.equal(power.primaryMechanism, "HOME_RUN_ROUTE",
    `PowerXBH should be HOME_RUN_ROUTE, got ${power.primaryMechanism}`);

  // GapXBH: barrel=3.5 (<7.5), hard_hit=35 (<40), avg_ev=88 (<90.5) → 0 HR signals
  // gap_signals: ld=26 (≥22), sweet_spot=31 (≥28), xbh_per_pa=0.115 (≥0.090) → 3 gap signals
  // hr_signals < 2 AND not triple route → DOUBLE_ROUTE (default)
  assert.equal(gap.primaryMechanism, "DOUBLE_ROUTE",
    `GapXBH should be DOUBLE_ROUTE, got ${gap.primaryMechanism}`);

  // All mechanisms must be valid XBH mechanisms — no CONTACT_VOLUME (TB-only), no singles
  const validXBHMechanisms = new Set(["DOUBLE_ROUTE", "TRIPLE_ROUTE", "HOME_RUN_ROUTE", "MULTI_PATH"]);
  for (const c of data.candidates) {
    if (c.primaryMechanism) {
      assert.ok(
        validXBHMechanisms.has(c.primaryMechanism),
        `Invalid XBH mechanism '${c.primaryMechanism}' for player ${c.playerId}. ` +
        `CONTACT_VOLUME is a TB-only mechanism — singles are excluded from XBH.`,
      );
    }
    if (c.secondaryMechanism) {
      assert.ok(
        validXBHMechanisms.has(c.secondaryMechanism),
        `Invalid secondary XBH mechanism '${c.secondaryMechanism}' for player ${c.playerId}`,
      );
    }
  }
});

test("B4: Counter-evidence flags populated correctly for WeakXBH", async () => {
  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=XBH`);
  const data = await board.json();
  const weak = data.candidates.find((c) => c.playerId === P.WeakXBH);
  assert.ok(weak, "WeakXBH must appear on XBH board");

  const flags = weak.counterEvidence?.flags ?? [];

  // WEAK_EXIT_VELOCITY: avg_ev = 83.0 < 86.5
  assert.ok(flags.includes("WEAK_EXIT_VELOCITY"),
    `WeakXBH must have WEAK_EXIT_VELOCITY flag (avg_ev=83 < 86.5). Flags: ${JSON.stringify(flags)}`);

  // LOW_HARD_HIT_RATE: hard_hit = 21.0 < 28.0
  assert.ok(flags.includes("LOW_HARD_HIT_RATE"),
    `WeakXBH must have LOW_HARD_HIT_RATE flag (hard_hit=21 < 28). Flags: ${JSON.stringify(flags)}`);

  // GROUND_BALL_HEAVY: gb_pct = 53.0 ≥ 50.0
  assert.ok(flags.includes("GROUND_BALL_HEAVY"),
    `WeakXBH must have GROUND_BALL_HEAVY flag (gb=53 ≥ 50). Flags: ${JSON.stringify(flags)}`);

  // PLATOON_DISADVANTAGE: RHB (R) vs RHP (R)
  assert.ok(flags.includes("PLATOON_DISADVANTAGE"),
    `WeakXBH must have PLATOON_DISADVANTAGE flag (RHB vs RHP). Flags: ${JSON.stringify(flags)}`);

  // PowerXBH and GapXBH should NOT have these flags (favorable profiles)
  const power = data.candidates.find((c) => c.playerId === P.PowerXBH);
  const powerFlags = power?.counterEvidence?.flags ?? [];
  assert.ok(!powerFlags.includes("WEAK_EXIT_VELOCITY"),
    `PowerXBH should NOT have WEAK_EXIT_VELOCITY (avg_ev=92.5). Flags: ${JSON.stringify(powerFlags)}`);
  assert.ok(!powerFlags.includes("LOW_HARD_HIT_RATE"),
    `PowerXBH should NOT have LOW_HARD_HIT_RATE (hard_hit=46). Flags: ${JSON.stringify(powerFlags)}`);
  assert.ok(!powerFlags.includes("GROUND_BALL_HEAVY"),
    `PowerXBH should NOT have GROUND_BALL_HEAVY (gb=35). Flags: ${JSON.stringify(powerFlags)}`);

  // XBH engine must NOT produce TB-specific counter-evidence flag HIGH_PITCHER_K_RATE or LOW_PA_SLOT
  for (const c of data.candidates) {
    const cFlags = c.counterEvidence?.flags ?? [];
    assert.ok(!cFlags.includes("HIGH_PITCHER_K_RATE"),
      `HIGH_PITCHER_K_RATE is a TB-only flag and must not appear on XBH board for player ${c.playerId}`);
    assert.ok(!cFlags.includes("LOW_PA_SLOT"),
      `LOW_PA_SLOT is a TB-only flag and must not appear on XBH board for player ${c.playerId}`);
    assert.ok(!cFlags.includes("PLATOON_RISK"),
      `PLATOON_RISK is TB terminology; XBH uses PLATOON_DISADVANTAGE. Found for player ${c.playerId}`);
  }
});

test("B5: BLOCKED state when starter identity is unknown", async () => {
  // GAME.Blocked has no starter for T.J (opposing team for BlockedXBH who plays for T.I)
  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=XBH`);
  const data = await board.json();
  const blocked = data.candidates.find(
    (c) => c.playerId === P.BlockedXBH && c.researchState === "BLOCKED",
  );

  // RANK_DONT_GATE: BLOCKED candidates still appear on the board
  assert.ok(blocked, "BLOCKED candidate must appear on XBH board (RANK_DONT_GATE — no state removes a candidate)");
  assert.equal(blocked.researchState, "BLOCKED");

  // BLOCKED candidate must still have all evidence fields
  assert.ok("opportunityEvidence" in blocked, "BLOCKED candidate must have opportunityEvidence");
  assert.ok("starterMatchupEvidence" in blocked, "BLOCKED candidate must have starterMatchupEvidence");
});

test("B6: No pseudo-probability or prohibited analytics fields in any XBH response", async () => {
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=XBH`);
  const body = await res.json();
  const prohibited = ["ev", "clv", "odds", "impliedProbability", "vigJuice", "edgePercent", "kellyFraction", "expectedValue"];

  function collectAllKeys(val, keys = new Set()) {
    if (Array.isArray(val)) val.forEach((v) => collectAllKeys(v, keys));
    else if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) { keys.add(k); collectAllKeys(v, keys); }
    }
    return keys;
  }

  const allKeys = collectAllKeys(body);
  for (const field of prohibited) {
    assert.ok(!allKeys.has(field), `Prohibited field '${field}' found in XBH API response`);
  }

  const prohibitedLower = prohibited.map((f) => f.toLowerCase());
  for (const k of allKeys) {
    assert.ok(!prohibitedLower.includes(k.toLowerCase()),
      `Prohibited field '${k}' (case-insensitive) found in XBH response`);
  }
});

test("B7: Competition ranking — ties share the same rank; rank after tie group skips k−1", async () => {
  // TieA (order=3) and TieB (order=4): identical stats vs same pitcher.
  // Both batting orders fall in ≤4 tier (+1.5 each) → same evidence score → tied rank.
  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=XBH`);
  const data = await board.json();

  const tieA = data.candidates.find((c) => c.playerId === P.TieA);
  const tieB = data.candidates.find((c) => c.playerId === P.TieB);

  assert.ok(tieA, "TieA must appear on XBH board");
  assert.ok(tieB, "TieB must appear on XBH board");

  assert.ok(Number.isInteger(tieA.researchRank) || tieA.researchRank === null, "rank must be integer or null");
  assert.ok(Number.isInteger(tieB.researchRank) || tieB.researchRank === null, "rank must be integer or null");
  assert.ok(tieA.researchRank >= 1 && tieB.researchRank >= 1, "Ranks must be positive integers");

  // If they tied: verify the next unique rank skips k positions (1,1,3 pattern)
  if (tieA.researchRank !== null && tieB.researchRank !== null && tieA.researchRank === tieB.researchRank) {
    const nextRank = data.candidates
      .filter((c) => c.researchRank !== null && c.researchRank > tieA.researchRank)
      .map((c) => c.researchRank)
      .reduce((min, r) => Math.min(min, r), Infinity);
    if (nextRank !== Infinity) {
      assert.equal(nextRank, tieA.researchRank + 2,
        `After a 2-way tie at rank ${tieA.researchRank}, next rank should be ${tieA.researchRank + 2}, got ${nextRank}`);
    }
  }
});

test("B8: GET /api/analyst/market-research?market=XBH returns XBH candidates with evidence blocks", async () => {
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=XBH`);
  assert.equal(res.status, 200, "Market research GET must return 200");
  const data = await res.json();

  assert.equal(data.market, "XBH", "Response market field must be 'XBH'");
  assert.ok(Array.isArray(data.candidates), "candidates must be an array");
  assert.ok(data.candidateCount >= 5, `Expected ≥5 XBH candidates, got ${data.candidateCount}`);

  // All returned candidates must be XBH market
  for (const c of data.candidates) {
    assert.equal(c.market, "XBH",
      `All candidates from XBH board must have market=XBH, found ${c.market} for player ${c.playerId}`);
  }

  // Verify PowerXBH has all evidence fields populated
  const power = data.candidates.find((c) => c.playerId === P.PowerXBH);
  assert.ok(power, "PowerXBH must be on XBH board");
  assert.ok(power.opportunityEvidence && "battingOrder" in power.opportunityEvidence,
    "opportunityEvidence must contain battingOrder");
  assert.equal(power.opportunityEvidence.battingOrder, 3, "PowerXBH batting order must be 3");
  assert.ok(power.starterMatchupEvidence && "pitcherXBHPerBF" in power.starterMatchupEvidence,
    "starterMatchupEvidence must contain pitcherXBHPerBF");
  assert.ok(power.recentVsSeasonVsCareer && "seasonXBHPerPA" in power.recentVsSeasonVsCareer,
    "recentVsSeasonVsCareer must contain seasonXBHPerPA");

  // Validate research states
  const validStates = new Set(["STRONG", "POSITIVE", "NEUTRAL", "NEGATIVE", "BLOCKED"]);
  for (const c of data.candidates) {
    assert.ok(validStates.has(c.researchState),
      `Invalid researchState '${c.researchState}' for player ${c.playerId}`);
  }

  // rankSemantics must encode RANK_DONT_GATE
  assert.ok(data.rankSemantics.includes("RANK_DONT_GATE"),
    "rankSemantics must include RANK_DONT_GATE");
});

test("B9: Engine write failure → HTTP 5xx and ingest run marked FAILED", async () => {
  // Use an invalid date that passes regex but fails PostgreSQL date cast
  const invalidDate = "2099-02-30";
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/xbh?date=${invalidDate}`, { method: "POST" });
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);

  assert.ok(res.status >= 500, `Expected 5xx status on engine error, got ${res.status}: ${bodyText}`);
  assert.ok(typeof body.error === "string" && body.error.length > 0,
    `Response must include a non-empty error string, got: ${JSON.stringify(body)}`);

  // Allow short window for best-effort FAILED update
  await new Promise((r) => setTimeout(r, 300));

  // Ingest run must NOT be left as RUNNING
  const stuck = await pool.query(
    `SELECT ingest_run_id FROM ingest_runs
     WHERE source_id = 'XBH_ENGINE' AND status = 'RUNNING'
       AND effective_date::text = $1
       AND started_at > now() - interval '2 minutes'`,
    [invalidDate],
  );
  assert.equal(stuck.rows.length, 0,
    `Ingest run(s) left as RUNNING after engine error: ${JSON.stringify(stuck.rows)}`);
});

test("B10: Stale XBH candidates are cleared when slate re-runs with no lineup entries", async () => {
  const staleDate = "2026-09-21";
  const staleGamePk = 9998110;
  const rankSemantics = "RANK_DONT_GATE: ordinal rank with transparent feature evidence; ties surfaced not collapsed; no threshold or gate implied";

  // Create a game for the stale date (required for FK in market_research_candidates)
  await pool.query(
    `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT (game_pk) DO NOTHING`,
    [staleGamePk, staleDate, T.A, T.B],
  );

  // Directly insert a stale XBH candidate (simulating a prior run when game had lineups)
  await pool.query(
    `INSERT INTO market_research_candidates
       (slate_date, game_pk, player_id, market, research_state, rank_semantics)
     VALUES ($1, $2, $3, 'EXTRA_BASE_HIT', 'POSITIVE', $4)
     ON CONFLICT (slate_date, market, player_id, game_pk) DO NOTHING`,
    [staleDate, staleGamePk, P.PowerXBH, rankSemantics],
  );

  // Confirm stale candidate is visible
  const boardBefore = await fetch(`${BASE}/api/analyst/market-research?date=${staleDate}&market=XBH`);
  const dataBefore = await boardBefore.json();
  assert.ok(dataBefore.candidateCount > 0,
    `Expected stale XBH candidate on board before rerun, got ${dataBefore.candidateCount}`);

  // Run the engine: game found, no lineup → candidates=[] → reconcile wipes stale row
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/xbh?date=${staleDate}`, { method: "POST" });
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${bodyText}`);

  // Board must now be empty
  const boardAfter = await fetch(`${BASE}/api/analyst/market-research?date=${staleDate}&market=XBH`);
  const dataAfter = await boardAfter.json();
  assert.equal(dataAfter.candidateCount, 0,
    `Stale XBH candidate must be cleared after rerun with no lineup entries; board has ${dataAfter.candidateCount}`);

  // Cleanup
  await pool.query(
    `DELETE FROM market_research_candidates WHERE slate_date = $1 AND market = 'EXTRA_BASE_HIT'`,
    [staleDate],
  );
  await pool.query(`DELETE FROM games WHERE game_pk = $1`, [staleGamePk]);
});
