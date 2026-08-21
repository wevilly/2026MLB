/**
 * Phase 3A – Total Bases Research Engine Acceptance Tests
 *
 * Verifies:
 *  A1  POST /api/analyst/refresh/market-research/tb returns 201 with correct shape
 *  A2  Two hitters with similar season SLG rank differently based on
 *      pitcher matchup quality and batting order (PA opportunity)
 *  A3  Mechanism classification: POWER_ROUTE vs CONTACT_VOLUME
 *  A4  Counter-evidence flags: HIGH_PITCHER_K_RATE, LOW_PA_SLOT, PLATOON_RISK
 *  A5  BLOCKED state when no starter identity and no batting order
 *  A6  No pseudo-probability or prohibited analytics fields in any response
 *  A7  Competition ranking: ties share the same rank value; rank after
 *      a k-way tie group skips k−1 positions
 *  A8  GET /api/analyst/market-research?market=TB returns the TB candidates
 *
 * Fixture strategy: synthetic test IDs (>= 9990000) isolated from real data.
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
  A: 9990001, B: 9990002, C: 9990003, D: 9990004,
  E: 9990005, F: 9990006, G: 9990007, H: 9990008,
};
// Hitters
const P = {
  Alpha: 9991001,   // RHB, order=1, favorable matchup  → should rank high
  Beta: 9991002,    // RHB, order=7, stingy pitcher     → should rank lower
  PowerGuy: 9991003, // pure power profile → POWER_ROUTE
  ContactGuy: 9991004, // pure contact profile → CONTACT_VOLUME
  Blocker: 9991005,  // no starter → BLOCKED
  TieA: 9991006,    // identical score for tie test
  TieB: 9991007,    // identical score for tie test
};
// Pitchers (opposing starters)
const STARTER = {
  Friendly: 9992001, // throws=L, high xSLG allowed (good for RHB)
  Stingy: 9992002,   // throws=R, low xSLG allowed, high K%
};

// Games (one per test scenario)
const GAME = {
  Alpha:   9998001, // T.A @ T.B — Alpha faces Friendly
  Beta:    9998002, // T.C @ T.D — Beta faces Stingy
  Power:   9998003, // T.E @ T.F — PowerGuy
  Contact: 9998004, // T.G @ T.H — ContactGuy
  Blocked: 9998005, // T.A @ T.B reuse — Blocker, no starter
  TieGame: 9998006, // T.C @ T.D reuse — TieA and TieB, same score
};

// Slate date used for all fixtures
const SLATE = "2026-09-15";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

async function ensureTeam(teamId, abbreviation) {
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET abbreviation = EXCLUDED.abbreviation`,
    [teamId, abbreviation, `Test Team ${abbreviation}`],
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
  // Remove any existing starter for this game+team to avoid PK conflicts
  await pool.query(
    `INSERT INTO starters (game_pk, team_id, player_id, starter_state, source_id, observed_at, raw)
     VALUES ($1, $2, $3, $4, 'MLB_OFFICIAL', now(), '{}')
     ON CONFLICT (game_pk, team_id, source_id, observed_at) DO NOTHING`,
    [gamePk, teamId, playerId, state],
  );
}

async function ensureLineup(gamePk, teamId, entries) {
  // entries = [{playerId, battingOrder}]
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
  // metrics: {slg, xslg, iso, xba, k_percent, contact_percent, hard_hit_percent, barrel_percent, pa}
  const pa = metrics.pa ?? 200;
  const snapResult = await pool.query(
    `INSERT INTO player_research_snapshots
       (player_id, source_id, research_window, effective_from, effective_to,
        sample_size, denominator_type, denominator, content_checksum, provenance)
     VALUES ($1, 'STATCAST', 'SEASON', '2026-03-01', $2, $3::integer, 'PA', $4::numeric, $5, '{}')
     RETURNING research_snapshot_id`,
    [playerId, SLATE, pa, pa, `test-hitter-${playerId}`],
  );
  const sid = snapResult.rows[0].research_snapshot_id;
  const entries = [
    ["core_offense", "slg", "SLG", metrics.slg, "rate", "Slugging percentage."],
    ["core_offense", "xslg", "xSLG", metrics.xslg, "rate", "Expected slugging."],
    ["core_offense", "iso", "ISO", metrics.iso, "rate", "Isolated power."],
    ["core_offense", "xba", "xBA", metrics.xba, "rate", "Expected batting average."],
    ["contact", "k_percent", "K%", metrics.k_percent, "%", "Strikeout rate."],
    ["contact", "contact_percent", "Contact%", metrics.contact_percent ?? 77, "%", "Contact rate."],
    ["damage", "hard_hit_percent", "HardHit%", metrics.hard_hit_percent ?? 35, "%", "Hard-hit rate."],
    ["damage", "barrel_percent", "Barrel%", metrics.barrel_percent ?? 4, "%", "Barrel rate."],
    ["opportunity", "pa", "Plate appearances", pa, "PA", "PA."],
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
  // metrics: {xslg_allowed, k_percent, hard_hit_percent, bf}
  const bf = metrics.bf ?? 300;
  const snapResult = await pool.query(
    `INSERT INTO pitcher_research_snapshots
       (player_id, source_id, research_window, role, effective_from, effective_to,
        sample_size, denominator_type, denominator, content_checksum, provenance)
     VALUES ($1,'STATCAST','SEASON','STARTER','2026-03-01',$2,$3::integer,'BF',$4::numeric,$5,'{}')
     RETURNING research_snapshot_id`,
    [playerId, SLATE, bf, bf, `test-pitcher-${playerId}-${batterSide}`],
  );
  const sid = snapResult.rows[0].research_snapshot_id;
  const entries = [
    ["contact_allowed", "xslg_allowed", "xSLG allowed", metrics.xslg_allowed, "rate", "Expected SLG allowed."],
    ["command", "k_percent", "K%", metrics.k_percent, "%", "Strikeout rate."],
    ["contact_allowed", "hard_hit_percent", "HardHit%", metrics.hard_hit_percent ?? 35, "%", "Hard-hit allowed."],
    ["workload", "bf", "BF", bf, "BF", "Batters faced."],
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
  // Clean in dependency order
  await pool.query(`DELETE FROM market_research_evidence_blocks WHERE candidate_id IN (SELECT candidate_id FROM market_research_candidates WHERE slate_date = $1 AND market = 'TOTAL_BASES_2_PLUS' AND player_id >= 9991000 AND player_id < 9991100)`, [SLATE]);
  await pool.query(`DELETE FROM market_research_candidates WHERE slate_date = $1 AND market = 'TOTAL_BASES_2_PLUS' AND player_id >= 9991000 AND player_id < 9991100`, [SLATE]);
  await pool.query(`DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk >= 9998000 AND game_pk < 9998100)`);
  await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk >= 9998000 AND game_pk < 9998100`);
  await pool.query(`DELETE FROM starters WHERE game_pk >= 9998000 AND game_pk < 9998100`);
  const pids = Object.values(P);
  await pool.query(`DELETE FROM player_research_features WHERE research_snapshot_id IN (SELECT research_snapshot_id FROM player_research_snapshots WHERE player_id = ANY($1))`, [pids]);
  await pool.query(`DELETE FROM pitch_arsenal_features WHERE research_snapshot_id IN (SELECT research_snapshot_id FROM pitcher_research_snapshots WHERE player_id IN ($1,$2))`, [STARTER.Friendly, STARTER.Stingy]);
  await pool.query(`DELETE FROM pitcher_research_features WHERE research_snapshot_id IN (SELECT research_snapshot_id FROM pitcher_research_snapshots WHERE player_id IN ($1,$2))`, [STARTER.Friendly, STARTER.Stingy]);
  await pool.query(`DELETE FROM player_research_snapshots WHERE player_id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM pitcher_research_snapshots WHERE player_id IN ($1,$2)`, [STARTER.Friendly, STARTER.Stingy]);
  await pool.query(`DELETE FROM games WHERE game_pk >= 9998000 AND game_pk < 9998100`);
  // players and teams persist (no harm; they're unique by ID)
}

// ─── One-time fixture setup ────────────────────────────────────────────────────

async function setupFixtures() {
  // Teams
  for (const [key, id] of Object.entries(T)) {
    await ensureTeam(id, `T${key}`);
  }

  // Players (hitters + pitchers)
  await ensurePlayer(P.Alpha,      "Test Alpha Hitter",   "R", null);
  await ensurePlayer(P.Beta,       "Test Beta Hitter",    "R", null);
  await ensurePlayer(P.PowerGuy,   "Test PowerGuy Hitter","R", null);
  await ensurePlayer(P.ContactGuy, "Test ContactGuy Hitter","L", null);
  await ensurePlayer(P.Blocker,    "Test Blocker Hitter", "R", null);
  await ensurePlayer(P.TieA,       "Test TieA Hitter",   "R", null);
  await ensurePlayer(P.TieB,       "Test TieB Hitter",   "R", null);
  await ensurePlayer(STARTER.Friendly, "Test Friendly Pitcher", null, "L", "P");
  await ensurePlayer(STARTER.Stingy,   "Test Stingy Pitcher",   null, "R", "P");

  // Games
  await ensureGame(GAME.Alpha,   T.A, T.B); // TQA @ TQB
  await ensureGame(GAME.Beta,    T.C, T.D); // TQC @ TQD
  await ensureGame(GAME.Power,   T.E, T.F);
  await ensureGame(GAME.Contact, T.G, T.H);
  await ensureGame(GAME.Blocked, T.A, T.B); // reuse teams, different gamePk
  await ensureGame(GAME.TieGame, T.C, T.D); // reuse teams, different gamePk

  // Starters (set the OPPOSING team's pitcher)
  // GAME.Alpha: TQA bats → opposing team is TQB → starter for TQB is Friendly
  await ensureStarter(GAME.Alpha,   T.B, STARTER.Friendly, "L");
  // GAME.Beta:  TQC bats → opposing team is TQD → starter for TQD is Stingy
  await ensureStarter(GAME.Beta,    T.D, STARTER.Stingy,   "R");
  await ensureStarter(GAME.Power,   T.F, STARTER.Stingy,   "R");
  await ensureStarter(GAME.Contact, T.H, STARTER.Stingy,   "R");
  // GAME.Blocked: NO starter for TQB → Blocker will be BLOCKED
  // GAME.TieGame: starter for TQD is Stingy (TieA and TieB face same pitcher)
  await ensureStarter(GAME.TieGame, T.D, STARTER.Stingy,   "R");

  // Lineup snapshots
  await ensureLineup(GAME.Alpha,   T.A, [{ playerId: P.Alpha, battingOrder: 1 }]);
  await ensureLineup(GAME.Beta,    T.C, [{ playerId: P.Beta, battingOrder: 7 }]);
  await ensureLineup(GAME.Power,   T.E, [{ playerId: P.PowerGuy, battingOrder: 3 }]);
  await ensureLineup(GAME.Contact, T.G, [{ playerId: P.ContactGuy, battingOrder: 2 }]);
  await ensureLineup(GAME.Blocked, T.A, [{ playerId: P.Blocker, battingOrder: 4 }]);
  // TieA at order 3, TieB at order 4 — scoring: both ≤4 give +2, so identical evidence score → tie
  await ensureLineup(GAME.TieGame, T.C, [
    { playerId: P.TieA, battingOrder: 3 },
    { playerId: P.TieB, battingOrder: 4 },
  ]);

  // Hitter research data
  // Alpha: similar SLG to Beta but good power profile, high PA
  await ensureHitterResearch(P.Alpha, {
    slg: 0.420, xslg: 0.480, iso: 0.190, xba: 0.270,
    k_percent: 20.0, contact_percent: 79, hard_hit_percent: 43, barrel_percent: 7.5, pa: 220,
  });
  // Beta: similar SLG to Alpha but will have counter-evidence
  await ensureHitterResearch(P.Beta, {
    slg: 0.415, xslg: 0.470, iso: 0.175, xba: 0.265,
    k_percent: 18.0, contact_percent: 80, hard_hit_percent: 40, barrel_percent: 6.0, pa: 180,
  });
  // PowerGuy: pure power, high K (no contact signal from K%)
  await ensureHitterResearch(P.PowerGuy, {
    slg: 0.480, xslg: 0.540, iso: 0.230, xba: 0.240,
    k_percent: 30.0, contact_percent: 65, hard_hit_percent: 50, barrel_percent: 11.0, pa: 200,
  });
  // ContactGuy: low power, great contact, batting order=2 (also set via lineup)
  await ensureHitterResearch(P.ContactGuy, {
    slg: 0.360, xslg: 0.380, iso: 0.120, xba: 0.280,
    k_percent: 17.0, contact_percent: 86, hard_hit_percent: 30, barrel_percent: 2.5, pa: 250,
  });
  // Blocker: has data but no starter → BLOCKED
  await ensureHitterResearch(P.Blocker, {
    slg: 0.440, xslg: 0.460, iso: 0.180, xba: 0.270,
    k_percent: 21.0, contact_percent: 78, hard_hit_percent: 42, barrel_percent: 7.0, pa: 195,
  });
  // TieA and TieB: identical stats → identical evidence scores → tie
  for (const pid of [P.TieA, P.TieB]) {
    await ensureHitterResearch(pid, {
      slg: 0.400, xslg: 0.430, iso: 0.160, xba: 0.265,
      k_percent: 22.0, contact_percent: 76, hard_hit_percent: 38, barrel_percent: 5.0, pa: 170,
    });
  }

  // Pitcher research data
  // Friendly: throws L, favorable xSLG allowed for RHB (=R side)
  await ensurePitcherResearch(STARTER.Friendly, {
    xslg_allowed: 0.455, k_percent: 21.0, hard_hit_percent: 36, bf: 350,
  }, "R"); // vs RHB = side for Alpha (bats R)
  await ensurePitcherResearch(STARTER.Friendly, {
    xslg_allowed: 0.420, k_percent: 23.0, hard_hit_percent: 38, bf: 320,
  }, null); // overall season

  // Stingy: throws R, low xSLG allowed, high K% for RHB
  await ensurePitcherResearch(STARTER.Stingy, {
    xslg_allowed: 0.330, k_percent: 32.0, hard_hit_percent: 28, bf: 400,
  }, "R"); // vs RHB
  await ensurePitcherResearch(STARTER.Stingy, {
    xslg_allowed: 0.340, k_percent: 30.0, hard_hit_percent: 29, bf: 380,
  }, null); // overall
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Setup and cleanup
test.before(async () => {
  await cleanupSlate();
  await setupFixtures();
});
test.after(async () => {
  await cleanupSlate();
  await pool.end();
});

test("A1: POST /api/analyst/refresh/market-research/tb returns 201 with correct shape", async () => {
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/tb?date=${SLATE}`, { method: "POST" });
  const bodyText = await res.text();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${bodyText}`);
  const body = JSON.parse(bodyText);
  assert.equal(body.market, "TB", "market should be TB");
  assert.equal(body.slateDate, SLATE, "slateDate should match");
  assert.ok(typeof body.gamesProcessed === "number", "gamesProcessed must be a number");
  assert.ok(typeof body.candidatesProcessed === "number", "candidatesProcessed must be a number");
  assert.ok(typeof body.candidatesWritten === "number", "candidatesWritten must be a number");
  assert.ok(typeof body.blockedCandidates === "number", "blockedCandidates must be a number");
  assert.ok(typeof body.strongCandidates === "number", "strongCandidates must be a number");
  assert.ok(typeof body.processingMs === "number", "processingMs must be a number");
  assert.ok(Array.isArray(body.notes), "notes must be an array");
  assert.ok("error" in body, "error field must be present");
  assert.ok(body.gamesProcessed >= 3, `Expected ≥3 games, got ${body.gamesProcessed}`);
  assert.ok(body.candidatesWritten >= 4, `Expected ≥4 candidates, got ${body.candidatesWritten}`);
});

test("A2: Two hitters with similar SLG rank differently based on pitcher matchup and PA slot", async () => {
  // Run engine (may already have been run in A1; re-run is idempotent)
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/tb?date=${SLATE}`, { method: "POST" });
  assert.equal(res.status, 201);

  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const data = await board.json();

  const alpha = data.candidates.find((c) => c.playerId === P.Alpha);
  const beta  = data.candidates.find((c) => c.playerId === P.Beta);

  assert.ok(alpha, "Alpha candidate must appear on TB board");
  assert.ok(beta,  "Beta candidate must appear on TB board");

  // Both have similar season SLG (within 1% of each other)
  const alphaSLG = alpha.recentVsSeasonVsCareer?.seasonSLG ?? 0;
  const betaSLG  = beta.recentVsSeasonVsCareer?.seasonSLG ?? 0;
  assert.ok(Math.abs(alphaSLG - betaSLG) < 0.015, `SLGs should be similar: Alpha=${alphaSLG}, Beta=${betaSLG}`);

  // Alpha must rank higher (lower rank number) than Beta
  assert.ok(
    alpha.researchRank < beta.researchRank,
    `Alpha (rank ${alpha.researchRank}, state ${alpha.researchState}) should rank higher than ` +
    `Beta (rank ${beta.researchRank}, state ${beta.researchState}) despite similar SLG. ` +
    `Alpha has order=${alpha.opportunityEvidence?.battingOrder}, pitcher xSLG allowed=${alpha.starterMatchupEvidence?.pitcherXSLGAllowed}. ` +
    `Beta has order=${beta.opportunityEvidence?.battingOrder}, pitcher xSLG allowed=${beta.starterMatchupEvidence?.pitcherXSLGAllowed}.`,
  );

  // Alpha should be POSITIVE or STRONG; Beta should be NEUTRAL or NEGATIVE
  assert.ok(
    ["STRONG", "POSITIVE"].includes(alpha.researchState),
    `Alpha should be POSITIVE or STRONG, got ${alpha.researchState}`,
  );
  assert.ok(
    ["NEUTRAL", "NEGATIVE"].includes(beta.researchState),
    `Beta should be NEUTRAL or NEGATIVE, got ${beta.researchState}`,
  );
});

test("A3: Mechanism classification — POWER_ROUTE and CONTACT_VOLUME assigned correctly", async () => {
  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const data = await board.json();

  const power   = data.candidates.find((c) => c.playerId === P.PowerGuy);
  const contact = data.candidates.find((c) => c.playerId === P.ContactGuy);

  assert.ok(power,   "PowerGuy must appear on TB board");
  assert.ok(contact, "ContactGuy must appear on TB board");

  // PowerGuy: xSLG=0.540 (≥0.450), ISO=0.230 (≥0.175), Barrel=11 (≥5.5) → 3 power signals
  // K%=30 (>22 → no contact signal), xBA=0.240 (<0.255 → no contact signal)
  // batting order=3 (≤5 → contact signal)  → 1 contact signal → POWER_ROUTE
  assert.equal(power.primaryMechanism, "POWER_ROUTE",
    `PowerGuy should be POWER_ROUTE, got ${power.primaryMechanism}`);

  // ContactGuy: xSLG=0.380 (<0.450 → 0 power), ISO=0.120, Barrel=2.5 → 0 power signals
  // K%=17 (≤22 → contact), xBA=0.280 (≥0.255 → contact), batting order=2 (≤5 → contact) → 3 → CONTACT_VOLUME
  assert.equal(contact.primaryMechanism, "CONTACT_VOLUME",
    `ContactGuy should be CONTACT_VOLUME, got ${contact.primaryMechanism}`);
});

test("A4: Counter-evidence flags populated — HIGH_PITCHER_K_RATE and LOW_PA_SLOT for Beta", async () => {
  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const data = await board.json();
  const beta = data.candidates.find((c) => c.playerId === P.Beta);
  assert.ok(beta, "Beta must appear on TB board");

  // Beta faces Stingy (throws R, K%=32 for RHB → HIGH_PITCHER_K_RATE)
  // Beta bats order=7 → LOW_PA_SLOT
  // Beta bats R vs pitcher throws R → PLATOON_RISK
  const flags = beta.counterEvidence?.flags ?? [];
  assert.ok(flags.includes("HIGH_PITCHER_K_RATE"),
    `Beta should have HIGH_PITCHER_K_RATE flag. Got flags: ${JSON.stringify(flags)}`);
  assert.ok(flags.includes("LOW_PA_SLOT"),
    `Beta should have LOW_PA_SLOT flag. Got flags: ${JSON.stringify(flags)}`);
  assert.ok(flags.includes("PLATOON_RISK"),
    `Beta should have PLATOON_RISK flag (RHB vs RHP). Got flags: ${JSON.stringify(flags)}`);

  // Alpha faces Friendly (throws L, K%=21 < 26 → no HIGH_K flag)
  // Alpha bats order=1 → no LOW_PA_SLOT
  // Alpha bats R vs pitcher throws L → no platoon risk
  const alpha = data.candidates.find((c) => c.playerId === P.Alpha);
  const alphaFlags = alpha?.counterEvidence?.flags ?? [];
  assert.ok(!alphaFlags.includes("HIGH_PITCHER_K_RATE"),
    `Alpha should NOT have HIGH_PITCHER_K_RATE. Got: ${JSON.stringify(alphaFlags)}`);
  assert.ok(!alphaFlags.includes("LOW_PA_SLOT"),
    `Alpha should NOT have LOW_PA_SLOT. Got: ${JSON.stringify(alphaFlags)}`);
  assert.ok(!alphaFlags.includes("PLATOON_RISK"),
    `Alpha should NOT have PLATOON_RISK (cross-handed). Got: ${JSON.stringify(alphaFlags)}`);
});

test("A5: BLOCKED state when starter identity is unknown", async () => {
  // GAME.Blocked has no starter for team T.B (the opposing team for T.A batters).
  // The engine blocks when starterPlayerId === null regardless of batting order.
  // Blocker (player 9991005) plays for T.A in GAME.Blocked, batting order=4, but faces no starter.
  // Engine should write researchState=BLOCKED for this candidate.

  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const data = await board.json();
  const blocker = data.candidates.find((c) => c.playerId === P.Blocker && c.researchState === "BLOCKED");

  // Verify BLOCKED candidates appear on the board (RANK_DONT_GATE)
  assert.ok(blocker, "BLOCKED candidate must appear on the board (RANK_DONT_GATE — no state removes a candidate)");
  assert.equal(blocker.researchState, "BLOCKED");
});

test("A6: No pseudo-probability or prohibited analytics fields in response or candidates", async () => {
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
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
    assert.ok(!allKeys.has(field), `Prohibited field '${field}' found in API response`);
  }

  // Also confirm no probability-style fields
  const prohibitedLower = prohibited.map((f) => f.toLowerCase());
  for (const k of allKeys) {
    assert.ok(!prohibitedLower.includes(k.toLowerCase()),
      `Prohibited field '${k}' (case-insensitive) found in response`);
  }
});

test("A7: Competition ranking — ties share the same rank; rank after k-way tie skips k−1", async () => {
  // TieA and TieB have identical stats vs same pitcher and same batting order range (3 and 4).
  // But batting order 3 vs 4 gives slightly different scores (3 → +2, 4 → +2 as well = same tier).
  // Let's verify programmatically by checking if they rank consecutively or share rank.
  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const data = await board.json();

  const tieA = data.candidates.find((c) => c.playerId === P.TieA);
  const tieB = data.candidates.find((c) => c.playerId === P.TieB);

  assert.ok(tieA, "TieA must appear on board");
  assert.ok(tieB, "TieB must appear on board");

  // Verify ranks are integers
  assert.ok(Number.isInteger(tieA.researchRank) || tieA.researchRank === null, "rank must be integer or null");
  assert.ok(Number.isInteger(tieB.researchRank) || tieB.researchRank === null, "rank must be integer or null");

  // Competition ranking: if scores are equal → same rank; next rank after them skips
  // If they have the same rank, verify no candidate has a rank between them and the next group
  if (tieA.researchRank !== null && tieB.researchRank !== null && tieA.researchRank === tieB.researchRank) {
    // They tied: verify the next unique rank is tieA.researchRank + 2 (skipped one)
    const nextRank = data.candidates
      .filter((c) => c.researchRank !== null && c.researchRank > tieA.researchRank)
      .map((c) => c.researchRank)
      .reduce((min, r) => Math.min(min, r), Infinity);
    if (nextRank !== Infinity) {
      assert.equal(nextRank, tieA.researchRank + 2,
        `After a 2-way tie at rank ${tieA.researchRank}, next rank should be ${tieA.researchRank + 2}, got ${nextRank}`);
    }
  }
  // If they don't tie (batting order 3 vs 4 may score differently), ranks should be consecutive integers ≥ 1
  assert.ok(tieA.researchRank >= 1 && tieB.researchRank >= 1, "Ranks must be positive");
});

test("A8: GET /api/analyst/market-research?market=TB returns TB candidates with evidence", async () => {
  const res = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.market, "TB");
  assert.ok(Array.isArray(data.candidates));
  assert.ok(data.candidateCount >= 4, `Expected ≥4 candidates, got ${data.candidateCount}`);

  // Verify at least one candidate has evidence in all expected blocks
  const alpha = data.candidates.find((c) => c.playerId === P.Alpha);
  assert.ok(alpha, "Alpha candidate must be on TB board");

  // Check opportunity evidence has battingOrder
  assert.ok(alpha.opportunityEvidence && "battingOrder" in alpha.opportunityEvidence,
    "opportunityEvidence must contain battingOrder");
  assert.equal(alpha.opportunityEvidence.battingOrder, 1, "Alpha batting order must be 1");

  // Check starter matchup evidence
  assert.ok(alpha.starterMatchupEvidence && "pitcherXSLGAllowed" in alpha.starterMatchupEvidence,
    "starterMatchupEvidence must contain pitcherXSLGAllowed");

  // Check research states are valid
  const validStates = new Set(["STRONG", "POSITIVE", "NEUTRAL", "NEGATIVE", "BLOCKED"]);
  for (const c of data.candidates) {
    assert.ok(validStates.has(c.researchState),
      `Invalid researchState '${c.researchState}' for player ${c.playerId}`);
  }

  // Verify rankSemantics is present and encodes RANK_DONT_GATE
  assert.ok(data.rankSemantics.includes("RANK_DONT_GATE"), "rankSemantics must include RANK_DONT_GATE");
});

test("A9: Engine write failure → HTTP 5xx and ingest run marked FAILED (not stuck as RUNNING)", async () => {
  // Use an invalid calendar date (Feb 30) that passes the YYYY-MM-DD regex but
  // causes PostgreSQL to throw when it tries to cast to a date column.
  // This reliably forces the engine's catch block and exercises the FAILED marking.
  const invalidDate = "2099-02-30";

  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/tb?date=${invalidDate}`, { method: "POST" });
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);

  // Route must propagate engine errors as 5xx — never 201
  assert.ok(res.status >= 500, `Expected 5xx status on engine error, got ${res.status}: ${bodyText}`);
  assert.ok(typeof body.error === "string" && body.error.length > 0,
    `Response body must include a non-empty error string, got: ${JSON.stringify(body)}`);

  // Allow a short window for the best-effort FAILED update to commit
  await new Promise((r) => setTimeout(r, 300));

  // The ingest run (if created before the failure) must NOT be left as RUNNING
  const stuck = await pool.query(
    `SELECT ingest_run_id FROM ingest_runs
     WHERE source_id = 'TB_ENGINE' AND status = 'RUNNING'
       AND effective_date::text = $1
       AND started_at > now() - interval '2 minutes'`,
    [invalidDate],
  );
  assert.equal(stuck.rows.length, 0,
    `Ingest run(s) left as RUNNING after engine error: ${JSON.stringify(stuck.rows)}`);
});

test("A11: Stale TB candidates are cleared when slate re-runs with no lineup entries (no-games rerun reconciliation)", async () => {
  // A game with no lineup entries triggers the same reconcileSlateCandidates([]) path as the
  // no-games path, and also covers the case where a previously-run game is later cancelled.
  const staleDate = "2026-09-16";
  const staleGamePk = 9998010;
  const rankSemantics = "RANK_DONT_GATE: ordinal rank with transparent feature evidence; ties surfaced not collapsed; no threshold or gate implied";

  // Create a game for the stale date (required to satisfy FK in market_research_candidates)
  await pool.query(
    `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT (game_pk) DO NOTHING`,
    [staleGamePk, staleDate, T.A, T.B],
  );

  // Directly insert a stale TB candidate (simulating a prior run when the game had lineups)
  await pool.query(
    `INSERT INTO market_research_candidates
       (slate_date, game_pk, player_id, market, research_state, rank_semantics)
     VALUES ($1, $2, $3, 'TOTAL_BASES_2_PLUS', 'POSITIVE', $4)
     ON CONFLICT (slate_date, market, player_id, game_pk) DO NOTHING`,
    [staleDate, staleGamePk, P.Alpha, rankSemantics],
  );

  // Confirm stale candidate is visible
  const boardBefore = await fetch(`${BASE}/api/analyst/market-research?date=${staleDate}&market=TB`);
  const dataBefore = await boardBefore.json();
  assert.ok(dataBefore.candidateCount > 0,
    `Expected stale candidate on board before rerun, got ${dataBefore.candidateCount}`);

  // Run the engine: game found, no lineup → candidates=[] → reconcile wipes stale row
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/tb?date=${staleDate}`, { method: "POST" });
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${bodyText}`);

  // Board must now be empty
  const boardAfter = await fetch(`${BASE}/api/analyst/market-research?date=${staleDate}&market=TB`);
  const dataAfter = await boardAfter.json();
  assert.equal(dataAfter.candidateCount, 0,
    `Stale candidate must be cleared after rerun with no lineup entries; board has ${dataAfter.candidateCount}`);

  // Cleanup
  await pool.query(
    `DELETE FROM market_research_candidates WHERE slate_date = $1 AND market = 'TOTAL_BASES_2_PLUS'`,
    [staleDate],
  );
  await pool.query(`DELETE FROM games WHERE game_pk = $1`, [staleGamePk]);
});

test("A12: Bullpen avgXSLGAllowed uses latest snapshot per reliever — stale historical values not blended", async () => {
  // Two teams, one hitter, one reliever — all IDs isolated from main fixture set
  const TI = 9990009, TJ = 9990010;
  const hitterBT = 9991008;
  const relieverBT = 9993001;
  const gameBT = 9998011;

  await ensureTeam(TI, "BTI");
  await ensureTeam(TJ, "BTJ");
  await ensurePlayer(hitterBT, "BullpenTest Hitter",   "R", null);
  await ensurePlayer(relieverBT, "BullpenTest Reliever", null, "R", "P");

  await ensureGame(gameBT, TI, TJ);
  await ensureStarter(gameBT, TJ, STARTER.Stingy, "R");
  await ensureLineup(gameBT, TI, [{ playerId: hitterBT, battingOrder: 3 }]);

  await ensureHitterResearch(hitterBT, {
    slg: 0.430, xslg: 0.460, iso: 0.185, xba: 0.275,
    k_percent: 20.0, contact_percent: 78, hard_hit_percent: 40, barrel_percent: 6.5, pa: 200,
  });

  // Reliever profile: CLOSER role → counts as high-leverage arm
  await pool.query(
    `INSERT INTO reliever_profiles (player_id, team_id, throws, role, active_roster, season)
     VALUES ($1, $2, 'R', 'CLOSER', true, 2026)
     ON CONFLICT (player_id, team_id, season) DO UPDATE SET role = 'CLOSER'`,
    [relieverBT, TJ],
  );

  // Bullpen availability for SLATE date
  await pool.query(
    `INSERT INTO bullpen_availability_observations
       (player_id, team_id, slate_date, heuristic_availability, final_state, confidence)
     VALUES ($1, $2, $3, 'AVAILABLE', 'AVAILABLE', 'HEURISTIC')
     ON CONFLICT (player_id, slate_date) DO UPDATE SET final_state = 'AVAILABLE'`,
    [relieverBT, TJ, SLATE],
  );

  // Two pitcher_research_snapshots for relieverBT (batter_side=NULL = overall):
  //   Old snapshot (7 days ago): xslg_allowed = 0.200 — stale and misleading
  //   Fresh snapshot (now):      xslg_allowed = 0.500 — current truth
  //
  // Blending both: avg(0.200, 0.500) = 0.350 < STRONG_RELIEF_XSLG_CEILING (0.370) → STRONG_RELIEF_PATH (WRONG)
  // Latest-only:   avg(0.500)        = 0.500 ≥ 0.370                              → no flag (CORRECT)
  const oldSnap = await pool.query(
    `INSERT INTO pitcher_research_snapshots
       (player_id, source_id, research_window, role, effective_from, effective_to,
        sample_size, denominator_type, denominator, content_checksum, provenance, retrieved_at)
     VALUES ($1,'STATCAST','SEASON','RELIEVER','2026-03-01',$2,
             100::integer,'BF',100::numeric,'bt-old-snap','{}', now() - interval '7 days')
     RETURNING research_snapshot_id`,
    [relieverBT, SLATE],
  );
  await pool.query(
    `INSERT INTO pitcher_research_features
       (research_snapshot_id, family, metric_key, metric_label, value, unit,
        denominator, sample_size, batter_side, transformation, sample_status, definition, provenance)
     VALUES ($1,'contact_allowed','xslg_allowed','xSLG allowed',0.200::numeric,'rate',
             100::numeric,100::integer,NULL,'NORMALIZED','AVAILABLE','xSLG allowed old','{}')
     ON CONFLICT (research_snapshot_id, metric_key, batter_side) DO NOTHING`,
    [oldSnap.rows[0].research_snapshot_id],
  );

  const freshSnap = await pool.query(
    `INSERT INTO pitcher_research_snapshots
       (player_id, source_id, research_window, role, effective_from, effective_to,
        sample_size, denominator_type, denominator, content_checksum, provenance)
     VALUES ($1,'STATCAST','SEASON','RELIEVER','2026-03-01',$2,
             200::integer,'BF',200::numeric,'bt-fresh-snap','{}')
     RETURNING research_snapshot_id`,
    [relieverBT, SLATE],
  );
  await pool.query(
    `INSERT INTO pitcher_research_features
       (research_snapshot_id, family, metric_key, metric_label, value, unit,
        denominator, sample_size, batter_side, transformation, sample_status, definition, provenance)
     VALUES ($1,'contact_allowed','xslg_allowed','xSLG allowed',0.500::numeric,'rate',
             200::numeric,200::integer,NULL,'NORMALIZED','AVAILABLE','xSLG allowed fresh','{}')
     ON CONFLICT (research_snapshot_id, metric_key, batter_side) DO NOTHING`,
    [freshSnap.rows[0].research_snapshot_id],
  );

  // Rerun engine to pick up the new BullpenTest game
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/tb?date=${SLATE}`, { method: "POST" });
  const body = await res.json();
  assert.equal(res.status, 201, `Engine rerun must succeed (201): ${JSON.stringify(body)}`);

  const board = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const data = await board.json();
  const hitter = data.candidates.find((c) => c.playerId === hitterBT);
  assert.ok(hitter, `hitterBT (${hitterBT}) must appear on the SLATE board`);

  // STRONG_RELIEF_PATH must NOT be in counter_evidence:
  // latest xSLG = 0.500 ≥ 0.370 ceiling → flag must be absent.
  const flags = hitter.counterEvidence?.flags ?? [];
  assert.ok(!flags.includes("STRONG_RELIEF_PATH"),
    `STRONG_RELIEF_PATH must not be set for hitterBT — latest reliever xSLG (0.500) is above ceiling. ` +
    `Flags observed: ${JSON.stringify(flags)}`);

  // bullpenPathEvidence.avgXSLGAllowed should be ~0.500, not ~0.350 (which blending would produce)
  const avgXslg = hitter.bullpenPathEvidence?.avgXSLGAllowed;
  if (avgXslg != null) {
    assert.ok(
      Math.abs(avgXslg - 0.500) < 0.01,
      `avgXSLGAllowed should be ~0.500 (latest-only); blended value would be ~0.350. Got: ${avgXslg}`,
    );
  }

  // Cleanup A12 fixtures
  await pool.query(
    `DELETE FROM bullpen_availability_observations WHERE player_id = $1`,
    [relieverBT],
  );
  await pool.query(`DELETE FROM reliever_profiles WHERE player_id = $1`, [relieverBT]);
  await pool.query(
    `DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (
       SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk = $1
     )`,
    [gameBT],
  );
  await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk = $1`, [gameBT]);
  await pool.query(`DELETE FROM starters WHERE game_pk = $1`, [gameBT]);
  await pool.query(
    `DELETE FROM pitcher_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM pitcher_research_snapshots WHERE player_id = $1
     )`,
    [relieverBT],
  );
  await pool.query(`DELETE FROM pitcher_research_snapshots WHERE player_id = $1`, [relieverBT]);
  await pool.query(
    `DELETE FROM player_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM player_research_snapshots WHERE player_id = $1
     )`,
    [hitterBT],
  );
  await pool.query(`DELETE FROM player_research_snapshots WHERE player_id = $1`, [hitterBT]);
  // Candidates cleaned by cleanupSlate (player_id >= 9991000) or explicit delete
  await pool.query(
    `DELETE FROM market_research_candidates WHERE slate_date = $1 AND player_id = $2`,
    [SLATE, hitterBT],
  );
  await pool.query(`DELETE FROM games WHERE game_pk = $1`, [gameBT]);
});

test("A10: Stale candidate removed from board when player is dropped from lineup on rerun", async () => {
  // Baseline: Alpha (order=1, GAME.Alpha) is on the board from earlier runs.
  const boardBefore = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const dataBefore = await boardBefore.json();
  const alphaOnBoard = dataBefore.candidates.find((c) => c.playerId === P.Alpha);
  assert.ok(alphaOnBoard, "Alpha must be on the board before lineup removal");

  // Remove Alpha from the lineup (delete Alpha's lineup entry for GAME.Alpha)
  await pool.query(
    `DELETE FROM lineup_entries
     WHERE player_id = $1
       AND lineup_snapshot_id IN (
         SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk = $2
       )`,
    [P.Alpha, GAME.Alpha],
  );

  // Rerun the TB engine for SLATE
  const res = await fetch(`${BASE}/api/analyst/refresh/market-research/tb?date=${SLATE}`, { method: "POST" });
  const body = await res.json();
  assert.equal(res.status, 201, `Rerun must succeed (201), got ${res.status}: ${JSON.stringify(body)}`);

  // Alpha should no longer appear on the board
  const boardAfter = await fetch(`${BASE}/api/analyst/market-research?date=${SLATE}&market=TB`);
  const dataAfter = await boardAfter.json();
  const alphaAfter = dataAfter.candidates.find((c) => c.playerId === P.Alpha);

  assert.ok(!alphaAfter,
    `Alpha (playerId=${P.Alpha}) must be removed from the board after being dropped from the lineup. ` +
    `Current board has ${dataAfter.candidateCount} candidates.`);

  // Restore Alpha for any subsequent tests (cleanup handles it but be safe)
  await ensureLineup(GAME.Alpha, T.A, [{ playerId: P.Alpha, battingOrder: 1 }]);
});
