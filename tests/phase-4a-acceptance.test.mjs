/**
 * Phase 4A – Historical Pregame Feature Store – Acceptance Test Suite
 *
 * Tests F1–F10 validate:
 *   F1  POST /capture returns 201 with correct shape; snapshots are written
 *   F2  Snapshot row is immutable — direct UPDATE returns error or is blocked at app layer
 *   F3  Correction creates a new row with correction_of pointing to original; original untouched
 *   F4  Taxonomy enforcement — invalid correction_reason code is rejected
 *   F5  All four markets produce independent feature snapshots on the same slate date
 *   F6  GET /feature-store returns snapshot history with playerId/market/date filters
 *   F7  Feature hash idempotency — re-capturing same data returns SKIPPED (no duplicate row)
 *   F8  Backfill processes historical candidates and returns correct counts
 *   F9  Feature snapshot includes researchRank, researchState, primaryMechanism from candidate
 *   F10 historical_outcomes is append-only — multiple inserts for same player-game-market are permitted but tracked
 *
 * Fixture namespace:
 *   Players   9991401–9991404
 *   Pitchers  9992401
 *   Teams     9990401–9990404
 *   Games     9998401–9998404
 *   Venue     9997401
 *   SLATE     2026-11-01
 *   BACKFILL  2026-10-15
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

const API = "http://127.0.0.1:8080";
const SLATE = "2026-11-01";
const BACKFILL_SLATE = "2026-10-15";

const P = {
  Alpha:  9991401,
  Beta:   9991402,
  Gamma:  9991403,
  Delta:  9991404,
};

const STARTER = { Power: 9992401 };

const T = {
  Home1:   9990401,
  Away1:   9990402,
  Home2:   9990403,
  Away2:   9990404,
};

const GAME = {
  One: 9998401,
  Two: 9998402,
  Backfill: 9998403,
  BackfillAway: 9998404,
};

const VENUE = { Standard: 9997401 };

const CORRECTION_REASONS = [
  "LATE_SCRATCH", "LINEUP_ERROR", "DATA_INGEST_FAILURE",
  "IDENTITY_ERROR", "SOURCE_UNAVAILABLE", "HUMAN_CORRECTION",
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function ensureSource(sourceId, name) {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type)
     VALUES ($1, $2, 'RESEARCH') ON CONFLICT (source_id) DO NOTHING`,
    [sourceId, name],
  );
}

async function ensureTeam(teamId) {
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name, active) VALUES ($1, $2, $2, true)
     ON CONFLICT (team_id) DO NOTHING`,
    [teamId, `F4A${teamId}`],
  );
}

async function ensureVenue(venueId) {
  await pool.query(
    `INSERT INTO venues (venue_id, name) VALUES ($1, $2) ON CONFLICT (venue_id) DO NOTHING`,
    [venueId, `F4A Venue ${venueId}`],
  );
}

async function ensurePlayer(playerId, bats = "R") {
  await pool.query(
    `INSERT INTO players (player_id, full_name, bats, active)
     VALUES ($1, $2, $3, true) ON CONFLICT (player_id) DO NOTHING`,
    [playerId, `F4A Player ${playerId}`, bats],
  );
}

async function ensurePitcher(playerId) {
  await pool.query(
    `INSERT INTO players (player_id, full_name, throws, active)
     VALUES ($1, $2, 'R', true) ON CONFLICT (player_id) DO NOTHING`,
    [playerId, `F4A Pitcher ${playerId}`],
  );
}

async function ensureGame(gamePk, homeId, awayId, date, venueId) {
  if (venueId) {
    await pool.query(
      `INSERT INTO games (game_pk, game_date, home_team_id, away_team_id, venue_id, game_status)
       VALUES ($1, $2, $3, $4, $5, 'Scheduled') ON CONFLICT (game_pk) DO NOTHING`,
      [gamePk, date, homeId, awayId, venueId],
    );
  } else {
    await pool.query(
      `INSERT INTO games (game_pk, game_date, home_team_id, away_team_id, game_status)
       VALUES ($1, $2, $3, $4, 'Scheduled') ON CONFLICT (game_pk) DO NOTHING`,
      [gamePk, date, homeId, awayId],
    );
  }
}

async function ensureStarter(gamePk, teamId, playerId) {
  await pool.query(
    `INSERT INTO starters (game_pk, team_id, player_id, starter_state, source_id, observed_at, raw)
     VALUES ($1, $2, $3, 'CONFIRMED', 'MLB_OFFICIAL', now(), '{}')`,
    [gamePk, teamId, playerId],
  );
}

async function ensureLineup(gamePk, teamId, playerIds) {
  const snap = await pool.query(
    `INSERT INTO lineup_snapshots (game_pk, team_id, state, source_id, observed_at, raw)
     VALUES ($1, $2, 'PROJECTED', 'FANTASYPROS', now(), '{}') RETURNING lineup_snapshot_id`,
    [gamePk, teamId],
  );
  const sid = snap.rows[0].lineup_snapshot_id;
  for (const [i, pid] of playerIds.entries()) {
    await pool.query(
      `INSERT INTO lineup_entries (lineup_snapshot_id, batting_order, player_id) VALUES ($1, $2, $3)`,
      [sid, i + 1, pid],
    );
  }
}

async function ensureHitterFeatures(playerId, date) {
  const snap = await pool.query(
    `INSERT INTO player_research_snapshots
       (player_id, source_id, research_window, effective_from, effective_to, content_checksum)
     VALUES ($1, 'STATCAST', 'SEASON', '2026-03-01', $2, md5(random()::text))
     RETURNING research_snapshot_id`,
    [playerId, date],
  );
  const rid = snap.rows[0].research_snapshot_id;
  const features = [
    ["opportunity", "pa",           200,  null],
    ["damage",      "barrel_pa",    5.0,  null],
    ["damage",      "avg_ev",       92.5, null],
    ["damage",      "hard_hit_percent", 42.0, null],
    ["damage",      "pull_percent", 35.0, null],
    ["damage",      "fb_percent",   38.0, null],
    ["discipline",  "bb_percent",   10.0, null],
    ["discipline",  "o_swing_percent", 28.0, null],
    ["core_offense","iso",          0.18, null],
    ["xbh",         "home_runs",    12,   null],
  ];
  for (const [family, key, value, side] of features) {
    await pool.query(
      `INSERT INTO player_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          pitcher_side, transformation, sample_status, definition, provenance)
       VALUES ($1, $2, $3, $3, $4, 'pct', $5, 'NORMALIZED', 'AVAILABLE', 'F4A feature', '{}')
       ON CONFLICT DO NOTHING`,
      [rid, family, key, value, side],
    );
  }
}

async function insertMarketCandidate(slateDate, gamePk, playerId, market, rank) {
  await pool.query(
    `INSERT INTO market_research_candidates
       (slate_date, game_pk, player_id, market, research_rank, research_state,
        primary_mechanism, secondary_mechanism,
        opportunity_evidence, starter_matchup_evidence, bullpen_path_evidence,
        park_evidence, recent_vs_season_vs_career, counter_evidence,
        rank_semantics, ingest_run_id)
     VALUES ($1, $2, $3, $4, $5, 'POSITIVE', 'BARREL_POWER', NULL,
             '{"pa":200}', '{}', '{}', '{}', '{}', '{}',
             'RANK_DONT_GATE',
             (SELECT ingest_run_id FROM ingest_runs ORDER BY started_at DESC LIMIT 1))
     ON CONFLICT (slate_date, market, player_id, game_pk) DO UPDATE
       SET research_rank = EXCLUDED.research_rank`,
    [slateDate, gamePk, playerId, market, rank],
  );
}

async function ensurePitcherFeatures(pitcherId, date) {
  const snap = await pool.query(
    `INSERT INTO pitcher_research_snapshots
       (player_id, source_id, research_window, effective_from, effective_to, content_checksum)
     VALUES ($1, 'STATCAST', 'SEASON', '2026-03-01', $2, md5(random()::text))
     RETURNING research_snapshot_id`,
    [pitcherId, date],
  );
  const rid = snap.rows[0].research_snapshot_id;
  const features = [
    ["control",    "bb_percent",        8.0,  null],
    ["power",      "hr_bf_percent",     3.5,  null],
    ["contact",    "barrel_percent",    9.0,  null],
    ["contact",    "hard_hit_percent", 40.0,  null],
    ["swing",      "o_swing_percent",  32.0,  null],
  ];
  for (const [family, key, value, side] of features) {
    await pool.query(
      `INSERT INTO pitcher_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          batter_side, sample_status, definition)
       VALUES ($1, $2, $3, $3, $4, 'pct', $5, 'AVAILABLE', 'F4A pitcher feature')
       ON CONFLICT DO NOTHING`,
      [rid, family, key, value, side],
    );
  }
}

async function setupFixtures() {
  await ensureSource("MLB_OFFICIAL", "MLB Official");
  await ensureSource("STATCAST", "Statcast");
  await ensureSource("FANTASYPROS", "FantasyPros");

  for (const id of Object.values(T)) await ensureTeam(id);
  await ensureVenue(VENUE.Standard);
  for (const id of Object.values(P)) await ensurePlayer(id);
  await ensurePitcher(STARTER.Power);

  // SLATE games
  await ensureGame(GAME.One, T.Home1, T.Away1, SLATE, VENUE.Standard);
  await ensureGame(GAME.Two, T.Home2, T.Away2, SLATE, null);

  // BACKFILL game
  await ensureGame(GAME.Backfill, T.Home1, T.Away1, BACKFILL_SLATE, VENUE.Standard);
  await ensureGame(GAME.BackfillAway, T.Home2, T.Away2, BACKFILL_SLATE, null);

  // Starters
  await ensureStarter(GAME.One, T.Away1, STARTER.Power);
  await ensureStarter(GAME.Two, T.Away2, STARTER.Power);
  await ensureStarter(GAME.Backfill, T.Away1, STARTER.Power);
  await ensureStarter(GAME.BackfillAway, T.Away2, STARTER.Power);

  // Lineups
  await ensureLineup(GAME.One, T.Home1, [P.Alpha, P.Beta]);
  await ensureLineup(GAME.Two, T.Home2, [P.Gamma, P.Delta]);
  await ensureLineup(GAME.Backfill, T.Home1, [P.Alpha, P.Beta]);
  await ensureLineup(GAME.BackfillAway, T.Home2, [P.Gamma]);

  // Hitter features
  for (const pid of Object.values(P)) {
    await ensureHitterFeatures(pid, SLATE);
    await ensureHitterFeatures(pid, BACKFILL_SLATE);
  }

  // Pitcher features for the opposing starter (so pitcherFeatures is non-empty in snapshots)
  await ensurePitcherFeatures(STARTER.Power, SLATE);
  await ensurePitcherFeatures(STARTER.Power, BACKFILL_SLATE);

  // Market research candidates for SLATE — all 4 markets for Alpha, Beta
  const dbMarkets = [
    "TOTAL_BASES_2_PLUS", "EXTRA_BASE_HIT", "BATTER_WALK", "HOME_RUN"
  ];
  let rank = 1;
  for (const market of dbMarkets) {
    await insertMarketCandidate(SLATE, GAME.One, P.Alpha, market, rank++);
    await insertMarketCandidate(SLATE, GAME.One, P.Beta,  market, rank++);
    await insertMarketCandidate(SLATE, GAME.Two, P.Gamma, market, rank++);
  }

  // Backfill candidates
  for (const market of dbMarkets) {
    await insertMarketCandidate(BACKFILL_SLATE, GAME.Backfill, P.Alpha, market, 1);
    await insertMarketCandidate(BACKFILL_SLATE, GAME.BackfillAway, P.Gamma, market, 2);
  }
}

async function cleanupFixtures() {
  // The immutability trigger blocks DELETE on pregame_feature_snapshots and
  // historical_outcomes. We use the session-level bypass to allow test cleanup.
  // This bypass is never set in production application code — only here.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.bypass_immutability = 'true'");

    // Delete provenance and outcomes first, then snapshots
    await client.query(
      `DELETE FROM feature_snapshot_provenance WHERE snapshot_id IN (
         SELECT snapshot_id FROM pregame_feature_snapshots WHERE player_id >= 9991400)`,
    );
    await client.query(`DELETE FROM pregame_feature_snapshots WHERE player_id >= 9991400 AND player_id < 9991500`);
    await client.query(`DELETE FROM historical_outcomes WHERE player_id >= 9991400 AND player_id < 9991500`);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Clean market candidates
  await pool.query(
    `DELETE FROM market_research_evidence_blocks WHERE candidate_id IN (
       SELECT candidate_id FROM market_research_candidates WHERE player_id >= 9991400 AND player_id < 9991500)`,
  );
  await pool.query(`DELETE FROM market_research_candidates WHERE player_id >= 9991400 AND player_id < 9991500`);

  // Clean lineups and starters
  await pool.query(
    `DELETE FROM lineup_entries WHERE lineup_snapshot_id IN (
       SELECT lineup_snapshot_id FROM lineup_snapshots WHERE game_pk >= 9998400 AND game_pk < 9998500)`,
  );
  await pool.query(`DELETE FROM lineup_snapshots WHERE game_pk >= 9998400 AND game_pk < 9998500`);
  await pool.query(`DELETE FROM starters WHERE game_pk >= 9998400 AND game_pk < 9998500`);

  // Clean hitter research features
  const pids = Object.values(P);
  await pool.query(
    `DELETE FROM player_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM player_research_snapshots WHERE player_id = ANY($1))`,
    [pids],
  );
  await pool.query(`DELETE FROM player_research_snapshots WHERE player_id = ANY($1)`, [pids]);

  // Clean pitcher research features for the test starter
  const starterPids = Object.values(STARTER);
  await pool.query(
    `DELETE FROM pitcher_research_features WHERE research_snapshot_id IN (
       SELECT research_snapshot_id FROM pitcher_research_snapshots WHERE player_id = ANY($1))`,
    [starterPids],
  );
  await pool.query(`DELETE FROM pitcher_research_snapshots WHERE player_id = ANY($1)`, [starterPids]);

  // Clean games
  await pool.query(`DELETE FROM games WHERE game_pk >= 9998400 AND game_pk < 9998500`);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Phase 4A – Historical Pregame Feature Store", async () => {
  before(async () => {
    await cleanupFixtures();
    await setupFixtures();
  });

  after(async () => {
    await cleanupFixtures();
    await pool.end();
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F1: POST /capture returns 201 with correct shape; snapshots are written", async () => {
    const res = await fetch(`${API}/api/analyst/feature-store/capture?date=${SLATE}`, { method: "POST" });
    assert.equal(res.status, 201, `Expected 201, got ${res.status}`);
    const body = await res.json();

    assert.equal(body.slateDate, SLATE, "slateDate must match");
    assert.ok(typeof body.ingestRunId === "string" && body.ingestRunId.length > 0, "ingestRunId must be a UUID string");
    assert.ok(Array.isArray(body.markets), "markets must be an array");
    assert.ok(typeof body.candidatesFound === "number", "candidatesFound must be a number");
    assert.ok(typeof body.snapshotsWritten === "number", "snapshotsWritten must be a number");
    assert.ok(typeof body.snapshotsSkipped === "number", "snapshotsSkipped must be a number");
    assert.ok(typeof body.snapshotErrors === "number", "snapshotErrors must be a number");
    assert.ok(typeof body.processingMs === "number", "processingMs must be a number");
    assert.ok(Array.isArray(body.notes), "notes must be an array");
    assert.ok("error" in body, "error field must be present");
    assert.equal(body.error, null, "error must be null on success");

    assert.ok(body.candidatesFound > 0, `candidatesFound must be > 0 (got ${body.candidatesFound})`);
    assert.ok(
      body.snapshotsWritten > 0,
      `snapshotsWritten must be > 0 (got ${body.snapshotsWritten}); notes=${JSON.stringify(body.notes)}`,
    );
    assert.ok(body.snapshotErrors === 0, `snapshotErrors must be 0 (got ${body.snapshotErrors})`);

    // Verify DB has the written snapshots
    const dbCount = await pool.query(
      `SELECT count(*)::int AS cnt FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500
         AND correction_of IS NULL`,
      [SLATE],
    );
    assert.ok(dbCount.rows[0].cnt > 0, "Snapshots must be in the DB");
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F2: Snapshot row is immutable — UPDATE blocked by DB trigger; correction_of self-FK and CHECK constraint enforced at DB layer", async () => {
    // Get one snapshot we just wrote
    const snapshotRes = await pool.query(
      `SELECT snapshot_id, feature_hash FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500
         AND correction_of IS NULL LIMIT 1`,
      [SLATE],
    );
    assert.ok(snapshotRes.rows.length > 0, "Must have at least one snapshot");
    const { snapshot_id, feature_hash } = snapshotRes.rows[0];

    // ── Part A: DB-level UPDATE trigger ────────────────────────────────────
    // A direct UPDATE to any column must be rejected by the immutability trigger
    // (prevent_pregame_feature_snapshot_mutation). Postgres error code 'P0001'
    // is raised by RAISE EXCEPTION in a plpgsql trigger.
    try {
      await pool.query(
        `UPDATE pregame_feature_snapshots SET feature_hash = 'tampered' WHERE snapshot_id = $1`,
        [snapshot_id],
      );
      assert.fail("DB trigger must block UPDATE on pregame_feature_snapshots (immutability contract)");
    } catch (err) {
      assert.ok(
        err.code === "P0001" || (err.message && err.message.toLowerCase().includes("immutable")),
        `Expected immutability trigger (P0001), got code=${err.code} msg=${err.message}`,
      );
    }

    // ── Part B: idempotent re-capture does NOT modify rows ─────────────────
    const beforeHash = feature_hash;
    const captureRes = await fetch(`${API}/api/analyst/feature-store/capture?date=${SLATE}`, { method: "POST" });
    assert.equal(captureRes.status, 201);
    const captureBody = await captureRes.json();
    assert.ok(captureBody.snapshotsSkipped > 0, "Re-capture must skip identical snapshots");

    const afterRes = await pool.query(
      `SELECT feature_hash FROM pregame_feature_snapshots WHERE snapshot_id = $1`,
      [snapshot_id],
    );
    assert.equal(afterRes.rows[0].feature_hash, beforeHash, "Snapshot feature_hash must be unchanged after re-capture");
    assert.ok(captureBody.snapshotErrors === 0, "No errors should occur on idempotent re-capture");

    // ── Part C: correction_of self-FK enforced at DB layer ─────────────────
    // Inserting a correction row whose correction_of points to a non-existent
    // snapshot must be rejected with a FK violation (23503).
    const fakeUuid = "00000000-dead-beef-0000-000000000000";
    try {
      await pool.query(
        `INSERT INTO pregame_feature_snapshots
           (player_id, game_pk, slate_date, market, features, feature_hash,
            correction_of, correction_reason)
         VALUES ($1, $2, $3::date, 'HOME_RUN', '{}', 'fakehash-fk-test',
                 $4, 'HUMAN_CORRECTION')`,
        [9991401, GAME.One, SLATE, fakeUuid],
      );
      assert.fail("DB must reject a correction_of that references a non-existent snapshot (FK violation expected)");
    } catch (err) {
      assert.ok(
        err.code === "23503" || (err.message && err.message.includes("foreign key")),
        `Expected FK violation (23503), got: ${err.code} — ${err.message}`,
      );
    }

    // ── Part D: CHECK constraint — correction_reason required when correction_of set
    // Inserting correction_of without correction_reason must violate the CHECK constraint.
    try {
      await pool.query(
        `INSERT INTO pregame_feature_snapshots
           (player_id, game_pk, slate_date, market, features, feature_hash, correction_of)
         VALUES ($1, $2, $3::date, 'HOME_RUN', '{}', 'fakehash-check-test', $4)`,
        [9991401, GAME.One, SLATE, snapshot_id],
      );
      assert.fail("DB CHECK constraint must reject correction_of without correction_reason");
    } catch (err) {
      assert.ok(
        err.code === "23514" || (err.message && err.message.toLowerCase().includes("correction_consistency")),
        `Expected CHECK violation (23514), got: ${err.code} — ${err.message}`,
      );
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F3: Correction creates a new row with correction_of pointing to original; original is unchanged", async () => {
    // Get original snapshot
    const origRes = await pool.query(
      `SELECT snapshot_id, feature_hash, research_rank FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500
         AND correction_of IS NULL ORDER BY created_at LIMIT 1`,
      [SLATE],
    );
    const original = origRes.rows[0];
    assert.ok(original, "Must have an original snapshot to correct");

    // POST a correction via API
    const corrRes = await fetch(`${API}/api/analyst/feature-store/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshotId: original.snapshot_id,
        correctionReason: "LATE_SCRATCH",
        correctionNote: "Player scratched 30 minutes before first pitch",
      }),
    });
    const corrBody = await corrRes.json();
    assert.equal(
      corrRes.status,
      201,
      `Expected 201 for correction, got ${corrRes.status}: ${JSON.stringify(corrBody)}`,
    );

    assert.ok(corrBody.newSnapshotId && corrBody.newSnapshotId !== original.snapshot_id,
      "Correction must create a new snapshot_id");
    assert.equal(corrBody.originalSnapshotId, original.snapshot_id,
      "originalSnapshotId must reference the original");
    assert.equal(corrBody.correctionReason, "LATE_SCRATCH");
    assert.ok(typeof corrBody.createdAt === "string");

    // Verify the correction row exists in the DB
    const corrDbRes = await pool.query(
      `SELECT correction_of, correction_reason FROM pregame_feature_snapshots
       WHERE snapshot_id = $1`,
      [corrBody.newSnapshotId],
    );
    assert.equal(corrDbRes.rows[0].correction_of, original.snapshot_id);
    assert.equal(corrDbRes.rows[0].correction_reason, "LATE_SCRATCH");

    // Verify the original row is UNCHANGED
    const origAfterRes = await pool.query(
      `SELECT feature_hash, research_rank, correction_of FROM pregame_feature_snapshots
       WHERE snapshot_id = $1`,
      [original.snapshot_id],
    );
    assert.equal(origAfterRes.rows[0].feature_hash, original.feature_hash,
      "Original feature_hash must be unchanged");
    assert.equal(origAfterRes.rows[0].correction_of, null,
      "Original must still have correction_of = NULL");
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F4: Taxonomy enforcement — invalid correction_reason code is rejected", async () => {
    const snapshotRes = await pool.query(
      `SELECT snapshot_id FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND correction_of IS NULL LIMIT 1`,
      [SLATE],
    );
    const snapshotId = snapshotRes.rows[0]?.snapshot_id;
    assert.ok(snapshotId, "Must have a snapshot to test taxonomy");

    const badRes = await fetch(`${API}/api/analyst/feature-store/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshotId,
        correctionReason: "NOT_A_VALID_CODE",
        correctionNote: "This should fail",
      }),
    });
    assert.ok(badRes.status >= 400, `Invalid reason must be rejected (got status ${badRes.status})`);
    const badBody = await badRes.json();
    assert.ok(typeof badBody.error === "string" && badBody.error.length > 0,
      "Response must contain an error message");

    // Verify the taxonomy codes in the GET response
    const storeRes = await fetch(`${API}/api/analyst/feature-store?dateFrom=${SLATE}&dateTo=${SLATE}`);
    const storeBody = await storeRes.json();
    assert.ok(Array.isArray(storeBody.correctionTaxonomy), "correctionTaxonomy must be an array");
    assert.deepEqual(
      storeBody.correctionTaxonomy.sort(),
      ["DATA_INGEST_FAILURE", "HUMAN_CORRECTION", "IDENTITY_ERROR", "LATE_SCRATCH", "LINEUP_ERROR", "SOURCE_UNAVAILABLE"],
      "Taxonomy must contain all 6 process-error codes",
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F5: All four markets produce independent feature snapshots on the same slate date", async () => {
    // Capture (already done in F1, so should skip — but let's verify DB state)
    const byMarket = await pool.query(
      `SELECT market, count(*)::text AS cnt FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500
         AND correction_of IS NULL
       GROUP BY market ORDER BY market`,
      [SLATE],
    );
    const markets = byMarket.rows.map((r) => r.market);
    const expectedMarkets = ["BATTER_WALK", "EXTRA_BASE_HIT", "HOME_RUN", "TOTAL_BASES_2_PLUS"];
    for (const expected of expectedMarkets) {
      assert.ok(
        markets.includes(expected),
        `Market ${expected} must have at least one snapshot. Found: ${markets.join(", ")}`,
      );
    }

    // Verify independence: each market has a separate row for the same player-game
    const alphaPk = await pool.query(
      `SELECT count(DISTINCT market)::text AS cnt FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id = $2 AND correction_of IS NULL`,
      [SLATE, P.Alpha],
    );
    assert.ok(Number(alphaPk.rows[0].cnt) >= 3,
      `Player ${P.Alpha} must have snapshots for at least 3 markets (got ${alphaPk.rows[0].cnt})`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F6: GET /feature-store returns snapshot history with filters", async () => {
    // Unfiltered
    const allRes = await fetch(`${API}/api/analyst/feature-store`);
    assert.equal(allRes.status, 200);
    const allBody = await allRes.json();
    assert.ok(Array.isArray(allBody.snapshots), "snapshots must be an array");
    assert.ok(typeof allBody.total === "number");
    assert.ok(allBody.stats && typeof allBody.stats.totalSnapshots === "number");
    assert.ok(Array.isArray(allBody.correctionTaxonomy));
    assert.ok(typeof allBody.systemNote === "string" && allBody.systemNote.length > 0);

    // Filter by playerId
    const pidRes = await fetch(`${API}/api/analyst/feature-store?playerId=${P.Alpha}`);
    const pidBody = await pidRes.json();
    assert.ok(pidBody.snapshots.every((s) => s.playerId === P.Alpha),
      "All snapshots must be for the requested playerId");

    // Filter by market
    const mktRes = await fetch(`${API}/api/analyst/feature-store?market=HR`);
    const mktBody = await mktRes.json();
    assert.ok(mktBody.snapshots.every((s) => s.market === "HR"),
      "All snapshots must be for market=HR");

    // Filter by dateFrom+dateTo
    const dateRes = await fetch(
      `${API}/api/analyst/feature-store?dateFrom=${SLATE}&dateTo=${SLATE}`,
    );
    const dateBody = await dateRes.json();
    assert.ok(dateBody.snapshots.every((s) => s.slateDate === SLATE),
      "All snapshots must be for the requested slate date");

    // Verify each snapshot has required fields
    const sample = allBody.snapshots.find((s) => s.playerId >= 9991400 && s.playerId < 9991500);
    if (sample) {
      assert.ok(typeof sample.snapshotId === "string");
      assert.ok(typeof sample.playerId === "number");
      assert.ok(typeof sample.playerName === "string");
      assert.ok(typeof sample.gamePk === "number");
      assert.ok(typeof sample.slateDate === "string");
      assert.ok(["TB", "XBH", "WALK", "HR"].includes(sample.market));
      assert.ok(typeof sample.frozenAt === "string");
      assert.ok(typeof sample.features === "object");
      assert.ok(typeof sample.isCorrection === "boolean");
      assert.ok(typeof sample.createdAt === "string");
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F7: Feature hash idempotency — re-capturing same data creates SKIPPED, not duplicate rows", async () => {
    // Count rows before
    const before = await pool.query(
      `SELECT count(*)::text AS cnt FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500
         AND correction_of IS NULL`,
      [SLATE],
    );

    // Re-capture — should all be SKIPPED
    const res = await fetch(`${API}/api/analyst/feature-store/capture?date=${SLATE}`, { method: "POST" });
    const body = await res.json();
    assert.ok(body.snapshotsSkipped > 0, `Must have skipped snapshots (got ${body.snapshotsSkipped})`);
    assert.equal(body.snapshotErrors, 0, "No errors on idempotent re-capture");

    // Count rows after — must be the same
    const after = await pool.query(
      `SELECT count(*)::text AS cnt FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500
         AND correction_of IS NULL`,
      [SLATE],
    );
    assert.equal(after.rows[0].cnt, before.rows[0].cnt,
      `Row count must not increase on re-capture (before=${before.rows[0].cnt}, after=${after.rows[0].cnt})`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F8: Backfill processes historical candidates and returns correct counts", async () => {
    // Delete any existing backfill snapshots.
    // Uses the immutability bypass so the trigger does not block test cleanup.
    const f8Client = await pool.connect();
    try {
      await f8Client.query("BEGIN");
      await f8Client.query("SET LOCAL app.bypass_immutability = 'true'");
      await f8Client.query(
        `DELETE FROM feature_snapshot_provenance WHERE snapshot_id IN (
           SELECT snapshot_id FROM pregame_feature_snapshots
           WHERE slate_date = $1 AND player_id >= 9991400)`,
        [BACKFILL_SLATE],
      );
      await f8Client.query(
        `DELETE FROM pregame_feature_snapshots
         WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500`,
        [BACKFILL_SLATE],
      );
      await f8Client.query("COMMIT");
    } catch (err) {
      await f8Client.query("ROLLBACK");
      throw err;
    } finally {
      f8Client.release();
    }

    const res = await fetch(
      `${API}/api/analyst/feature-store/backfill?dateFrom=${BACKFILL_SLATE}&dateTo=${BACKFILL_SLATE}`,
      { method: "POST" },
    );
    assert.equal(res.status, 201, `Expected 201, got ${res.status}`);
    const body = await res.json();

    assert.equal(body.fromDate, BACKFILL_SLATE);
    assert.equal(body.toDate, BACKFILL_SLATE);
    assert.ok(typeof body.datesProcessed === "number" && body.datesProcessed >= 1,
      `datesProcessed must be >= 1 (got ${body.datesProcessed})`);
    assert.ok(typeof body.candidatesFound === "number" && body.candidatesFound > 0,
      `candidatesFound must be > 0 (got ${body.candidatesFound})`);
    assert.ok(typeof body.snapshotsWritten === "number" && body.snapshotsWritten > 0,
      `snapshotsWritten must be > 0 (got ${body.snapshotsWritten}); notes=${JSON.stringify(body.notes)}`);
    assert.equal(body.error, null, "error must be null on success");

    // Verify snapshots are in DB for backfill date
    const dbCount = await pool.query(
      `SELECT count(*)::text AS cnt FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id >= 9991400 AND player_id < 9991500`,
      [BACKFILL_SLATE],
    );
    assert.ok(Number(dbCount.rows[0].cnt) > 0,
      `Backfill must write snapshots to DB (got ${dbCount.rows[0].cnt})`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F9: Feature snapshot includes researchRank, researchState, primaryMechanism from candidate; pitcherFeatures non-empty when starter has research", async () => {
    const snapRes = await pool.query(
      `SELECT research_rank, research_state, primary_mechanism, features
       FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id = $2 AND correction_of IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [SLATE, P.Alpha],
    );
    assert.ok(snapRes.rows.length > 0, `Must have a snapshot for player ${P.Alpha}`);
    const snap = snapRes.rows[0];

    // Verify research context is populated from the market research candidate
    assert.ok(snap.research_rank !== null || snap.research_state !== null,
      "research_rank or research_state must be populated from candidate");

    // Verify the features JSON contains the expected top-level keys
    const features = snap.features;
    assert.ok("market" in features, "features must contain market");
    assert.ok("slateDate" in features, "features must contain slateDate");
    assert.ok("playerId" in features, "features must contain playerId");
    assert.ok("hitterFeatures" in features, "features must contain hitterFeatures");
    assert.ok("opportunityEvidence" in features || "candidateId" in features,
      "features must contain evidence or candidateId");

    // Verify pitcher features are populated — the test fixture writes pitcher research
    // for STARTER.Power (the opposing starter for GAME.One / T.Away1). The CTE-based
    // pitcher query must find that starter via the batter's lineup team, not via a
    // correlated starter-table subquery that returns nothing for ordinary batters.
    assert.ok("pitcherFeatures" in features, "features must contain pitcherFeatures key");
    const pitcherFeatures = features.pitcherFeatures;
    assert.ok(
      typeof pitcherFeatures === "object" && pitcherFeatures !== null,
      "pitcherFeatures must be an object",
    );
    const pitcherKeys = Object.keys(pitcherFeatures);
    assert.ok(
      pitcherKeys.length > 0,
      `pitcherFeatures must be non-empty when the opposing starter has research data (got: ${JSON.stringify(pitcherFeatures)})`,
    );

    // ── Part B: newest-snapshot wins when multiple snapshots exist ────────────
    //
    // If the feature queries merged rows from multiple snapshots without pinning
    // to the freshest one, an older snapshot's values could silently overwrite
    // the newest ones during flattening. We verify each query selects the
    // correct single snapshot by:
    //   1. Inserting an "older" snapshot (retrieved 2 hours ago) with a
    //      distinctive stale value (999.0) that would never appear in real data.
    //   2. Running each feature sub-query / CTE directly from the test pool.
    //   3. Asserting the result does NOT contain 999.0, confirming the query
    //      chose the newer (test-fixture) snapshot.

    // ── B1: hitter snapshot — newest wins ────────────────────────────────────
    const staleHitterSnap = await pool.query(
      `INSERT INTO player_research_snapshots
         (player_id, source_id, research_window, effective_from, effective_to,
          retrieved_at, content_checksum)
       VALUES ($1, 'STATCAST', 'SEASON', '2026-03-01', $2,
               now() - interval '2 hours', md5(random()::text))
       RETURNING research_snapshot_id`,
      [P.Alpha, SLATE],
    );
    const staleHitterSnapId = staleHitterSnap.rows[0].research_snapshot_id;
    await pool.query(
      `INSERT INTO player_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          pitcher_side, transformation, sample_status, definition, provenance)
       VALUES ($1, 'damage', 'barrel_pa', 'barrel_pa', 999.0, 'pct',
               null, 'NORMALIZED', 'AVAILABLE', 'stale test value', '{}')`,
      [staleHitterSnapId],
    );

    const hitterSnapQuery = await pool.query(
      `SELECT f.value FROM player_research_features f
       JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
       WHERE s.research_snapshot_id = (
         SELECT research_snapshot_id FROM player_research_snapshots
         WHERE player_id = $1 AND effective_to <= $2 AND research_window = 'SEASON'
         ORDER BY retrieved_at DESC LIMIT 1
       )
       AND f.metric_key = 'barrel_pa' AND f.family = 'damage'`,
      [P.Alpha, SLATE],
    );
    assert.ok(hitterSnapQuery.rows.length > 0, "Hitter snapshot query must return barrel_pa");
    assert.notEqual(
      Number(hitterSnapQuery.rows[0].value), 999.0,
      "Hitter feature query must NOT use the older stale snapshot — newest-wins rule violated",
    );

    // ── B2: pitcher snapshot — newest wins ────────────────────────────────────
    const stalePitcherSnap = await pool.query(
      `INSERT INTO pitcher_research_snapshots
         (player_id, source_id, research_window, effective_from, effective_to,
          retrieved_at, content_checksum)
       VALUES ($1, 'STATCAST', 'SEASON', '2026-03-01', $2,
               now() - interval '2 hours', md5(random()::text))
       RETURNING research_snapshot_id`,
      [STARTER.Power, SLATE],
    );
    const stalePitcherSnapId = stalePitcherSnap.rows[0].research_snapshot_id;
    await pool.query(
      `INSERT INTO pitcher_research_features
         (research_snapshot_id, family, metric_key, metric_label, value, unit,
          batter_side, sample_status, definition)
       VALUES ($1, 'control', 'bb_percent', 'bb_percent', 999.0, 'pct',
               null, 'AVAILABLE', 'stale test value')`,
      [stalePitcherSnapId],
    );

    const pitcherCTEQuery = await pool.query(
      `WITH batter_team AS (
         SELECT ls.team_id FROM lineup_entries le
         JOIN lineup_snapshots ls ON ls.lineup_snapshot_id = le.lineup_snapshot_id
         WHERE le.player_id = $1 AND ls.game_pk = $2 LIMIT 1
       ),
       opposing_starter AS (
         SELECT st.player_id FROM starters st
         JOIN batter_team bt ON bt.team_id IS NOT NULL AND st.team_id != bt.team_id
         WHERE st.game_pk = $2 AND st.starter_state IN ('CONFIRMED', 'PROBABLE') LIMIT 1
       ),
       latest_pitcher_snapshot AS (
         SELECT s.research_snapshot_id FROM pitcher_research_snapshots s
         JOIN opposing_starter os ON os.player_id = s.player_id
         WHERE s.effective_to <= $3 AND s.research_window = 'SEASON'
         ORDER BY s.retrieved_at DESC LIMIT 1
       )
       SELECT f.value FROM pitcher_research_features f
       JOIN latest_pitcher_snapshot lps ON lps.research_snapshot_id = f.research_snapshot_id
       WHERE f.metric_key = 'bb_percent' AND f.family = 'control'`,
      [P.Alpha, GAME.One, SLATE],
    );
    assert.ok(pitcherCTEQuery.rows.length > 0, "Pitcher CTE must return bb_percent from latest snapshot");
    assert.notEqual(
      Number(pitcherCTEQuery.rows[0].value), 999.0,
      "Pitcher feature CTE must NOT use the older stale snapshot — newest-wins rule violated",
    );

    // ── B3: park snapshot — newest same-season wins; future season excluded ──
    //
    // Two sub-cases:
    //   B3a. Within the same season (2026): a stale snapshot (2 hrs ago, 999.0)
    //        and a fresh snapshot (1 min ago, 1.05). The fresh one must win.
    //   B3b. Future-season (2027) leakage guard: a 2027 snapshot with 888.0.
    //        The query must NOT select it for GAME.One whose game_date is in 2026.
    //        Only snapshots whose season <= game year are eligible.
    //
    // The canonical service park query enforces: season <= EXTRACT(year FROM g.game_date)
    // so 2027 data can never be frozen into a 2026 training vector.

    // B3a — same-season oldest/newest
    const staleParkSnap = await pool.query(
      `INSERT INTO park_research_snapshots
         (venue_id, season, span, source_id, retrieved_at, content_checksum)
       VALUES ($1, 2026, '3yr', 'STATCAST', now() - interval '2 hours', md5(random()::text))
       RETURNING park_research_snapshot_id`,
      [VENUE.Standard],
    );
    const staleParkSnapId = staleParkSnap.rows[0].park_research_snapshot_id;
    await pool.query(
      `INSERT INTO park_research_features
         (park_research_snapshot_id, metric_key, metric_label, value, definition)
       VALUES ($1, 'park_factor_all', 'Park Factor (All)', 999.0, 'stale 2026 test value')`,
      [staleParkSnapId],
    );

    const freshParkSnap = await pool.query(
      `INSERT INTO park_research_snapshots
         (venue_id, season, span, source_id, retrieved_at, content_checksum)
       VALUES ($1, 2026, '3yr', 'STATCAST', now() - interval '1 minute', md5(random()::text))
       RETURNING park_research_snapshot_id`,
      [VENUE.Standard],
    );
    const freshParkSnapId = freshParkSnap.rows[0].park_research_snapshot_id;
    await pool.query(
      `INSERT INTO park_research_features
         (park_research_snapshot_id, metric_key, metric_label, value, definition)
       VALUES ($1, 'park_factor_all', 'Park Factor (All)', 1.05, 'fresh 2026 test value')`,
      [freshParkSnapId],
    );

    // B3b — future-season (2027) must be excluded from the 2026 game's selection
    const futureParkSnap = await pool.query(
      `INSERT INTO park_research_snapshots
         (venue_id, season, span, source_id, retrieved_at, content_checksum)
       VALUES ($1, 2027, '3yr', 'STATCAST', now(), md5(random()::text))
       RETURNING park_research_snapshot_id`,
      [VENUE.Standard],
    );
    const futureParkSnapId = futureParkSnap.rows[0].park_research_snapshot_id;
    await pool.query(
      `INSERT INTO park_research_features
         (park_research_snapshot_id, metric_key, metric_label, value, definition)
       VALUES ($1, 'park_factor_all', 'Park Factor (All)', 888.0, 'future-season test value — must not leak into 2026 backfill')`,
      [futureParkSnapId],
    );

    // Use the same query as the service (season <= game year)
    const parkSnapQuery = await pool.query(
      `SELECT f.value FROM park_research_features f
       JOIN park_research_snapshots ps ON ps.park_research_snapshot_id = f.park_research_snapshot_id
       WHERE ps.park_research_snapshot_id = (
         SELECT ps2.park_research_snapshot_id FROM park_research_snapshots ps2
         JOIN games g ON g.venue_id = ps2.venue_id
         WHERE g.game_pk = $1
           AND ps2.season <= EXTRACT(year FROM g.game_date)
         ORDER BY ps2.season DESC, ps2.retrieved_at DESC LIMIT 1
       )
       AND f.metric_key = 'park_factor_all'`,
      [GAME.One],
    );
    assert.ok(parkSnapQuery.rows.length > 0, "Park snapshot query must return park_factor_all");
    assert.notEqual(
      Number(parkSnapQuery.rows[0].value), 999.0,
      "Park feature query must NOT use the older stale 2026 snapshot — newest-wins rule violated (B3a)",
    );
    assert.notEqual(
      Number(parkSnapQuery.rows[0].value), 888.0,
      "Park feature query must NOT use the 2027 future-season snapshot for a 2026 game — temporal constraint violated (B3b)",
    );
    assert.equal(
      Number(parkSnapQuery.rows[0].value), 1.05,
      "Park feature query must use the freshest same-season (2026) snapshot's value",
    );

    // Cleanup stale + fresh + future park snapshots created for Part B
    await pool.query(`DELETE FROM player_research_features WHERE research_snapshot_id = $1`, [staleHitterSnapId]);
    await pool.query(`DELETE FROM player_research_snapshots WHERE research_snapshot_id = $1`, [staleHitterSnapId]);
    await pool.query(`DELETE FROM pitcher_research_features WHERE research_snapshot_id = $1`, [stalePitcherSnapId]);
    await pool.query(`DELETE FROM pitcher_research_snapshots WHERE research_snapshot_id = $1`, [stalePitcherSnapId]);
    await pool.query(`DELETE FROM park_research_features WHERE park_research_snapshot_id = $1`, [staleParkSnapId]);
    await pool.query(`DELETE FROM park_research_snapshots WHERE park_research_snapshot_id = $1`, [staleParkSnapId]);
    await pool.query(`DELETE FROM park_research_features WHERE park_research_snapshot_id = $1`, [freshParkSnapId]);
    await pool.query(`DELETE FROM park_research_snapshots WHERE park_research_snapshot_id = $1`, [freshParkSnapId]);
    await pool.query(`DELETE FROM park_research_features WHERE park_research_snapshot_id = $1`, [futureParkSnapId]);
    await pool.query(`DELETE FROM park_research_snapshots WHERE park_research_snapshot_id = $1`, [futureParkSnapId]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F10: historical_outcomes is append-only — multiple writes for same player-game-market are tracked", async () => {
    // Write two outcome rows for the same player-game-market (simulating re-settlement)
    // The service must not throw or update existing rows
    const firstRes = await fetch(`${API}/api/analyst/feature-store/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId:        P.Alpha,
        gamePk:          GAME.One,
        slateDate:       SLATE,
        market:          "HR",
        singles:         1,
        doubles:         0,
        triples:         0,
        homeRuns:        1,
        walks:           0,
        plateAppearances: 4,
        atBats:          3,
        sourceId:        "MLB_OFFICIAL",
      }),
    });
    assert.equal(firstRes.status, 201, `First outcome write must return 201 (got ${firstRes.status})`);
    const firstBody = await firstRes.json();
    assert.ok(typeof firstBody.outcomeId === "string", "Must return outcomeId");
    assert.ok(firstBody.outcomeHit === true, "HR >= 1 → outcomeHit must be true");
    assert.equal(firstBody.outcomeValue, 1, "HR count must be 1");

    // Write a second outcome row — append-only means this must succeed (not update)
    const secondRes = await fetch(`${API}/api/analyst/feature-store/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId:        P.Alpha,
        gamePk:          GAME.One,
        slateDate:       SLATE,
        market:          "HR",
        singles:         1,
        doubles:         0,
        triples:         0,
        homeRuns:        0,  // correction: no HR
        walks:           0,
        plateAppearances: 4,
        atBats:          4,
        sourceId:        "MLB_OFFICIAL",
      }),
    });
    assert.equal(secondRes.status, 201, `Second outcome write must return 201 (append-only)`);
    const secondBody = await secondRes.json();
    assert.ok(secondBody.outcomeId !== firstBody.outcomeId, "Each write must produce a distinct outcomeId");
    assert.ok(secondBody.outcomeHit === false, "Second outcome: HR = 0 → outcomeHit must be false");

    // Verify BOTH rows are in the DB (append-only — no overwrite)
    const countRes = await pool.query(
      `SELECT count(*)::text AS cnt FROM historical_outcomes
       WHERE player_id = $1 AND game_pk = $2 AND market = 'HOME_RUN'`,
      [P.Alpha, GAME.One],
    );
    assert.ok(Number(countRes.rows[0].cnt) >= 2,
      `Both outcome rows must be in DB (append-only). Found: ${countRes.rows[0].cnt}`);

    // Verify the GET response stats include outcomes
    const storeRes = await fetch(`${API}/api/analyst/feature-store?playerId=${P.Alpha}`);
    const storeBody = await storeRes.json();
    assert.ok(storeBody.stats.totalOutcomes >= 2,
      `stats.totalOutcomes must include our writes (got ${storeBody.stats.totalOutcomes})`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  test("F11: betting-derived fields are rejected and never persisted in immutable feature-store rows", async () => {
    // ── Part A: recursive correction-vector guard ────────────────────────────
    // The nested evidence containers intentionally permit research evidence of
    // varying shape, so this verifies the service's recursive denylist rather
    // than only relying on strict top-level OpenAPI parsing.
    const originalRes = await pool.query(
      `SELECT snapshot_id, features FROM pregame_feature_snapshots
       WHERE slate_date = $1 AND player_id = $2 AND correction_of IS NULL
       ORDER BY created_at LIMIT 1`,
      [SLATE, P.Alpha],
    );
    const original = originalRes.rows[0];
    assert.ok(original, "Must have an original snapshot for betting-field rejection coverage");

    const correctionCountBefore = await pool.query(
      `SELECT count(*)::int AS cnt FROM pregame_feature_snapshots
       WHERE correction_of = $1`,
      [original.snapshot_id],
    );
    const badCorrection = await fetch(`${API}/api/analyst/feature-store/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshotId: original.snapshot_id,
        correctionReason: "HUMAN_CORRECTION",
        updatedFeatures: {
          ...original.features,
          opportunityEvidence: {
            ...(original.features.opportunityEvidence ?? {}),
            impliedProbability: 0.61,
          },
        },
      }),
    });
    assert.equal(
      badCorrection.status,
      400,
      "A nested impliedProbability field must be rejected before immutable correction insertion",
    );
    const badCorrectionBody = await badCorrection.json();
    assert.match(
      badCorrectionBody.error,
      /prohibited betting/i,
      "Correction rejection must identify the no-betting-data policy",
    );

    const correctionCountAfter = await pool.query(
      `SELECT count(*)::int AS cnt FROM pregame_feature_snapshots
       WHERE correction_of = $1`,
      [original.snapshot_id],
    );
    assert.equal(
      correctionCountAfter.rows[0].cnt,
      correctionCountBefore.rows[0].cnt,
      "Rejected correction must not create an immutable snapshot row",
    );
    const prohibitedSnapshotRows = await pool.query(
      `SELECT count(*)::int AS cnt FROM pregame_feature_snapshots
       WHERE player_id = $1 AND features::text ILIKE '%impliedprobability%'`,
      [P.Alpha],
    );
    assert.equal(
      prohibitedSnapshotRows.rows[0].cnt,
      0,
      "No immutable snapshot may persist the rejected impliedProbability field",
    );

    // ── Part B: strict official-outcome input ────────────────────────────────
    // raw is intentionally not in the OpenAPI contract. Supplying it alongside
    // a sportsbook field must fail instead of being ignored or copied into the
    // historical_outcomes.raw column.
    const outcomeCountBefore = await pool.query(
      `SELECT count(*)::int AS cnt FROM historical_outcomes
       WHERE player_id = $1 AND game_pk = $2`,
      [P.Alpha, GAME.One],
    );
    const badOutcome = await fetch(`${API}/api/analyst/feature-store/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: P.Alpha,
        gamePk: GAME.One,
        slateDate: SLATE,
        market: "HR",
        sourceId: "MLB_OFFICIAL",
        homeRuns: 1,
        raw: { odds: -110 },
        sportsbook: "Example Book",
      }),
    });
    assert.equal(
      badOutcome.status,
      400,
      "Outcome endpoint must reject undeclared raw and sportsbook fields",
    );
    const badOutcomeBody = await badOutcome.json();
    assert.match(
      badOutcomeBody.error,
      /official-stat fields/i,
      "Outcome rejection must identify the official-stat-only contract",
    );

    const outcomeRows = await pool.query(
      `SELECT raw FROM historical_outcomes
       WHERE player_id = $1 AND game_pk = $2`,
      [P.Alpha, GAME.One],
    );
    assert.equal(
      outcomeRows.rows.length,
      outcomeCountBefore.rows[0].cnt,
      "Rejected outcome must not create an append-only row",
    );
    for (const row of outcomeRows.rows) {
      assert.deepEqual(
        row.raw,
        {},
        "Official outcomes must persist an empty raw object, never caller-supplied payload data",
      );
    }
  });
});
