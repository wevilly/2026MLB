/**
 * Phase 3B – Extra Base Hit Research Engine
 *
 * Identifies candidate hitters via DOUBLE_ROUTE, TRIPLE_ROUTE, HOME_RUN_ROUTE,
 * and MULTI_PATH mechanisms. Singles are explicitly excluded from all mechanism
 * paths. Evaluates opportunity, pitcher matchup, bullpen path, and park context,
 * then writes structured research candidates into the shared Phase 3 contract
 * tables.
 *
 * RANK, DON'T GATE contract:
 *   research_rank is an ordinal integer only. No state value removes a candidate
 *   from the board. Ties share the same rank value and are never collapsed.
 *   No sportsbook price, odds, EV, CLV, or implied probability is produced.
 *
 * Classification rule (documented for Phase 5 audit):
 *   HOME_RUN_ROUTE  — hr_signals ≥ 2 AND gap_signals < 2
 *   MULTI_PATH      — hr_signals ≥ 2 AND gap_signals ≥ 2
 *   TRIPLE_ROUTE    — pull_pct ≥ 45 AND ld_pct ≥ 22 AND hr_signals < 2
 *   DOUBLE_ROUTE    — default (gap_signals ≥ 1 or nothing else fires); singles excluded
 *
 *   HR signals : barrel% ≥ 7.5 | hard_hit% ≥ 40 | avg_ev ≥ 90.5
 *   Gap signals: ld% ≥ 22 | sweet_spot% ≥ 28 | xbh_per_pa ≥ 0.090
 *
 * Counter-evidence (documented for Phase 5 audit):
 *   WEAK_EXIT_VELOCITY   — hitter avg EV < 86.5 mph (soft contact → singles/outs, not XBH)
 *   LOW_HARD_HIT_RATE    — hitter hard_hit% < 28% (insufficient solid-contact rate)
 *   GROUND_BALL_HEAVY    — hitter GB% ≥ 50% (grounders rarely produce XBH)
 *   PLATOON_DISADVANTAGE — same-side platoon match (bats === throws; switch hitters exempt)
 *   INSUFFICIENT_SAMPLE  — hitter PA < 50 or pitcher BF < 60 (noted; no score penalty)
 *
 * Competition ranking:
 *   Candidates sorted by evidenceScore DESC. Within a score group, alphabetical
 *   by player name as a tiebreaker for determinism. Rank jumps after a tie group
 *   (positions 1,1,3 not 1,1,2).
 */

import { pool } from "@workspace/db";
import { getBatterPitcherEvidence } from "./batter-pitcher-research";
import { getBullpenRolePath, type BullpenRolePath } from "./bullpen-foundation";

// ── Source ID ─────────────────────────────────────────────────────────────────

const XBH_ENGINE_SOURCE = "XBH_ENGINE";
const MARKET = "EXTRA_BASE_HIT";

// ── Mechanism thresholds ──────────────────────────────────────────────────────

// HR-route signals (pure power profile)
const HR_BARREL      = 7.5;   // barrel% — elite launch angle + exit velocity
const HR_HARD_HIT    = 40.0;  // hard_hit% — consistent solid contact
const HR_AVG_EV      = 90.5;  // avg exit velocity (mph) — raw power output

// Gap-route signals (doubles / XBH frequency)
const GAP_LD_PCT     = 22.0;  // ld_percent — line drive tendency → XBH lanes
const GAP_SWEET_SPOT = 28.0;  // sweet_spot_percent — optimal launch angle for extra bases
const GAP_XBH_PER_PA = 0.090; // xbh_per_pa — observed XBH rate

// Triple-route specific (pull tendency + gap contact)
const TRIPLE_PULL_PCT = 45.0;  // pull_percent — must pull for triples
const TRIPLE_LD_PCT   = 22.0;  // ld_percent  — must have gap contact tendency too

// ── Counter-evidence thresholds ───────────────────────────────────────────────

const WEAK_EV_THRESHOLD           = 86.5; // avg EV below → soft contact profile
const LOW_HARD_HIT_THRESHOLD      = 28.0; // hard_hit% below → insufficient solid contact
const GROUND_BALL_HEAVY_THRESHOLD = 50.0; // GB% at or above → heavy grounder tendency
const MIN_HITTER_PA  = 50;
const MIN_PITCHER_BF = 60;

// ── Evidence score thresholds (not exposed externally) ────────────────────────

const SCORE_STRONG   = 6;
const SCORE_POSITIVE = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

type N = number | null;
type FeatureMap = Map<string, N>;

export type XBHMechanism = "DOUBLE_ROUTE" | "TRIPLE_ROUTE" | "HOME_RUN_ROUTE" | "MULTI_PATH";
export type XBHResearchState = "STRONG" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "BLOCKED";

interface SlateGame {
  gamePk: number;
  venueId: number | null;
  awayTeamId: number;
  homeTeamId: number;
}

interface LineupPlayer {
  playerId: number;
  playerName: string;
  bats: string | null;
  battingOrder: number;
  gamePk: number;
  teamId: number;
  lineupState: string;
  oppTeamId: number;
  venueId: number | null;
}

interface StarterInfo {
  playerId: number | null;
  throws: string | null;
  starterState: string;
}

interface BullpenSummary extends BullpenRolePath {
  availableHighLeverage: number;
  avgXSLGAllowed: N;
  metricArmCount: number;
}

interface XBHCandidate {
  playerId: number;
  playerName: string;
  gamePk: number;
  slateDate: string;
  battingOrder: number | null;
  lineupState: string;
  hitterBats: string | null;
  starterPlayerId: number | null;
  starterThrows: string | null;
  starterState: string;
  hitterFeatures: FeatureMap;
  pitcherFeatures: FeatureMap;
  parkFeatures: FeatureMap;
  bullpen: BullpenSummary;
  mechanism: XBHMechanism;
  secondaryMechanism: XBHMechanism | null;
  researchState: XBHResearchState;
  counterEvidence: string[];
  evidenceScore: number;
  researchRank: number | null;
  missingData: string[];
}

export interface XBHEngineResult {
  market: string;
  slateDate: string;
  gamesProcessed: number;
  candidatesProcessed: number;
  candidatesWritten: number;
  blockedCandidates: number;
  strongCandidates: number;
  positiveCandidates: number;
  neutralCandidates: number;
  negativeCandidates: number;
  processingMs: number;
  notes: string[];
  error: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const n = (map: FeatureMap, key: string): N => map.get(key) ?? null;

/** Key for hitter features split by pitcher hand */
const hk = (metricKey: string, pitcherHand: string | null) =>
  pitcherHand ? `${metricKey}:${pitcherHand}` : metricKey;

/** Key for pitcher features split by batter side */
const pk = (metricKey: string, batterSide: string | null) =>
  batterSide ? `${metricKey}:${batterSide}` : metricKey;

/**
 * Resolve the effective batter side for platoon lookup.
 * Switch hitters bat opposite the pitcher.
 */
function resolveBatterSide(bats: string | null, pitcherThrows: string | null): string | null {
  if (!bats) return null;
  if (bats === "S") {
    if (pitcherThrows === "L") return "R";
    if (pitcherThrows === "R") return "L";
    return null;
  }
  return bats;
}

/**
 * Platoon disadvantage = same side (LHB vs LHP, RHB vs RHP).
 * Switch hitters have no platoon disadvantage.
 */
function isPlatoonDisfavored(bats: string | null, pitcherThrows: string | null): boolean {
  if (!bats || !pitcherThrows || bats === "S") return false;
  return bats === pitcherThrows;
}

// ── Feature extraction ────────────────────────────────────────────────────────

async function ensureXBHEngineSource() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, notes)
     VALUES ($1, 'Extra Base Hit Research Engine (Phase 3B)', 'RESEARCH',
             'Ordinal evidence-based ranking engine for EXTRA_BASE_HIT market. ' ||
             'Writes to market_research_candidates. No odds, EV, or CLV produced.')
     ON CONFLICT (source_id) DO NOTHING`,
    [XBH_ENGINE_SOURCE],
  );
}

async function getSlateGames(slateDate: string): Promise<SlateGame[]> {
  const result = await pool.query<{
    game_pk: number; venue_id: number | null; away_team_id: number; home_team_id: number;
  }>(
    `SELECT game_pk, venue_id, away_team_id, home_team_id FROM games WHERE game_date = $1`,
    [slateDate],
  );
  return result.rows.map((r) => ({
    gamePk: Number(r.game_pk), venueId: r.venue_id,
    awayTeamId: r.away_team_id, homeTeamId: r.home_team_id,
  }));
}

async function getSlateLineupPlayers(gamePks: number[]): Promise<LineupPlayer[]> {
  if (gamePks.length === 0) return [];
  const result = await pool.query<{
    player_id: number; full_name: string; bats: string | null; batting_order: number;
    game_pk: number; team_id: number; lineup_state: string; opp_team_id: number; venue_id: number | null;
  }>(
    `WITH best_lineup AS (
       SELECT DISTINCT ON (game_pk, team_id)
         lineup_snapshot_id, game_pk, team_id, state AS lineup_state
       FROM lineup_snapshots
       WHERE game_pk = ANY($1)
         AND source_id = 'FANTASYPROS'
         AND state IN ('CONFIRMED', 'PROJECTED')
       ORDER BY game_pk, team_id,
         CASE
           WHEN state = 'CONFIRMED' THEN 1
           ELSE 2
         END,
         observed_at DESC
     )
     SELECT le.player_id, p.full_name, p.bats, le.batting_order,
            bl.game_pk::bigint, bl.team_id, bl.lineup_state,
            CASE WHEN bl.team_id = g.away_team_id THEN g.home_team_id ELSE g.away_team_id END AS opp_team_id,
            g.venue_id
     FROM best_lineup bl
     JOIN lineup_entries le ON le.lineup_snapshot_id = bl.lineup_snapshot_id
     JOIN players p ON p.player_id = le.player_id
     JOIN games g ON g.game_pk = bl.game_pk
     WHERE le.player_id IS NOT NULL
     ORDER BY bl.game_pk, le.batting_order`,
    [gamePks],
  );
  return result.rows.map((r) => ({
    playerId: r.player_id, playerName: r.full_name, bats: r.bats,
    battingOrder: r.batting_order, gamePk: Number(r.game_pk), teamId: r.team_id,
    lineupState: r.lineup_state, oppTeamId: r.opp_team_id, venueId: r.venue_id,
  }));
}

async function getStarter(gamePk: number, teamId: number): Promise<StarterInfo> {
  const result = await pool.query<{
    player_id: number | null; throws: string | null; starter_state: string;
  }>(
    `SELECT s.player_id, p.throws, s.starter_state
     FROM starters s LEFT JOIN players p ON p.player_id = s.player_id
     WHERE s.game_pk = $1 AND s.team_id = $2
     ORDER BY s.observed_at DESC LIMIT 1`,
    [gamePk, teamId],
  );
  return result.rows[0]
    ? { playerId: result.rows[0].player_id, throws: result.rows[0].throws, starterState: result.rows[0].starter_state }
    : { playerId: null, throws: null, starterState: "UNKNOWN" };
}

async function getHitterFeatures(playerId: number): Promise<FeatureMap> {
  const result = await pool.query<{
    metric_key: string; value: string | null; pitcher_side: string | null;
  }>(
    `SELECT DISTINCT ON (f.metric_key, f.pitcher_side)
       f.metric_key, f.value::text, f.pitcher_side
     FROM player_research_features f
     JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
     WHERE s.player_id = $1 AND s.research_window = 'SEASON'
     ORDER BY f.metric_key, f.pitcher_side, s.retrieved_at DESC`,
    [playerId],
  );
  const map: FeatureMap = new Map();
  for (const row of result.rows) {
    const k = row.pitcher_side ? `${row.metric_key}:${row.pitcher_side}` : row.metric_key;
    map.set(k, row.value !== null ? Number(row.value) : null);
  }
  return map;
}

async function getPitcherFeatures(playerId: number): Promise<FeatureMap> {
  const result = await pool.query<{
    metric_key: string; value: string | null; batter_side: string | null;
  }>(
    `SELECT DISTINCT ON (f.metric_key, f.batter_side)
       f.metric_key, f.value::text, f.batter_side
     FROM pitcher_research_features f
     JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
     WHERE s.player_id = $1 AND s.research_window = 'SEASON'
     ORDER BY f.metric_key, f.batter_side, s.retrieved_at DESC`,
    [playerId],
  );
  const map: FeatureMap = new Map();
  for (const row of result.rows) {
    const k = row.batter_side ? `${row.metric_key}:${row.batter_side}` : row.metric_key;
    map.set(k, row.value !== null ? Number(row.value) : null);
  }
  return map;
}

async function getParkFeatures(venueId: number): Promise<FeatureMap> {
  const result = await pool.query<{
    metric_key: string; value: string | null; batter_side: string | null;
  }>(
    `SELECT DISTINCT ON (f.metric_key, f.batter_side)
       f.metric_key, f.value::text, f.batter_side
     FROM park_research_features f
     JOIN park_research_snapshots s ON s.park_research_snapshot_id = f.park_research_snapshot_id
     WHERE s.venue_id = $1
     ORDER BY f.metric_key, f.batter_side, s.season DESC, s.retrieved_at DESC`,
    [venueId],
  );
  const map: FeatureMap = new Map();
  for (const row of result.rows) {
    const k = row.batter_side ? `${row.metric_key}:${row.batter_side}` : row.metric_key;
    map.set(k, row.value !== null ? Number(row.value) : null);
  }
  return map;
}

async function getBullpenSummary(teamId: number, slateDate: string): Promise<BullpenSummary> {
  const path = await getBullpenRolePath(teamId, slateDate);
  if (path.status !== "CURRENT") {
    return { ...path, availableHighLeverage: path.rolePath.length, avgXSLGAllowed: null, metricArmCount: 0 };
  }
  const armIds = path.armIds;

  let avgXSLGAllowed: N = null;
  let metricArmCount = 0;
  if (armIds.length > 0) {
    // Aggregate only the current projected 7th/8th/9th role path, not every
    // available arm in the room.
    const xslg = await pool.query<{ avg_xslg: string | null; metric_arm_count: string }>(
      `SELECT AVG(latest_val)::text AS avg_xslg, COUNT(latest_val)::text AS metric_arm_count
       FROM (
         SELECT DISTINCT ON (s.player_id)
           f.value::numeric AS latest_val
         FROM pitcher_research_features f
         JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
         WHERE s.player_id = ANY($1)
           AND f.metric_key = 'xslg_allowed'
           AND f.batter_side IS NULL
           AND s.research_window = 'SEASON'
         ORDER BY s.player_id, s.retrieved_at DESC
       ) latest`,
      [armIds],
    );
    metricArmCount = Number(xslg.rows[0]?.metric_arm_count ?? 0);
    avgXSLGAllowed = metricArmCount === armIds.length && xslg.rows[0]?.avg_xslg != null
      ? Number(xslg.rows[0].avg_xslg)
      : null;
  }
  return { ...path, availableHighLeverage: path.rolePath.length, avgXSLGAllowed, metricArmCount };
}

// ── Classification logic ──────────────────────────────────────────────────────

function classifyMechanism(
  hitter: FeatureMap,
  battingOrder: number | null,
  bats: string | null,
  pitcherThrows: string | null,
): { primary: XBHMechanism; secondary: XBHMechanism | null } {
  const side = resolveBatterSide(bats, pitcherThrows);

  const barrel    = n(hitter, "barrel_percent");
  const hardHit   = n(hitter, hk("hard_hit_percent", side)) ?? n(hitter, "hard_hit_percent");
  const avgEv     = n(hitter, "avg_ev");
  const ldPct     = n(hitter, "ld_percent");
  const sweetSpot = n(hitter, "sweet_spot_percent");
  const xbhPerPa  = n(hitter, hk("xbh_per_pa", side)) ?? n(hitter, "xbh_per_pa");
  const pullPct   = n(hitter, "pull_percent");

  // HR-route signals: power profile
  let hrSignals = 0;
  if (barrel  !== null && barrel  >= HR_BARREL)   hrSignals++;
  if (hardHit !== null && hardHit >= HR_HARD_HIT)  hrSignals++;
  if (avgEv   !== null && avgEv   >= HR_AVG_EV)    hrSignals++;

  // Gap-route signals: line-drive / doubles profile (singles explicitly excluded)
  let gapSignals = 0;
  if (ldPct     !== null && ldPct     >= GAP_LD_PCT)     gapSignals++;
  if (sweetSpot !== null && sweetSpot >= GAP_SWEET_SPOT)  gapSignals++;
  if (xbhPerPa  !== null && xbhPerPa  >= GAP_XBH_PER_PA) gapSignals++;

  // Triple-route: pull tendency + gap contact, without pure HR profile
  const isTripleRoute =
    pullPct !== null && ldPct !== null &&
    pullPct >= TRIPLE_PULL_PCT && ldPct >= TRIPLE_LD_PCT && hrSignals < 2;

  if (hrSignals >= 2 && gapSignals >= 2) return { primary: "MULTI_PATH", secondary: null };
  if (hrSignals >= 2) return { primary: "HOME_RUN_ROUTE", secondary: gapSignals >= 1 ? "DOUBLE_ROUTE" : null };
  if (isTripleRoute)  return { primary: "TRIPLE_ROUTE",   secondary: gapSignals >= 1 ? "DOUBLE_ROUTE" : null };
  return { primary: "DOUBLE_ROUTE", secondary: hrSignals >= 1 ? "HOME_RUN_ROUTE" : null };
}

function checkCounterEvidence(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  battingOrder: number | null,
  bats: string | null,
  pitcherThrows: string | null,
  hitterPA: N,
  pitcherBF: N,
): string[] {
  const counters: string[] = [];
  const side = resolveBatterSide(bats, pitcherThrows);

  // Soft contact profile → singles/weak outs, not XBH
  const avgEv = n(hitter, "avg_ev");
  if (avgEv !== null && avgEv < WEAK_EV_THRESHOLD) counters.push("WEAK_EXIT_VELOCITY");

  // Insufficient solid-contact rate → limited XBH ceiling
  const hardHit = n(hitter, hk("hard_hit_percent", side)) ?? n(hitter, "hard_hit_percent");
  if (hardHit !== null && hardHit < LOW_HARD_HIT_THRESHOLD) counters.push("LOW_HARD_HIT_RATE");

  // Heavy grounder tendency → grounders rarely produce XBH (except lucky gaps)
  const gbPct = n(hitter, "gb_percent");
  if (gbPct !== null && gbPct >= GROUND_BALL_HEAVY_THRESHOLD) counters.push("GROUND_BALL_HEAVY");

  // Platoon disadvantage (same-side match)
  if (isPlatoonDisfavored(bats, pitcherThrows)) counters.push("PLATOON_DISADVANTAGE");

  // Insufficient sample — noted but no score penalty (data quality, not opponent quality)
  if ((hitterPA !== null && hitterPA < MIN_HITTER_PA) || (pitcherBF !== null && pitcherBF < MIN_PITCHER_BF)) {
    counters.push("INSUFFICIENT_SAMPLE");
  }

  return counters;
}

function computeEvidenceScore(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  battingOrder: number | null,
  bats: string | null,
  pitcherThrows: string | null,
  counterEvidence: string[],
): number {
  const side = resolveBatterSide(bats, pitcherThrows);

  const xbhPerPa        = n(hitter, hk("xbh_per_pa", side)) ?? n(hitter, "xbh_per_pa");
  const hardHit         = n(hitter, hk("hard_hit_percent", side)) ?? n(hitter, "hard_hit_percent");
  const ldPct           = n(hitter, "ld_percent");
  const pitcherXBHPerBF = n(pitcher, pk("xbh_per_bf", side)) ?? n(pitcher, "xbh_per_bf");

  let score = 0;

  // Batting order (PA opportunity — moderate weight for XBH vs TB)
  if (battingOrder !== null) {
    if (battingOrder <= 2) score += 2;
    else if (battingOrder <= 4) score += 1.5;
    else if (battingOrder <= 6) score += 0.5;
    else score -= 1;
  }

  // Hitter XBH rate — primary XBH driver (singles excluded by market definition)
  if (xbhPerPa !== null) {
    if (xbhPerPa >= 0.150) score += 4;
    else if (xbhPerPa >= 0.120) score += 3;
    else if (xbhPerPa >= 0.100) score += 2;
    else if (xbhPerPa >= 0.080) score += 1;
  }

  // Hitter solid-contact quality
  if (hardHit !== null) {
    if (hardHit >= 45.0) score += 2;
    else if (hardHit >= 38.0) score += 1;
  }

  // Pitcher XBH rate allowed (matchup quality — higher = more favorable for hitter)
  if (pitcherXBHPerBF !== null) {
    if (pitcherXBHPerBF >= 0.100) score += 3;
    else if (pitcherXBHPerBF >= 0.080) score += 2;
    else if (pitcherXBHPerBF >= 0.060) score += 1;
    else if (pitcherXBHPerBF < 0.040) score -= 1;
  }

  // Line drive tendency bonus/penalty
  if (ldPct !== null) {
    if (ldPct >= 25.0) score += 1;
    else if (ldPct < 15.0) score -= 1;
  }

  // Counter-evidence penalties
  for (const c of counterEvidence) {
    if (c === "WEAK_EXIT_VELOCITY")   score -= 2;
    else if (c === "LOW_HARD_HIT_RATE")   score -= 1.5;
    else if (c === "GROUND_BALL_HEAVY")   score -= 1.5;
    else if (c === "PLATOON_DISADVANTAGE") score -= 1;
    // INSUFFICIENT_SAMPLE: noted but no score penalty (data quality flag)
  }

  return score;
}

function assignResearchState(
  hasStarterIdentity: boolean,
  _hasBattingOrder: boolean,
  evidenceScore: number,
): XBHResearchState {
  // BLOCKED: no starter identity — cannot assess the XBH matchup
  if (!hasStarterIdentity) return "BLOCKED";
  if (evidenceScore >= SCORE_STRONG)   return "STRONG";
  if (evidenceScore >= SCORE_POSITIVE) return "POSITIVE";
  if (evidenceScore >= 0)              return "NEUTRAL";
  return "NEGATIVE";
}

/**
 * Competition ranking: sorted by evidenceScore DESC, tiebreaker = player name ASC.
 * Ties share the same rank; the rank after a k-way tie skips k−1 positions.
 * Mutates researchRank in place on each element.
 */
function assignCompetitionRanks(candidates: XBHCandidate[]): void {
  const sorted = [...candidates].sort((a, b) =>
    b.evidenceScore !== a.evidenceScore
      ? b.evidenceScore - a.evidenceScore
      : a.playerName.localeCompare(b.playerName),
  );
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].evidenceScore === sorted[i - 1].evidenceScore) {
      sorted[i].researchRank = sorted[i - 1].researchRank;
    } else {
      sorted[i].researchRank = i + 1;
    }
  }
}

// ── Evidence payload builders ─────────────────────────────────────────────────

function buildOpportunityEvidence(c: XBHCandidate): object {
  return {
    battingOrder: c.battingOrder,
    lineupState: c.lineupState,
    paOpportunity: c.battingOrder === null ? "UNKNOWN"
      : c.battingOrder <= 2 ? "HIGH"
        : c.battingOrder <= 4 ? "ABOVE_AVERAGE"
          : c.battingOrder <= 6 ? "AVERAGE" : "LOW",
    seasonPA: n(c.hitterFeatures, "pa"),
  };
}

function buildStarterMatchupEvidence(c: XBHCandidate): object {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  return {
    starterIdentityKnown: c.starterPlayerId !== null,
    starterPlayerId: c.starterPlayerId,
    starterState: c.starterState,
    starterThrows: c.starterThrows,
    hitterBats: c.hitterBats,
    effectivePlatoonSide: side,
    platoonDisfavored: isPlatoonDisfavored(c.hitterBats, c.starterThrows),
    pitcherXBHPerBF: n(c.pitcherFeatures, pk("xbh_per_bf", side)) ?? n(c.pitcherFeatures, "xbh_per_bf"),
    pitcherHardHitPctAllowed: n(c.pitcherFeatures, pk("hard_hit_percent", side)) ?? n(c.pitcherFeatures, "hard_hit_percent"),
    hitterXBHPerPA: n(c.hitterFeatures, hk("xbh_per_pa", side)) ?? n(c.hitterFeatures, "xbh_per_pa"),
    hitterHardHitPct: n(c.hitterFeatures, hk("hard_hit_percent", side)) ?? n(c.hitterFeatures, "hard_hit_percent"),
  };
}

function buildBullpenPathEvidence(c: XBHCandidate): object {
  return {
    status: c.bullpen.status,
    reason: c.bullpen.reason,
    computedAt: c.bullpen.computedAt,
    rolePath: c.bullpen.rolePath,
    rolePathArmIds: c.bullpen.armIds,
    availableArms: c.bullpen.availableArms,
    rolePathArmCount: c.bullpen.availableHighLeverage,
    metricArmCount: c.bullpen.metricArmCount,
    metricCoverageComplete: c.bullpen.metricArmCount === c.bullpen.armIds.length,
    rolePathAvgXSLGAllowed: c.bullpen.avgXSLGAllowed,
    note: c.bullpen.reason,
  };
}

function buildParkEvidence(c: XBHCandidate): object {
  return {
    doublesFactor: n(c.parkFeatures, "doubles_factor"),
    xbhFactor: n(c.parkFeatures, "xbh_factor"),
    note: "Park factors are context only — not used to gate or boost rank directly",
  };
}

function buildRecentVsSeasonVsCareer(c: XBHCandidate): object {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  return {
    seasonXBHPerPA:    n(c.hitterFeatures, hk("xbh_per_pa", side)) ?? n(c.hitterFeatures, "xbh_per_pa"),
    seasonHardHitPct:  n(c.hitterFeatures, hk("hard_hit_percent", side)) ?? n(c.hitterFeatures, "hard_hit_percent"),
    seasonLDPct:       n(c.hitterFeatures, "ld_percent"),
    seasonGBPct:       n(c.hitterFeatures, "gb_percent"),
    seasonBarrelPct:   n(c.hitterFeatures, "barrel_percent"),
    seasonAvgEV:       n(c.hitterFeatures, "avg_ev"),
    seasonSweetSpotPct: n(c.hitterFeatures, "sweet_spot_percent"),
    seasonPullPct:     n(c.hitterFeatures, "pull_percent"),
    seasonPA:          n(c.hitterFeatures, "pa"),
    window: "SEASON",
  };
}

function buildCounterEvidenceJson(c: XBHCandidate): object {
  return {
    flags: c.counterEvidence,
    count: c.counterEvidence.length,
    details: {
      weakExitVelocity:    c.counterEvidence.includes("WEAK_EXIT_VELOCITY")
        ? `Avg EV < ${WEAK_EV_THRESHOLD} mph (soft contact profile)` : null,
      lowHardHitRate:      c.counterEvidence.includes("LOW_HARD_HIT_RATE")
        ? `Hard hit% < ${LOW_HARD_HIT_THRESHOLD}% (insufficient solid-contact rate)` : null,
      groundBallHeavy:     c.counterEvidence.includes("GROUND_BALL_HEAVY")
        ? `GB% ≥ ${GROUND_BALL_HEAVY_THRESHOLD}% (grounders rarely produce XBH)` : null,
      platoonDisadvantage: c.counterEvidence.includes("PLATOON_DISADVANTAGE")
        ? `Same-side platoon disadvantage (${c.hitterBats} vs ${c.starterThrows})` : null,
      insufficientSample:  c.counterEvidence.includes("INSUFFICIENT_SAMPLE")
        ? `Hitter PA < ${MIN_HITTER_PA} or pitcher BF < ${MIN_PITCHER_BF}` : null,
    },
  };
}

// ── DB write ──────────────────────────────────────────────────────────────────

async function writeCandidate(c: XBHCandidate, ingestRunId: string): Promise<string> {
  const result = await pool.query<{ candidate_id: string }>(
    `INSERT INTO market_research_candidates
       (slate_date, game_pk, player_id, market, research_rank, research_state,
        primary_mechanism, secondary_mechanism,
        opportunity_evidence, starter_matchup_evidence, bullpen_path_evidence,
        park_evidence, recent_vs_season_vs_career, counter_evidence,
        missing_stale_evidence, rank_semantics, ingest_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (slate_date, market, player_id, game_pk) DO UPDATE SET
       research_rank = EXCLUDED.research_rank,
       research_state = EXCLUDED.research_state,
       primary_mechanism = EXCLUDED.primary_mechanism,
       secondary_mechanism = EXCLUDED.secondary_mechanism,
       opportunity_evidence = EXCLUDED.opportunity_evidence,
       starter_matchup_evidence = EXCLUDED.starter_matchup_evidence,
       bullpen_path_evidence = EXCLUDED.bullpen_path_evidence,
       park_evidence = EXCLUDED.park_evidence,
       recent_vs_season_vs_career = EXCLUDED.recent_vs_season_vs_career,
       counter_evidence = EXCLUDED.counter_evidence,
       missing_stale_evidence = EXCLUDED.missing_stale_evidence,
       ingest_run_id = EXCLUDED.ingest_run_id,
       updated_at = now()
     RETURNING candidate_id`,
    [
      c.slateDate, c.gamePk, c.playerId, MARKET,
      c.researchRank, c.researchState,
      c.mechanism, c.secondaryMechanism,
      JSON.stringify(buildOpportunityEvidence(c)),
      JSON.stringify(buildStarterMatchupEvidence(c)),
      JSON.stringify(buildBullpenPathEvidence(c)),
      JSON.stringify(buildParkEvidence(c)),
      JSON.stringify(buildRecentVsSeasonVsCareer(c)),
      JSON.stringify(buildCounterEvidenceJson(c)),
      c.missingData.length > 0 ? c.missingData.join("; ") : null,
      "RANK_DONT_GATE: ordinal rank with transparent feature evidence; ties surfaced not collapsed; no threshold or gate implied",
      ingestRunId,
    ],
  );

  const candidateId = result.rows[0].candidate_id;
  await writeEvidenceBlocks(candidateId, c);
  return candidateId;
}

async function writeEvidenceBlocks(candidateId: string, c: XBHCandidate): Promise<void> {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  const pitcherXBHPerBF = n(c.pitcherFeatures, pk("xbh_per_bf", side)) ?? n(c.pitcherFeatures, "xbh_per_bf");
  const hitterXBHPerPA  = n(c.hitterFeatures, hk("xbh_per_pa", side)) ?? n(c.hitterFeatures, "xbh_per_pa");

  type Block = {
    blockType: string; metricKey: string; metricLabel: string;
    value: N; unit: string | null; sampleSize: N;
    direction: string; strength: string; narrative: string; rawEvidence: object;
  };

  const blocks: Block[] = [
    {
      blockType: "OPPORTUNITY", metricKey: "batting_order", metricLabel: "Batting order slot",
      value: c.battingOrder, unit: "slot", sampleSize: null,
      direction: c.battingOrder === null ? "UNKNOWN" : c.battingOrder <= 4 ? "FAVORABLE" : c.battingOrder <= 6 ? "NEUTRAL" : "UNFAVORABLE",
      strength: c.battingOrder === null ? "UNKNOWN" : c.battingOrder <= 2 ? "STRONG" : c.battingOrder <= 4 ? "MODERATE" : "WEAK",
      narrative: `Batting ${c.battingOrder ?? "unknown"} in lineup (${c.lineupState} source). Lower order = more PA opportunity for XBH.`,
      rawEvidence: buildOpportunityEvidence(c),
    },
    {
      blockType: "STARTER_MATCHUP", metricKey: "pitcher_xbh_per_bf", metricLabel: "Pitcher XBH per BF",
      value: pitcherXBHPerBF, unit: "rate", sampleSize: null,
      direction: pitcherXBHPerBF === null ? "UNKNOWN" : pitcherXBHPerBF >= 0.080 ? "FAVORABLE" : pitcherXBHPerBF >= 0.050 ? "NEUTRAL" : "UNFAVORABLE",
      strength: pitcherXBHPerBF === null ? "UNKNOWN" : pitcherXBHPerBF >= 0.100 ? "STRONG" : pitcherXBHPerBF >= 0.080 ? "MODERATE" : "WEAK",
      narrative: `Pitcher XBH rate allowed season avg${side ? ` vs ${side}HB` : ""}. Higher = more extra-base hit opportunity.`,
      rawEvidence: buildStarterMatchupEvidence(c),
    },
    {
      blockType: "RECENT_VS_SEASON_VS_CAREER", metricKey: "season_xbh_per_pa", metricLabel: "Season XBH per PA",
      value: hitterXBHPerPA, unit: "rate", sampleSize: n(c.hitterFeatures, "pa"),
      direction: hitterXBHPerPA === null ? "UNKNOWN" : hitterXBHPerPA >= 0.100 ? "FAVORABLE" : hitterXBHPerPA >= 0.070 ? "NEUTRAL" : "UNFAVORABLE",
      strength: hitterXBHPerPA === null ? "UNKNOWN" : hitterXBHPerPA >= 0.130 ? "STRONG" : hitterXBHPerPA >= 0.100 ? "MODERATE" : "WEAK",
      narrative: "Hitter XBH rate (season). Excludes singles — pure measure of extra-base hit frequency.",
      rawEvidence: buildRecentVsSeasonVsCareer(c),
    },
    {
      blockType: "BULLPEN_PATH", metricKey: "bullpen_path_summary", metricLabel: "Bullpen path summary",
      value: c.bullpen.avgXSLGAllowed, unit: "rate", sampleSize: c.bullpen.availableHighLeverage,
      direction: c.bullpen.avgXSLGAllowed === null ? "UNKNOWN" : "CONTEXT_ONLY",
      strength: c.bullpen.availableHighLeverage > 0 ? "MODERATE" : "WEAK",
      narrative: c.bullpen.status === "CURRENT"
        ? `Projected 7th/8th/9th role path (${c.bullpen.rolePath.map((arm) => arm.role).join(" → ")}). Avg xSLG allowed by those arms (context only for XBH).`
        : `Bullpen path unavailable: ${c.bullpen.reason}`,
      rawEvidence: buildBullpenPathEvidence(c),
    },
    {
      blockType: "PARK", metricKey: "park_doubles_factor", metricLabel: "Park doubles factor",
      value: n(c.parkFeatures, "doubles_factor"), unit: "factor", sampleSize: null,
      direction: (() => { const v = n(c.parkFeatures, "doubles_factor"); return v === null ? "UNKNOWN" : v >= 110 ? "FAVORABLE" : v >= 90 ? "NEUTRAL" : "UNFAVORABLE"; })(),
      strength: "CONTEXT_ONLY",
      narrative: "Park doubles factor (Baseball Savant Statcast). Context only — not used to gate or boost rank.",
      rawEvidence: buildParkEvidence(c),
    },
  ];

  if (c.counterEvidence.length > 0) {
    blocks.push({
      blockType: "COUNTER", metricKey: "counter_summary", metricLabel: "Counter-evidence flags",
      value: c.counterEvidence.length, unit: "count", sampleSize: null,
      direction: "UNFAVORABLE",
      strength: c.counterEvidence.length >= 3 ? "STRONG" : c.counterEvidence.length === 2 ? "MODERATE" : "WEAK",
      narrative: `${c.counterEvidence.length} flag(s): ${c.counterEvidence.join(", ")}`,
      rawEvidence: buildCounterEvidenceJson(c),
    });
  }

  if (c.missingData.length > 0) {
    blocks.push({
      blockType: "MISSING_STALE", metricKey: "missing_data_summary", metricLabel: "Missing or stale data",
      value: c.missingData.length, unit: "count", sampleSize: null,
      direction: "NEUTRAL", strength: "INFORMATIONAL",
      narrative: c.missingData.join("; "),
      rawEvidence: { missingItems: c.missingData },
    });
  }

  for (const b of blocks) {
    await pool.query(
      `INSERT INTO market_research_evidence_blocks
         (candidate_id, block_type, source_id, metric_key, metric_label,
          value, unit, sample_size, direction, strength, narrative, raw_evidence, retrieved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (candidate_id, block_type, metric_key) DO UPDATE SET
         value = EXCLUDED.value, direction = EXCLUDED.direction, strength = EXCLUDED.strength,
         narrative = EXCLUDED.narrative, raw_evidence = EXCLUDED.raw_evidence, retrieved_at = EXCLUDED.retrieved_at`,
      [candidateId, b.blockType, XBH_ENGINE_SOURCE, b.metricKey, b.metricLabel,
       b.value, b.unit, b.sampleSize, b.direction, b.strength, b.narrative, JSON.stringify(b.rawEvidence)],
    );
  }
}

// ── Main engine entry point ───────────────────────────────────────────────────

/**
 * Reconcile the XBH candidate set for a slate after a successful run.
 * Deletes any market_research_candidates rows (and their cascaded evidence blocks
 * and provenance) that belonged to a prior XBH run for this slate but are NOT in
 * the current candidate set.
 */
async function reconcileSlateCandidates(slateDate: string, candidates: XBHCandidate[]): Promise<number> {
  if (candidates.length === 0) {
    const result = await pool.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM market_research_candidates
         WHERE slate_date = $1 AND market = 'EXTRA_BASE_HIT'
         RETURNING 1
       ) SELECT count(*)::text FROM deleted`,
      [slateDate],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  const playerIds = candidates.map((c) => c.playerId);
  const gamePks   = candidates.map((c) => c.gamePk);

  const result = await pool.query<{ count: string }>(
    `WITH eligible AS (
       SELECT unnest($2::integer[]) AS player_id,
              unnest($3::bigint[])  AS game_pk
     ),
     deleted AS (
       DELETE FROM market_research_candidates mrc
       WHERE mrc.slate_date = $1 AND mrc.market = 'EXTRA_BASE_HIT'
         AND NOT EXISTS (
           SELECT 1 FROM eligible e
           WHERE e.player_id = mrc.player_id AND e.game_pk = mrc.game_pk
         )
       RETURNING 1
     )
     SELECT count(*)::text FROM deleted`,
    [slateDate, playerIds, gamePks],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function runXBHEngine(slateDate: string): Promise<XBHEngineResult> {
  const started = Date.now();
  const notes: string[] = [];
  // Hoisted so the catch block can mark the run FAILED if it was created
  let ingestRunId: string | null = null;

  try {
    await ensureXBHEngineSource();

    const games = await getSlateGames(slateDate);
    if (games.length === 0) {
      // Reconcile even with zero games: stale candidates from cancelled games must be cleared.
      const staleRemoved = await reconcileSlateCandidates(slateDate, []);
      const noGamesNote = staleRemoved > 0
        ? `No games on this date; ${staleRemoved} stale XBH candidate(s) from a prior run have been cleared.`
        : "No games found for this date; XBH board is empty.";
      return {
        market: "XBH", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
        blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
        processingMs: Date.now() - started, notes: [noGamesNote], error: null,
      };
    }

    const gamePks = games.map((g) => g.gamePk);
    const lineupPlayers = await getSlateLineupPlayers(gamePks);

    if (lineupPlayers.length === 0) {
      notes.push("No lineup entries found. XBH candidates require lineup data.");
    }

    // Create ingest run — hoisted ID is visible to catch block for FAILED marking
    const runResult = await pool.query<{ ingest_run_id: string }>(
      `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
       VALUES ($1, 'xbh_engine_research', 'RUNNING', $2) RETURNING ingest_run_id`,
      [XBH_ENGINE_SOURCE, slateDate],
    );
    ingestRunId = runResult.rows[0].ingest_run_id;

    // Per-game caches to avoid redundant DB queries
    const starterCache = new Map<string, StarterInfo>();
    const hitterCache  = new Map<number, FeatureMap>();
    const pitcherCache = new Map<number, FeatureMap>();
    const parkCache    = new Map<number, FeatureMap>();
    const bullpenCache = new Map<string, BullpenSummary>();

    const candidates: XBHCandidate[] = [];

    for (const player of lineupPlayers) {
      const starterKey = `${player.gamePk}:${player.oppTeamId}`;
      if (!starterCache.has(starterKey)) {
        starterCache.set(starterKey, await getStarter(player.gamePk, player.oppTeamId));
      }
      const starter = starterCache.get(starterKey)!;

      if (!hitterCache.has(player.playerId)) {
        hitterCache.set(player.playerId, await getHitterFeatures(player.playerId));
      }
      const hitterFeatures = hitterCache.get(player.playerId)!;

      const pitcherFeatures: FeatureMap = new Map();
      if (starter.playerId !== null) {
        if (!pitcherCache.has(starter.playerId)) {
          pitcherCache.set(starter.playerId, await getPitcherFeatures(starter.playerId));
        }
        pitcherCache.get(starter.playerId)!.forEach((v, k) => pitcherFeatures.set(k, v));
      }

      if (player.venueId !== null && !parkCache.has(player.venueId)) {
        parkCache.set(player.venueId, await getParkFeatures(player.venueId));
      }
      const parkFeatures = player.venueId !== null
        ? (parkCache.get(player.venueId) ?? new Map<string, N>())
        : new Map<string, N>();

      const bullpenKey = `${player.oppTeamId}:${slateDate}`;
      if (!bullpenCache.has(bullpenKey)) {
        bullpenCache.set(bullpenKey, await getBullpenSummary(player.oppTeamId, slateDate));
      }
      const bullpen = bullpenCache.get(bullpenKey)!;

      const missingData: string[] = [];
      if (hitterFeatures.size === 0) missingData.push("No season hitter research data");
      if (starter.playerId === null)  missingData.push("Opposing starter identity unknown");
      else if (pitcherFeatures.size === 0) missingData.push("No season pitcher research data");
      if (player.venueId === null || parkFeatures.size === 0) missingData.push("Park factors unavailable");
      if (bullpen.status !== "CURRENT") {
        missingData.push(`Bullpen path ${bullpen.status.toLowerCase()}: ${bullpen.reason}`);
      } else if (bullpen.metricArmCount !== bullpen.armIds.length) {
        missingData.push(`Bullpen role-path xSLG research incomplete (${bullpen.metricArmCount}/${bullpen.armIds.length} arms)`);
      }

      const { primary: mechanism, secondary: secondaryMechanism } = classifyMechanism(
        hitterFeatures, player.battingOrder, player.bats, starter.throws,
      );
      const hitterPA  = n(hitterFeatures, "pa");
      const pitcherBF = n(pitcherFeatures, "bf") ?? n(pitcherFeatures, "pa");
      const counterEvidence = checkCounterEvidence(
        hitterFeatures, pitcherFeatures,
        player.battingOrder, player.bats, starter.throws,
        hitterPA, pitcherBF,
      );
      const baseEvidenceScore = computeEvidenceScore(
        hitterFeatures, pitcherFeatures,
        player.battingOrder, player.bats, starter.throws, counterEvidence,
      );
      const bvp = starter.playerId === null ? null : await getBatterPitcherEvidence(player.playerId, starter.playerId, slateDate, "XBH");
      const evidenceScore = baseEvidenceScore + (bvp?.rankAdjustment ?? 0);
      // BvP is a bounded competition tiebreaker, not a research-state promotion/fade.
      const researchState = assignResearchState(
        starter.playerId !== null, player.battingOrder !== null, baseEvidenceScore,
      );

      candidates.push({
        playerId: player.playerId, playerName: player.playerName, gamePk: player.gamePk,
        slateDate, battingOrder: player.battingOrder, lineupState: player.lineupState,
        hitterBats: player.bats, starterPlayerId: starter.playerId,
        starterThrows: starter.throws, starterState: starter.starterState,
        hitterFeatures, pitcherFeatures, parkFeatures, bullpen,
        mechanism, secondaryMechanism, researchState, counterEvidence,
        evidenceScore, researchRank: null, missingData,
      });
    }

    assignCompetitionRanks(candidates);

    // Write current candidates (upsert)
    let candidatesWritten = 0;
    for (const c of candidates) {
      await writeCandidate(c, ingestRunId);
      candidatesWritten++;
    }

    // Reconcile: remove XBH candidates from prior runs no longer in this lineup.
    const staleRemoved = await reconcileSlateCandidates(slateDate, candidates);
    if (staleRemoved > 0) {
      notes.push(`Reconciliation removed ${staleRemoved} stale XBH candidate(s) from this slate.`);
    }

    const counts = {
      strong:   candidates.filter((c) => c.researchState === "STRONG").length,
      positive: candidates.filter((c) => c.researchState === "POSITIVE").length,
      neutral:  candidates.filter((c) => c.researchState === "NEUTRAL").length,
      negative: candidates.filter((c) => c.researchState === "NEGATIVE").length,
      blocked:  candidates.filter((c) => c.researchState === "BLOCKED").length,
    };

    await pool.query(
      `UPDATE ingest_runs SET finished_at = now(), status = 'SUCCESS',
         row_count = $2, normalized_row_count = $3, metadata = $4
       WHERE ingest_run_id = $1`,
      [ingestRunId, candidates.length, candidatesWritten,
       JSON.stringify({ market: "XBH", slateDate, games: games.length, staleRemoved, ...counts })],
    );

    return {
      market: "XBH", slateDate, gamesProcessed: games.length,
      candidatesProcessed: candidates.length, candidatesWritten,
      blockedCandidates: counts.blocked, strongCandidates: counts.strong,
      positiveCandidates: counts.positive, neutralCandidates: counts.neutral,
      negativeCandidates: counts.negative,
      processingMs: Date.now() - started, notes, error: null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Best-effort: mark the ingest run as FAILED so it is not permanently stuck as RUNNING
    if (ingestRunId) {
      pool.query(
        `UPDATE ingest_runs SET finished_at = now(), status = 'FAILED', metadata = $2
         WHERE ingest_run_id = $1`,
        [ingestRunId, JSON.stringify({ error, slateDate })],
      ).catch(() => { /* suppress secondary failure */ });
    }
    return {
      market: "XBH", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
      blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
      processingMs: Date.now() - started, notes, error,
    };
  }
}
