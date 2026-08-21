/**
 * Phase 3C – Batter Walk Research Engine
 *
 * Identifies candidate hitters via PATIENCE_VS_COMMAND, COUNT_CREATION, and
 * BULLPEN_WALK_PATH mechanisms. Walk research is driven by plate discipline and
 * pitcher command — NOT by power metrics. Power signals (SLG, ISO, barrel%)
 * are explicitly absent from all mechanism paths and scoring.
 *
 * RANK, DON'T GATE contract:
 *   research_rank is an ordinal integer only. No state value removes a candidate
 *   from the board. Ties share the same rank value and are never collapsed.
 *   No sportsbook price, odds, EV, CLV, or implied probability is produced.
 *
 * Classification rule (documented for Phase 5 audit):
 *   PATIENCE_VS_COMMAND — patience_signals ≥ 2
 *     (hitter has elite walk rate + low chase rate — command mismatch with pitcher)
 *   COUNT_CREATION      — count_signals ≥ 2 AND patience_signals < 2
 *     (hitter works deep counts via pitch-taking, may not have elite raw BB%)
 *   BULLPEN_WALK_PATH   — bullpen_avg_bb ≥ 10.0% AND patience_signals < 2 AND count_signals < 2
 *     (walk opportunity is primarily bullpen-path driven; starter may be sharp)
 *   Default             — PATIENCE_VS_COMMAND (base case when other thresholds not met)
 *
 *   Patience signals : hitter BB% ≥ 12 | hitter O-Swing% ≤ 28
 *   Count signals    : hitter pitches/PA ≥ 4.0 | hitter O-Swing% ≤ 32
 *
 * Counter-evidence (documented for Phase 5 audit):
 *   AGGRESSIVE_HITTER       — hitter O-Swing% ≥ 36% (chases pitches, unlikely to draw walks)
 *   PITCHER_LOW_WALK_RATE   — pitcher BB% ≤ 4% (excellent command, rarely walks batters)
 *   FIRST_PITCH_STRIKE_HEAVY — hitter F-Strike% ≥ 68% (pitchers consistently get ahead
 *                              early vs this hitter — harder to work counts toward a walk)
 *   INSUFFICIENT_SAMPLE     — hitter PA < 50 or pitcher BF < 60 (noted; no score penalty)
 *
 * Competition ranking:
 *   Candidates sorted by evidenceScore DESC. Tiebreaker = player name ASC.
 *   Ties share the same rank; next rank skips k−1 positions (1,1,3 not 1,1,2).
 */

import { pool } from "@workspace/db";

// ── Source / market constants ─────────────────────────────────────────────────

const WALK_ENGINE_SOURCE = "WALK_ENGINE";
const MARKET = "BATTER_WALK";

// ── Mechanism thresholds ──────────────────────────────────────────────────────

// Patience signals
const PATIENCE_BB_PCT     = 12.0; // hitter BB% ≥ this → elite walk tendency
const PATIENCE_CHASE_PCT  = 28.0; // hitter O-Swing% ≤ this → disciplined (low chase)

// Count creation signals
const COUNT_PITCHES_PER_PA = 4.0; // pitches/PA ≥ this → works deep counts
const COUNT_CHASE_PCT      = 32.0; // O-Swing% ≤ this → doesn't chase even if not elite BB%

// Bullpen walk path
const BULLPEN_WALK_BB_THRESHOLD = 10.0; // avg bullpen BB% ≥ this → walk-prone bullpen path

// ── Counter-evidence thresholds ───────────────────────────────────────────────

const AGGRESSIVE_CHASE_THRESHOLD   = 36.0; // hitter O-Swing% ≥ this → aggressive (chaser)
const PITCHER_LOW_BB_THRESHOLD     =  4.0; // pitcher BB% ≤ this → excellent command, won't walk
const HIGH_F_STRIKE_THRESHOLD      = 68.0; // hitter F-Strike% ≥ this → routinely put in count hole
const MIN_HITTER_PA  = 50;
const MIN_PITCHER_BF = 60;

// ── Evidence score thresholds (not exposed externally) ────────────────────────

const SCORE_STRONG   = 6;
const SCORE_POSITIVE = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

type N = number | null;
type FeatureMap = Map<string, N>;

export type WALKMechanism = "PATIENCE_VS_COMMAND" | "COUNT_CREATION" | "BULLPEN_WALK_PATH";
export type WALKResearchState = "STRONG" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "BLOCKED";

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

interface BullpenWalkSummary {
  availableArms: number;
  availableHighLeverage: number;
  avgBBPct: N; // average BB% across latest snapshot per available arm
}

interface WALKCandidate {
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
  bullpen: BullpenWalkSummary;
  mechanism: WALKMechanism;
  secondaryMechanism: WALKMechanism | null;
  researchState: WALKResearchState;
  counterEvidence: string[];
  evidenceScore: number;
  researchRank: number | null;
  missingData: string[];
}

export interface WALKEngineResult {
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
 * Resolve the effective batter side for platoon/split lookup.
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

// ── Feature extraction ────────────────────────────────────────────────────────

async function ensureWALKEngineSource() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, notes)
     VALUES ($1, 'Batter Walk Research Engine (Phase 3C)', 'RESEARCH',
             'Ordinal evidence-based ranking engine for BATTER_WALK market. ' ||
             'Driven by plate discipline and pitcher command — no power metrics. ' ||
             'Writes to market_research_candidates. No odds, EV, or CLV produced.')
     ON CONFLICT (source_id) DO NOTHING`,
    [WALK_ENGINE_SOURCE],
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
       FROM lineup_snapshots WHERE game_pk = ANY($1)
       ORDER BY game_pk, team_id,
         CASE state WHEN 'POSTED' THEN 1 WHEN 'UPDATED' THEN 2 WHEN 'PROJECTED' THEN 3 ELSE 4 END,
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

async function getBullpenWalkSummary(teamId: number, slateDate: string): Promise<BullpenWalkSummary> {
  const arms = await pool.query<{ player_id: number; final_state: string; role: string | null }>(
    `SELECT bao.player_id, bao.final_state, rp.role
     FROM bullpen_availability_observations bao
     LEFT JOIN reliever_profiles rp ON rp.player_id = bao.player_id
     WHERE bao.team_id = $1 AND bao.slate_date = $2
       AND bao.final_state IN ('AVAILABLE', 'LIKELY_AVAILABLE')`,
    [teamId, slateDate],
  );
  const highLeverageRoles = new Set(["CLOSER", "PRIMARY_SETUP", "SETUP"]);
  const armIds = arms.rows.map((r) => r.player_id);
  const highLeverage = arms.rows.filter((r) => r.role && highLeverageRoles.has(r.role)).length;

  let avgBBPct: N = null;
  if (armIds.length > 0) {
    // Select the LATEST overall (batter_side IS NULL) bb_percent snapshot per reliever,
    // then average across reliever arms. This prevents blending stale historical values.
    const bbResult = await pool.query<{ avg_bb_pct: string | null }>(
      `SELECT AVG(latest_val)::text AS avg_bb_pct
       FROM (
         SELECT DISTINCT ON (s.player_id)
           f.value::numeric AS latest_val
         FROM pitcher_research_features f
         JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
         WHERE s.player_id = ANY($1)
           AND f.metric_key = 'bb_percent'
           AND f.batter_side IS NULL
           AND s.research_window = 'SEASON'
         ORDER BY s.player_id, s.retrieved_at DESC
       ) latest`,
      [armIds],
    );
    avgBBPct = bbResult.rows[0]?.avg_bb_pct != null ? Number(bbResult.rows[0].avg_bb_pct) : null;
  }
  return { availableArms: armIds.length, availableHighLeverage: highLeverage, avgBBPct };
}

// ── Classification logic ──────────────────────────────────────────────────────

function classifyMechanism(
  hitter: FeatureMap,
  bullpen: BullpenWalkSummary,
  bats: string | null,
  pitcherThrows: string | null,
): { primary: WALKMechanism; secondary: WALKMechanism | null } {
  const side = resolveBatterSide(bats, pitcherThrows);

  const bbPct       = n(hitter, hk("bb_percent", side)) ?? n(hitter, "bb_percent");
  const oSwingPct   = n(hitter, "o_swing_percent");
  const pitchesPerPA = n(hitter, "pitches_per_pa");

  // Patience signals: high walk rate + disciplined (low chase)
  let patienceSignals = 0;
  if (bbPct !== null && bbPct >= PATIENCE_BB_PCT)      patienceSignals++;
  if (oSwingPct !== null && oSwingPct <= PATIENCE_CHASE_PCT) patienceSignals++;

  // Count creation signals: works deep counts (pitches per PA) + doesn't chase
  let countSignals = 0;
  if (pitchesPerPA !== null && pitchesPerPA >= COUNT_PITCHES_PER_PA) countSignals++;
  if (oSwingPct !== null && oSwingPct <= COUNT_CHASE_PCT)            countSignals++;

  // Bullpen walk path: command-challenged bullpen (high walk rate)
  const bullpenWalkProne = bullpen.avgBBPct !== null && bullpen.avgBBPct >= BULLPEN_WALK_BB_THRESHOLD;

  // Primary mechanism: hierarchical priority
  if (patienceSignals >= 2) {
    // Elite patience profile vs pitcher command
    const secondary: WALKMechanism | null =
      countSignals >= 1 ? "COUNT_CREATION"
        : bullpenWalkProne ? "BULLPEN_WALK_PATH"
          : null;
    return { primary: "PATIENCE_VS_COMMAND", secondary };
  }

  if (countSignals >= 2) {
    // Works deep counts even without elite raw BB%
    const secondary: WALKMechanism | null =
      patienceSignals >= 1 ? "PATIENCE_VS_COMMAND"
        : bullpenWalkProne ? "BULLPEN_WALK_PATH"
          : null;
    return { primary: "COUNT_CREATION", secondary };
  }

  if (bullpenWalkProne) {
    // Walk opportunity is primarily through a walk-prone bullpen —
    // neither patience (< 2 signals) nor count creation (< 2 signals) threshold met.
    // Secondary is whichever partial signal exists, if any.
    const secondary: WALKMechanism | null =
      patienceSignals >= 1 ? "PATIENCE_VS_COMMAND"
        : countSignals >= 1 ? "COUNT_CREATION"
          : null;
    return { primary: "BULLPEN_WALK_PATH", secondary };
  }

  // Default: PATIENCE_VS_COMMAND (walk research base case)
  return {
    primary: "PATIENCE_VS_COMMAND",
    secondary: countSignals >= 1 ? "COUNT_CREATION" : null,
  };
}

function checkCounterEvidence(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  bats: string | null,
  pitcherThrows: string | null,
  hitterPA: N,
  pitcherBF: N,
): string[] {
  const counters: string[] = [];
  const side = resolveBatterSide(bats, pitcherThrows);

  // Aggressive hitter: chases pitches → unlikely to draw walks
  const oSwingPct = n(hitter, "o_swing_percent");
  if (oSwingPct !== null && oSwingPct >= AGGRESSIVE_CHASE_THRESHOLD) {
    counters.push("AGGRESSIVE_HITTER");
  }

  // Pitcher rarely walks batters → command is too good to generate walks
  const pitcherBBPct = n(pitcher, pk("bb_percent", side)) ?? n(pitcher, "bb_percent");
  if (pitcherBBPct !== null && pitcherBBPct <= PITCHER_LOW_BB_THRESHOLD) {
    counters.push("PITCHER_LOW_WALK_RATE");
  }

  // Pitchers consistently get first strike vs this hitter → count disadvantage
  const hitterFStrikePct = n(hitter, hk("f_strike_percent", side)) ?? n(hitter, "f_strike_percent");
  if (hitterFStrikePct !== null && hitterFStrikePct >= HIGH_F_STRIKE_THRESHOLD) {
    counters.push("FIRST_PITCH_STRIKE_HEAVY");
  }

  // Insufficient sample — noted, no score penalty
  if ((hitterPA !== null && hitterPA < MIN_HITTER_PA) || (pitcherBF !== null && pitcherBF < MIN_PITCHER_BF)) {
    counters.push("INSUFFICIENT_SAMPLE");
  }

  return counters;
}

function computeEvidenceScore(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  bullpen: BullpenWalkSummary,
  battingOrder: number | null,
  bats: string | null,
  pitcherThrows: string | null,
  counterEvidence: string[],
): number {
  const side = resolveBatterSide(bats, pitcherThrows);

  const hitterBBPct   = n(hitter, hk("bb_percent", side)) ?? n(hitter, "bb_percent");
  const oSwingPct     = n(hitter, "o_swing_percent");
  const pitchesPerPA  = n(hitter, "pitches_per_pa");
  const pitcherBBPct  = n(pitcher, pk("bb_percent", side)) ?? n(pitcher, "bb_percent");

  let score = 0;

  // Batting order (PA opportunity — moderate weight for Walk vs TB)
  if (battingOrder !== null) {
    if (battingOrder <= 2) score += 2;
    else if (battingOrder <= 4) score += 1.5;
    else if (battingOrder <= 6) score += 0.5;
    else score -= 1;
  }

  // Hitter BB% — primary walk driver (no power metrics used here)
  if (hitterBBPct !== null) {
    if (hitterBBPct >= 16.0) score += 4;
    else if (hitterBBPct >= 12.0) score += 3;
    else if (hitterBBPct >= 9.0)  score += 2;
    else if (hitterBBPct >= 7.0)  score += 1;
  }

  // Hitter O-Swing% (discipline — lower is better for walk potential)
  if (oSwingPct !== null) {
    if (oSwingPct <= 22.0) score += 2;
    else if (oSwingPct <= 28.0) score += 1;
  }

  // Pitcher BB% (matchup — higher pitcher walk rate = more favorable)
  if (pitcherBBPct !== null) {
    if (pitcherBBPct >= 12.0) score += 3;
    else if (pitcherBBPct >= 9.0)  score += 2;
    else if (pitcherBBPct >= 7.0)  score += 1;
    else if (pitcherBBPct <= 4.0)  score -= 1;
  }

  // Hitter pitches/PA (count-working tendency)
  if (pitchesPerPA !== null) {
    if (pitchesPerPA >= 4.5) score += 2;
    else if (pitchesPerPA >= 4.0) score += 1;
  }

  // Bullpen walk path bonus (walk-prone available arms)
  if (bullpen.avgBBPct !== null) {
    if (bullpen.avgBBPct >= 12.0) score += 2;
    else if (bullpen.avgBBPct >= 10.0) score += 1;
  }

  // Counter-evidence penalties
  for (const c of counterEvidence) {
    if (c === "AGGRESSIVE_HITTER")       score -= 2;
    else if (c === "PITCHER_LOW_WALK_RATE")    score -= 2;
    else if (c === "FIRST_PITCH_STRIKE_HEAVY") score -= 1;
    // INSUFFICIENT_SAMPLE: noted but no score penalty (data quality flag)
  }

  return score;
}

function assignResearchState(
  hasStarterIdentity: boolean,
  _hasBattingOrder: boolean,
  evidenceScore: number,
): WALKResearchState {
  // BLOCKED: no starter identity — cannot assess the walk matchup
  if (!hasStarterIdentity) return "BLOCKED";
  if (evidenceScore >= SCORE_STRONG)   return "STRONG";
  if (evidenceScore >= SCORE_POSITIVE) return "POSITIVE";
  if (evidenceScore >= 0)              return "NEUTRAL";
  return "NEGATIVE";
}

/**
 * Competition ranking: sorted by evidenceScore DESC, tiebreaker = player name ASC.
 * Ties share the same rank; next rank after a k-way tie skips k−1 positions.
 * Mutates researchRank in place.
 */
function assignCompetitionRanks(candidates: WALKCandidate[]): void {
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

function buildOpportunityEvidence(c: WALKCandidate): object {
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

function buildStarterMatchupEvidence(c: WALKCandidate): object {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  return {
    starterIdentityKnown: c.starterPlayerId !== null,
    starterState: c.starterState,
    starterThrows: c.starterThrows,
    hitterBats: c.hitterBats,
    effectivePlatoonSide: side,
    pitcherBBPct:       n(c.pitcherFeatures, pk("bb_percent", side)) ?? n(c.pitcherFeatures, "bb_percent"),
    pitcherZonePct:     n(c.pitcherFeatures, pk("zone_percent", side)) ?? n(c.pitcherFeatures, "zone_percent"),
    pitcherKMinusBBPct: n(c.pitcherFeatures, pk("k_minus_bb_percent", side)) ?? n(c.pitcherFeatures, "k_minus_bb_percent"),
    hitterBBPct:        n(c.hitterFeatures, hk("bb_percent", side)) ?? n(c.hitterFeatures, "bb_percent"),
    hitterOSwingPct:    n(c.hitterFeatures, "o_swing_percent"),
    hitterFStrikePct:   n(c.hitterFeatures, hk("f_strike_percent", side)) ?? n(c.hitterFeatures, "f_strike_percent"),
  };
}

function buildBullpenWalkEvidence(c: WALKCandidate): object {
  return {
    availableArms: c.bullpen.availableArms,
    availableHighLeverageArms: c.bullpen.availableHighLeverage,
    avgBBPct: c.bullpen.avgBBPct,
    walkProneFlag: c.bullpen.avgBBPct !== null && c.bullpen.avgBBPct >= BULLPEN_WALK_BB_THRESHOLD,
    note: c.bullpen.availableArms === 0 ? "No bullpen availability data for this date" : null,
  };
}

function buildParkEvidence(c: WALKCandidate): object {
  // Park factors are context-only for Walk (walk rate is not significantly park-influenced)
  return {
    note: "Park factors are context only for Walk — walk rate is primarily pitcher/hitter discipline driven",
  };
}

function buildRecentVsSeasonVsCareer(c: WALKCandidate): object {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  return {
    seasonBBPct:        n(c.hitterFeatures, hk("bb_percent", side)) ?? n(c.hitterFeatures, "bb_percent"),
    seasonOSwingPct:    n(c.hitterFeatures, "o_swing_percent"),
    seasonZSwingPct:    n(c.hitterFeatures, "z_swing_percent"),
    seasonZonePct:      n(c.hitterFeatures, "zone_percent"),
    seasonFStrikePct:   n(c.hitterFeatures, hk("f_strike_percent", side)) ?? n(c.hitterFeatures, "f_strike_percent"),
    seasonPitchesPerPA: n(c.hitterFeatures, "pitches_per_pa"),
    seasonKPct:         n(c.hitterFeatures, hk("k_percent", side)) ?? n(c.hitterFeatures, "k_percent"),
    seasonPA:           n(c.hitterFeatures, "pa"),
    window: "SEASON",
    powerMetricsNote: "Power metrics (SLG, ISO, barrel%) are intentionally absent — walk research is discipline-only",
  };
}

function buildCounterEvidenceJson(c: WALKCandidate): object {
  return {
    flags: c.counterEvidence,
    count: c.counterEvidence.length,
    details: {
      aggressiveHitter: c.counterEvidence.includes("AGGRESSIVE_HITTER")
        ? `O-Swing% ≥ ${AGGRESSIVE_CHASE_THRESHOLD}% (chases pitches; unlikely to draw walks)` : null,
      pitcherLowWalkRate: c.counterEvidence.includes("PITCHER_LOW_WALK_RATE")
        ? `Pitcher BB% ≤ ${PITCHER_LOW_BB_THRESHOLD}% (excellent command; rarely walks batters)` : null,
      firstPitchStrikeHeavy: c.counterEvidence.includes("FIRST_PITCH_STRIKE_HEAVY")
        ? `F-Strike% ≥ ${HIGH_F_STRIKE_THRESHOLD}% (pitchers consistently get ahead vs this hitter)` : null,
      insufficientSample: c.counterEvidence.includes("INSUFFICIENT_SAMPLE")
        ? `Hitter PA < ${MIN_HITTER_PA} or pitcher BF < ${MIN_PITCHER_BF}` : null,
    },
  };
}

// ── DB write ──────────────────────────────────────────────────────────────────

async function writeCandidate(c: WALKCandidate, ingestRunId: string): Promise<string> {
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
      JSON.stringify(buildBullpenWalkEvidence(c)),
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

async function writeEvidenceBlocks(candidateId: string, c: WALKCandidate): Promise<void> {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  const hitterBBPct  = n(c.hitterFeatures, hk("bb_percent", side)) ?? n(c.hitterFeatures, "bb_percent");
  const pitcherBBPct = n(c.pitcherFeatures, pk("bb_percent", side)) ?? n(c.pitcherFeatures, "bb_percent");
  const oSwingPct    = n(c.hitterFeatures, "o_swing_percent");

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
      narrative: `Batting ${c.battingOrder ?? "unknown"} in lineup (${c.lineupState} source). Lower order = more PA opportunity for walks.`,
      rawEvidence: buildOpportunityEvidence(c),
    },
    {
      blockType: "STARTER_MATCHUP", metricKey: "pitcher_bb_percent", metricLabel: "Pitcher BB%",
      value: pitcherBBPct, unit: "%", sampleSize: null,
      direction: pitcherBBPct === null ? "UNKNOWN" : pitcherBBPct >= 9.0 ? "FAVORABLE" : pitcherBBPct >= 6.0 ? "NEUTRAL" : "UNFAVORABLE",
      strength: pitcherBBPct === null ? "UNKNOWN" : pitcherBBPct >= 12.0 ? "STRONG" : pitcherBBPct >= 9.0 ? "MODERATE" : "WEAK",
      narrative: `Pitcher walk rate season avg${side ? ` vs ${side}HB` : ""}. Higher = more walk opportunity for hitter.`,
      rawEvidence: buildStarterMatchupEvidence(c),
    },
    {
      blockType: "RECENT_VS_SEASON_VS_CAREER", metricKey: "season_bb_percent", metricLabel: "Season BB%",
      value: hitterBBPct, unit: "%", sampleSize: n(c.hitterFeatures, "pa"),
      direction: hitterBBPct === null ? "UNKNOWN" : hitterBBPct >= 12.0 ? "FAVORABLE" : hitterBBPct >= 8.0 ? "NEUTRAL" : "UNFAVORABLE",
      strength: hitterBBPct === null ? "UNKNOWN" : hitterBBPct >= 16.0 ? "STRONG" : hitterBBPct >= 12.0 ? "MODERATE" : "WEAK",
      narrative: "Hitter walk rate (season). No power metrics used. Walk research is discipline-driven.",
      rawEvidence: buildRecentVsSeasonVsCareer(c),
    },
    {
      blockType: "STARTER_MATCHUP", metricKey: "hitter_o_swing_percent", metricLabel: "Hitter O-Swing% (chase rate)",
      value: oSwingPct, unit: "%", sampleSize: n(c.hitterFeatures, "pa"),
      direction: oSwingPct === null ? "UNKNOWN" : oSwingPct <= 28.0 ? "FAVORABLE" : oSwingPct <= 33.0 ? "NEUTRAL" : "UNFAVORABLE",
      strength: oSwingPct === null ? "UNKNOWN" : oSwingPct <= 22.0 ? "STRONG" : oSwingPct <= 28.0 ? "MODERATE" : "WEAK",
      narrative: "Hitter chase rate. Lower = more disciplined = better walk candidate. High chase rate is a key counter-evidence flag.",
      rawEvidence: buildStarterMatchupEvidence(c),
    },
    {
      blockType: "BULLPEN_PATH", metricKey: "bullpen_avg_bb_pct", metricLabel: "Bullpen avg BB%",
      value: c.bullpen.avgBBPct, unit: "%", sampleSize: c.bullpen.availableArms,
      direction: c.bullpen.avgBBPct === null ? "UNKNOWN"
        : c.bullpen.avgBBPct >= BULLPEN_WALK_BB_THRESHOLD ? "FAVORABLE" : "CONTEXT_ONLY",
      strength: c.bullpen.availableHighLeverage > 0 ? "MODERATE" : "WEAK",
      narrative: `${c.bullpen.availableArms} available/likely-available opposing arms. Avg BB% of these arms (walk-path context).`,
      rawEvidence: buildBullpenWalkEvidence(c),
    },
    {
      blockType: "PARK", metricKey: "park_note", metricLabel: "Park context",
      value: null, unit: null, sampleSize: null,
      direction: "CONTEXT_ONLY", strength: "CONTEXT_ONLY",
      narrative: "Park factors are context only for Walk market. Walk rate is primarily pitcher/hitter discipline driven.",
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
      [candidateId, b.blockType, WALK_ENGINE_SOURCE, b.metricKey, b.metricLabel,
       b.value, b.unit, b.sampleSize, b.direction, b.strength, b.narrative, JSON.stringify(b.rawEvidence)],
    );
  }
}

// ── Main engine entry point ───────────────────────────────────────────────────

async function reconcileSlateCandidates(slateDate: string, candidates: WALKCandidate[]): Promise<number> {
  if (candidates.length === 0) {
    const result = await pool.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM market_research_candidates
         WHERE slate_date = $1 AND market = 'BATTER_WALK'
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
       WHERE mrc.slate_date = $1 AND mrc.market = 'BATTER_WALK'
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

export async function runWALKEngine(slateDate: string): Promise<WALKEngineResult> {
  const started = Date.now();
  const notes: string[] = [];
  // Hoisted so the catch block can mark the run FAILED if it was created
  let ingestRunId: string | null = null;

  try {
    await ensureWALKEngineSource();

    const games = await getSlateGames(slateDate);
    if (games.length === 0) {
      const staleRemoved = await reconcileSlateCandidates(slateDate, []);
      const noGamesNote = staleRemoved > 0
        ? `No games on this date; ${staleRemoved} stale WALK candidate(s) from a prior run have been cleared.`
        : "No games found for this date; Walk board is empty.";
      return {
        market: "WALK", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
        blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
        processingMs: Date.now() - started, notes: [noGamesNote], error: null,
      };
    }

    const gamePks = games.map((g) => g.gamePk);
    const lineupPlayers = await getSlateLineupPlayers(gamePks);

    if (lineupPlayers.length === 0) {
      notes.push("No lineup entries found. Walk candidates require lineup data.");
    }

    // Create ingest run — hoisted ID is visible to catch block for FAILED marking
    const runResult = await pool.query<{ ingest_run_id: string }>(
      `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
       VALUES ($1, 'walk_engine_research', 'RUNNING', $2) RETURNING ingest_run_id`,
      [WALK_ENGINE_SOURCE, slateDate],
    );
    ingestRunId = runResult.rows[0].ingest_run_id;

    // Per-game caches to avoid redundant DB queries
    const starterCache = new Map<string, StarterInfo>();
    const hitterCache  = new Map<number, FeatureMap>();
    const pitcherCache = new Map<number, FeatureMap>();
    const parkCache    = new Map<number, FeatureMap>();
    const bullpenCache = new Map<string, BullpenWalkSummary>();

    const candidates: WALKCandidate[] = [];

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
        bullpenCache.set(bullpenKey, await getBullpenWalkSummary(player.oppTeamId, slateDate));
      }
      const bullpen = bullpenCache.get(bullpenKey)!;

      const missingData: string[] = [];
      if (hitterFeatures.size === 0) missingData.push("No season hitter research data");
      if (starter.playerId === null)  missingData.push("Opposing starter identity unknown");
      else if (pitcherFeatures.size === 0) missingData.push("No season pitcher research data");
      if (player.venueId === null || parkFeatures.size === 0) missingData.push("Park factors unavailable");
      if (bullpen.availableArms === 0) missingData.push("Bullpen availability not yet computed for this date");

      const { primary: mechanism, secondary: secondaryMechanism } = classifyMechanism(
        hitterFeatures, bullpen, player.bats, starter.throws,
      );
      const hitterPA  = n(hitterFeatures, "pa");
      const pitcherBF = n(pitcherFeatures, "bf") ?? n(pitcherFeatures, "pa");
      const counterEvidence = checkCounterEvidence(
        hitterFeatures, pitcherFeatures,
        player.bats, starter.throws,
        hitterPA, pitcherBF,
      );
      const evidenceScore = computeEvidenceScore(
        hitterFeatures, pitcherFeatures, bullpen,
        player.battingOrder, player.bats, starter.throws, counterEvidence,
      );
      const researchState = assignResearchState(
        starter.playerId !== null, player.battingOrder !== null, evidenceScore,
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

    let candidatesWritten = 0;
    for (const c of candidates) {
      await writeCandidate(c, ingestRunId);
      candidatesWritten++;
    }

    const staleRemoved = await reconcileSlateCandidates(slateDate, candidates);
    if (staleRemoved > 0) {
      notes.push(`Reconciliation removed ${staleRemoved} stale WALK candidate(s) from this slate.`);
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
       JSON.stringify({ market: "WALK", slateDate, games: games.length, staleRemoved, ...counts })],
    );

    return {
      market: "WALK", slateDate, gamesProcessed: games.length,
      candidatesProcessed: candidates.length, candidatesWritten,
      blockedCandidates: counts.blocked, strongCandidates: counts.strong,
      positiveCandidates: counts.positive, neutralCandidates: counts.neutral,
      negativeCandidates: counts.negative,
      processingMs: Date.now() - started, notes, error: null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (ingestRunId) {
      pool.query(
        `UPDATE ingest_runs SET finished_at = now(), status = 'FAILED', metadata = $2
         WHERE ingest_run_id = $1`,
        [ingestRunId, JSON.stringify({ error, slateDate })],
      ).catch(() => { /* suppress secondary failure */ });
    }
    return {
      market: "WALK", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
      blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
      processingMs: Date.now() - started, notes, error,
    };
  }
}
