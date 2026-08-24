/**
 * Phase 3D – Home Run Research Engine
 *
 * Identifies candidate hitters via PULL_AIR, BARREL_POWER, PITCH_SHAPE_MISMATCH,
 * and PARK_ENVIRONMENT mechanisms. PARK_ENVIRONMENT is a first-class primary mechanism —
 * not a context-only signal as in TB/XBH/WALK.
 *
 * RANK, DON'T GATE contract:
 *   research_rank is an ordinal integer only. No state value removes a candidate
 *   from the board. Ties share the same rank value and are never collapsed.
 *   No sportsbook price, odds, EV, CLV, or implied probability is produced.
 *
 * Classification rule (documented for Phase 5 audit):
 *   PULL_AIR            — pull_percent ≥ 38% AND fb_percent ≥ 38%
 *     (pull-side fly-ball profile → most reliable HR trajectory predictor)
 *   BARREL_POWER        — barrel_pa ≥ 5.0% AND avg_ev ≥ 92 mph
 *     (elite barrel rate + high exit velocity → raw power profile)
 *   PITCH_SHAPE_MISMATCH — (pitcher barrel% ≥ 8.0% OR pitcher HR/BF ≥ 3.0%)
 *                           AND hitter has at least one power signal
 *     (matchup-driven: pitcher allows power contact, hitter can capitalise)
 *   PARK_ENVIRONMENT    — park hr_factor ≥ 1.10
 *     (first-class primary mechanism: park provides the structural HR opportunity)
 *   Default             — BARREL_POWER (base case for all power hitters)
 *
 *   Power signals (for PITCH_SHAPE_MISMATCH hitter check):
 *     barrel_pa ≥ 3.0 | avg_ev ≥ 90 | (pull% ≥ 36 AND fb% ≥ 36) |
 *     iso ≥ 0.160 | hard_hit_percent ≥ 42
 *
 * Counter-evidence (documented for Phase 5 audit):
 *   LOW_BARREL_RATE       — barrel_pa < 2.5% (insufficient barrel generation)
 *   GROUND_BALL_DOMINANT  — gb_percent ≥ 50% (drives balls into ground, not air)
 *   PITCHER_LOW_HR_RATE   — pitcher HR/BF < 2.0% (suppresses HR contact)
 *   NEUTRAL_PARK          — park hr_factor < 0.95 (park suppresses HRs)
 *   INSUFFICIENT_SAMPLE   — hitter PA < 50 or pitcher BF < 60 (noted; no score penalty)
 *
 * Competition ranking:
 *   Candidates sorted by evidenceScore DESC. Tiebreaker = player name ASC.
 *   Ties share the same rank; next rank after a k-way tie skips k−1 positions (1,1,3 not 1,1,2).
 */

import { pool } from "@workspace/db";
import { MARKET_TO_DB } from "./market-codes";
import { conflictsFor, querySlateLineupPlayers } from "./lineup-sources";
import { getSlateWeather, weatherAdjustment, type GameWeather } from "./weather-foundation";
import { getBatterPitcherEvidence } from "./batter-pitcher-research";
import { getBullpenRolePath, type BullpenRolePath } from "./bullpen-foundation";

// ── Source / market constants ─────────────────────────────────────────────────

const HR_ENGINE_SOURCE = "HR_ENGINE";
const MARKET = MARKET_TO_DB.HR;

// ── Mechanism thresholds ──────────────────────────────────────────────────────

// PULL_AIR
const PULL_AIR_PULL_PCT   = 38.0; // pull_percent ≥ this → pull-side profile
const PULL_AIR_FB_PCT     = 38.0; // fb_percent   ≥ this → fly-ball profile

// BARREL_POWER
const BARREL_POWER_BARREL_PA = 5.0;  // barrel_pa ≥ this → elite barrel rate
const BARREL_POWER_AVG_EV    = 92.0; // avg_ev     ≥ this → elite exit velocity

// PITCH_SHAPE_MISMATCH (pitcher thresholds)
const MISMATCH_PITCHER_BARREL_PCT = 8.0; // pitcher barrel% ≥ this → power-contact pitcher
const MISMATCH_PITCHER_HR_BF_PCT  = 3.0; // pitcher HR/BF ≥ this% → HR-prone pitcher

// Power signal thresholds (hitter check for PITCH_SHAPE_MISMATCH)
const POWER_SIGNAL_BARREL_PA      = 3.0;  // barrel_pa ≥ this → power signal
const POWER_SIGNAL_AVG_EV         = 90.0; // avg_ev ≥ this → power signal
const POWER_SIGNAL_PULL_PCT       = 36.0; // pull% ≥ this (combined with fb%) → power signal
const POWER_SIGNAL_FB_PCT         = 36.0; // fb%   ≥ this (combined with pull%) → power signal
const POWER_SIGNAL_ISO            = 0.160; // iso ≥ this → power signal
const POWER_SIGNAL_HARD_HIT_PCT   = 42.0; // hard_hit_percent ≥ this → power signal

// PARK_ENVIRONMENT
const PARK_HR_FACTOR_FAVORABLE = 1.10; // hr_factor ≥ this → HR-friendly park (primary mechanism)
const PARK_HR_FACTOR_SUPPRESSED = 0.95; // hr_factor < this → park suppresses HRs (counter)

// ── Counter-evidence thresholds ───────────────────────────────────────────────

const LOW_BARREL_RATE_THRESHOLD    = 2.5;  // barrel_pa < this → insufficient barrel generation
const GROUND_BALL_PCT_THRESHOLD    = 50.0; // gb_percent ≥ this → ground-ball dominant
const PITCHER_LOW_HR_BF_THRESHOLD  = 2.0;  // pitcher HR/BF % < this → suppresses HRs
const MIN_HITTER_PA                = 50;
const MIN_PITCHER_BF               = 60;

// ── Evidence score thresholds (not exposed externally) ────────────────────────

const SCORE_STRONG   = 6;
const SCORE_POSITIVE = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

type N = number | null;
type FeatureMap = Map<string, N>;

export type HRMechanism =
  | "PULL_AIR"
  | "BARREL_POWER"
  | "PITCH_SHAPE_MISMATCH"
  | "PARK_ENVIRONMENT";

export type HRResearchState = "STRONG" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "BLOCKED";

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

interface BullpenHRSummary extends BullpenRolePath {
  availableHighLeverage: number;
  avgBarrelPct: N;     // average barrel% across projected path arms
  avgHardHitPct: N;    // average hard-hit% across projected path arms
  hrProneArmCount: number; // arms with barrel% ≥ MISMATCH_PITCHER_BARREL_PCT
  barrelMetricArmCount: number;
  hardHitMetricArmCount: number;
}

interface HRCandidate {
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
  bullpen: BullpenHRSummary;
  mechanism: HRMechanism;
  secondaryMechanism: HRMechanism | null;
  researchState: HRResearchState;
  counterEvidence: string[];
  evidenceScore: number;
  researchRank: number | null;
  missingData: string[];
}

export interface HREngineResult {
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

async function ensureHREngineSource() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, notes)
     VALUES ($1, 'Home Run Research Engine (Phase 3D)', 'RESEARCH',
             'Ordinal evidence-based ranking engine for HOME_RUN market. ' ||
             'Mechanisms: PULL_AIR, BARREL_POWER, PITCH_SHAPE_MISMATCH, PARK_ENVIRONMENT. ' ||
             'PARK_ENVIRONMENT is a first-class primary mechanism. ' ||
             'Writes to market_research_candidates. No odds, EV, or CLV produced.')
     ON CONFLICT (source_id) DO NOTHING`,
    [HR_ENGINE_SOURCE],
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

async function getBullpenHRSummary(teamId: number, slateDate: string): Promise<BullpenHRSummary> {
  const path = await getBullpenRolePath(teamId, slateDate);
  if (path.status !== "CURRENT") {
    return {
      ...path,
      availableHighLeverage: path.rolePath.length,
      avgBarrelPct: null,
      avgHardHitPct: null,
      hrProneArmCount: 0,
      barrelMetricArmCount: 0,
      hardHitMetricArmCount: 0,
    };
  }
  const armIds = path.armIds;

  let avgBarrelPct: N = null;
  let avgHardHitPct: N = null;
  let hrProneArmCount = 0;
  let barrelMetricArmCount = 0;
  let hardHitMetricArmCount = 0;

  if (armIds.length > 0) {
    // Barrel% of projected role-path arms (HR-proneness proxy)
    const barrelResult = await pool.query<{ avg_barrel_pct: string | null; hr_prone_count: string; metric_arm_count: string }>(
      `SELECT
         AVG(latest_barrel)::text AS avg_barrel_pct,
         COUNT(*) FILTER (WHERE latest_barrel >= $2)::text AS hr_prone_count,
         COUNT(latest_barrel)::text AS metric_arm_count
       FROM (
         SELECT DISTINCT ON (s.player_id)
           f.value::numeric AS latest_barrel
         FROM pitcher_research_features f
         JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
         WHERE s.player_id = ANY($1)
           AND f.metric_key = 'barrel_percent'
           AND f.batter_side IS NULL
           AND s.research_window = 'SEASON'
         ORDER BY s.player_id, s.retrieved_at DESC
       ) latest`,
      [armIds, MISMATCH_PITCHER_BARREL_PCT],
    );
    barrelMetricArmCount = Number(barrelResult.rows[0]?.metric_arm_count ?? 0);
    avgBarrelPct = barrelMetricArmCount === armIds.length && barrelResult.rows[0]?.avg_barrel_pct != null
      ? Number(barrelResult.rows[0].avg_barrel_pct)
      : null;
    hrProneArmCount = barrelMetricArmCount === armIds.length
      ? Number(barrelResult.rows[0]?.hr_prone_count ?? 0)
      : 0;

    // Hard-hit% of projected role-path arms
    const hhResult = await pool.query<{ avg_hh_pct: string | null; metric_arm_count: string }>(
      `SELECT AVG(latest_val)::text AS avg_hh_pct, COUNT(latest_val)::text AS metric_arm_count
       FROM (
         SELECT DISTINCT ON (s.player_id)
           f.value::numeric AS latest_val
         FROM pitcher_research_features f
         JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
         WHERE s.player_id = ANY($1)
           AND f.metric_key = 'hard_hit_percent'
           AND f.batter_side IS NULL
           AND s.research_window = 'SEASON'
         ORDER BY s.player_id, s.retrieved_at DESC
       ) latest`,
      [armIds],
    );
    hardHitMetricArmCount = Number(hhResult.rows[0]?.metric_arm_count ?? 0);
    avgHardHitPct = hardHitMetricArmCount === armIds.length && hhResult.rows[0]?.avg_hh_pct != null
      ? Number(hhResult.rows[0].avg_hh_pct)
      : null;
  }

  return {
    ...path,
    availableHighLeverage: path.rolePath.length,
    avgBarrelPct,
    avgHardHitPct,
    hrProneArmCount,
    barrelMetricArmCount,
    hardHitMetricArmCount,
  };
}

// ── Power signal check ────────────────────────────────────────────────────────

/**
 * Returns true if the hitter has at least one power signal qualifying them for
 * the PITCH_SHAPE_MISMATCH mechanism path. Uses overall (non-split) features where
 * platoon splits may not be populated.
 */
function hitterHasPowerSignal(hitter: FeatureMap): boolean {
  const barrelPa   = n(hitter, "barrel_pa");
  const avgEv      = n(hitter, "avg_ev");
  const pullPct    = n(hitter, "pull_percent");
  const fbPct      = n(hitter, "fb_percent");
  const iso        = n(hitter, "iso");
  const hardHitPct = n(hitter, "hard_hit_percent");

  if (barrelPa !== null && barrelPa >= POWER_SIGNAL_BARREL_PA)  return true;
  if (avgEv !== null    && avgEv >= POWER_SIGNAL_AVG_EV)        return true;
  if (pullPct !== null  && fbPct !== null
      && pullPct >= POWER_SIGNAL_PULL_PCT && fbPct >= POWER_SIGNAL_FB_PCT) return true;
  if (iso !== null      && iso >= POWER_SIGNAL_ISO)             return true;
  if (hardHitPct !== null && hardHitPct >= POWER_SIGNAL_HARD_HIT_PCT) return true;
  return false;
}

// ── Classification logic ──────────────────────────────────────────────────────

function classifyMechanism(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  park: FeatureMap,
  _bats: string | null,
  _pitcherThrows: string | null,
): { primary: HRMechanism; secondary: HRMechanism | null } {
  const pullPct   = n(hitter, "pull_percent");
  const fbPct     = n(hitter, "fb_percent");
  const barrelPa  = n(hitter, "barrel_pa");
  const avgEv     = n(hitter, "avg_ev");

  // Pitcher HR-proneness signals
  const pitcherBarrelPct = n(pitcher, "barrel_percent");
  const pitcherHRAllowed = n(pitcher, "home_runs_allowed");
  const pitcherBF        = n(pitcher, "bf") ?? n(pitcher, "pa");
  const pitcherHRBFPct   = (pitcherHRAllowed !== null && pitcherBF !== null && pitcherBF > 0)
    ? (pitcherHRAllowed / pitcherBF) * 100
    : null;

  // Park signal
  const hrFactor = n(park, "hr_factor");

  // ── Mechanism 1: PULL_AIR ──────────────────────────────────────────────────
  const isPullAir =
    pullPct !== null && pullPct >= PULL_AIR_PULL_PCT &&
    fbPct   !== null && fbPct   >= PULL_AIR_FB_PCT;

  // ── Mechanism 2: BARREL_POWER ─────────────────────────────────────────────
  const isBarrelPower =
    barrelPa !== null && barrelPa >= BARREL_POWER_BARREL_PA &&
    avgEv    !== null && avgEv    >= BARREL_POWER_AVG_EV;

  // ── Mechanism 3: PITCH_SHAPE_MISMATCH ────────────────────────────────────
  const pitcherIsPowerContact =
    (pitcherBarrelPct !== null && pitcherBarrelPct >= MISMATCH_PITCHER_BARREL_PCT) ||
    (pitcherHRBFPct   !== null && pitcherHRBFPct   >= MISMATCH_PITCHER_HR_BF_PCT);
  const isPitchShapeMismatch = pitcherIsPowerContact && hitterHasPowerSignal(hitter);

  // ── Mechanism 4: PARK_ENVIRONMENT ────────────────────────────────────────
  const isParkEnvironment = hrFactor !== null && hrFactor >= PARK_HR_FACTOR_FAVORABLE;

  // ── Hierarchical selection ────────────────────────────────────────────────
  if (isPullAir) {
    const secondary: HRMechanism | null =
      isBarrelPower       ? "BARREL_POWER"
      : isPitchShapeMismatch ? "PITCH_SHAPE_MISMATCH"
      : isParkEnvironment    ? "PARK_ENVIRONMENT"
      : null;
    return { primary: "PULL_AIR", secondary };
  }

  if (isBarrelPower) {
    const secondary: HRMechanism | null =
      isPullAir           ? "PULL_AIR"          // already handled above
      : isPitchShapeMismatch ? "PITCH_SHAPE_MISMATCH"
      : isParkEnvironment    ? "PARK_ENVIRONMENT"
      : null;
    return { primary: "BARREL_POWER", secondary };
  }

  if (isPitchShapeMismatch) {
    const secondary: HRMechanism | null =
      isPullAir           ? "PULL_AIR"
      : isBarrelPower     ? "BARREL_POWER"
      : isParkEnvironment ? "PARK_ENVIRONMENT"
      : null;
    return { primary: "PITCH_SHAPE_MISMATCH", secondary };
  }

  if (isParkEnvironment) {
    // Park is the primary driver — no other mechanism threshold met
    return { primary: "PARK_ENVIRONMENT", secondary: null };
  }

  // Default: BARREL_POWER (base case — the canonical HR research path)
  return { primary: "BARREL_POWER", secondary: null };
}

function checkCounterEvidence(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  park: FeatureMap,
  hitterPA: N,
  pitcherBF: N,
  weather: GameWeather | null = null,
  bats: string | null = null,
  pitcherThrows: string | null = null,
): string[] {
  const counters: string[] = [];

  // Audit S12. The platoon side could not be resolved, so every split metric
  // resolved for this candidate silently falls back to the unsplit season line.
  // Disclosed as counter evidence, never in missing_stale_evidence: that field
  // is a blocking gate, and an unknown handedness is a caveat on the reading,
  // not a veto on the candidate. Pairs with S1, which is what makes the
  // underlying value trustworthy in the first place.
  if (resolveBatterSide(bats, pitcherThrows) === null) counters.push("PLATOON_SIDE_UNRESOLVED");

  // Insufficient barrel generation
  const barrelPa = n(hitter, "barrel_pa");
  if (barrelPa !== null && barrelPa < LOW_BARREL_RATE_THRESHOLD) {
    counters.push("LOW_BARREL_RATE");
  }

  // Ground-ball dominant — balls in play go down, not up
  const gbPct = n(hitter, "gb_percent");
  if (gbPct !== null && gbPct >= GROUND_BALL_PCT_THRESHOLD) {
    counters.push("GROUND_BALL_DOMINANT");
  }

  // Pitcher suppresses HR contact
  const pitcherHRAllowed = n(pitcher, "home_runs_allowed");
  const pitcherBFVal     = pitcherBF;
  const pitcherHRBFPct   = (pitcherHRAllowed !== null && pitcherBFVal !== null && pitcherBFVal > 0)
    ? (pitcherHRAllowed / pitcherBFVal) * 100
    : null;
  if (pitcherHRBFPct !== null && pitcherHRBFPct < PITCHER_LOW_HR_BF_THRESHOLD) {
    counters.push("PITCHER_LOW_HR_RATE");
  }

  // Park suppresses HR
  const hrFactor = n(park, "hr_factor");
  if (hrFactor !== null && hrFactor < PARK_HR_FACTOR_SUPPRESSED) {
    counters.push("NEUTRAL_PARK");
  }

  // Insufficient sample — noted, no score penalty
  if ((hitterPA !== null && hitterPA < MIN_HITTER_PA) || (pitcherBF !== null && pitcherBF < MIN_PITCHER_BF)) {
    counters.push("INSUFFICIENT_SAMPLE");
  }


  // Weather extremes. Flags rather than score nudges: their effect is not
  // linear, and the coefficients that suppress total bases and home runs are
  // not the coefficients that apply to walks.
  counters.push(...weatherAdjustment("HR", weather).flags);

  return counters;
}

function computeEvidenceScore(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  park: FeatureMap,
  bullpen: BullpenHRSummary,
  battingOrder: number | null,
  bats: string | null,
  pitcherThrows: string | null,
  counterEvidence: string[],
  weather: GameWeather | null = null,
): number {
  const side = resolveBatterSide(bats, pitcherThrows);

  const barrelPa   = n(hitter, "barrel_pa");
  const avgEv      = n(hitter, "avg_ev");
  const pullPct    = n(hitter, "pull_percent");
  const fbPct      = n(hitter, "fb_percent");
  const iso        = n(hitter, "iso");
  const hardHitPct = n(hitter, "hard_hit_percent");

  const pitcherBarrelPct  = n(pitcher, pk("barrel_percent",   side)) ?? n(pitcher, "barrel_percent");
  const pitcherXSLGAllow  = n(pitcher, pk("xslg_allowed",     side)) ?? n(pitcher, "xslg_allowed");

  const hrFactor = n(park, "hr_factor");

  let score = 0;

  // Batting order (HR opportunity)
  if (battingOrder !== null) {
    if      (battingOrder <= 4) score += 1.0;
    else if (battingOrder <= 6) score += 0.0;
    else                        score -= 0.5;
  }

  // Barrel/PA — primary HR power metric
  if (barrelPa !== null) {
    if      (barrelPa >= 10.0) score += 6;
    else if (barrelPa >=  8.0) score += 5;
    else if (barrelPa >=  5.0) score += 3;
    else if (barrelPa >=  3.0) score += 1;
  }

  // Average exit velocity
  if (avgEv !== null) {
    if      (avgEv >= 96.0) score += 3;
    else if (avgEv >= 92.0) score += 2;
    else if (avgEv >= 90.0) score += 1;
  }

  // Pull + fly profile (air ball authority)
  if (pullPct !== null && fbPct !== null) {
    if (pullPct >= 42 && fbPct >= 42) score += 2;
    else if (pullPct >= 38 && fbPct >= 38) score += 1;
  }

  // ISO (isolated power)
  if (iso !== null) {
    if      (iso >= 0.280) score += 3;
    else if (iso >= 0.240) score += 2;
    else if (iso >= 0.200) score += 1;
  }

  // Hard-hit%
  if (hardHitPct !== null) {
    if      (hardHitPct >= 52.0) score += 2;
    else if (hardHitPct >= 44.0) score += 1;
  }

  // Park HR factor — first-class evidence signal for HR
  if (hrFactor !== null) {
    if      (hrFactor >= 1.20) score += 3;
    else if (hrFactor >= 1.10) score += 2;
    else if (hrFactor >= 1.05) score += 1;
    // NEUTRAL_PARK penalty applied in counter-evidence section
  }

  // Pitcher matchup — barrel% allowed
  if (pitcherBarrelPct !== null) {
    if      (pitcherBarrelPct >= 12.0) score += 3;
    else if (pitcherBarrelPct >= 10.0) score += 2;
    else if (pitcherBarrelPct >=  8.0) score += 1;
  }

  // Pitcher xSLG allowed
  if (pitcherXSLGAllow !== null) {
    if      (pitcherXSLGAllow >= 0.530) score += 2;
    else if (pitcherXSLGAllow >= 0.470) score += 1;
    else if (pitcherXSLGAllow <= 0.340) score -= 1;
  }

  // Bullpen HR path — HR-prone arms in bullpen
  if (bullpen.avgBarrelPct !== null) {
    if      (bullpen.avgBarrelPct >= 12.0) score += 2;
    else if (bullpen.avgBarrelPct >= 8.0)  score += 1;
  }

  // Counter-evidence penalties
  for (const c of counterEvidence) {
    if      (c === "LOW_BARREL_RATE")      score -= 2;
    else if (c === "GROUND_BALL_DOMINANT") score -= 2;
    else if (c === "PITCHER_LOW_HR_RATE")  score -= 2;
    else if (c === "NEUTRAL_PARK")         score -= 1;
    // INSUFFICIENT_SAMPLE: noted but no score penalty
  }


  // Weather, as a bounded second-order adjustment with HR-specific
  // coefficients. A closed roof contributes exactly zero and is distinguishable
  // in the evidence from weather that is simply missing.
  score += weatherAdjustment("HR", weather).adjustment;

  return score;
}

function assignResearchState(
  hasStarterIdentity: boolean,
  _hasBattingOrder: boolean,
  evidenceScore: number,
): HRResearchState {
  // BLOCKED: no starter identity — cannot assess the power matchup
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
function assignCompetitionRanks(candidates: HRCandidate[]): void {
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

function buildOpportunityEvidence(c: HRCandidate): object {
  return {
    battingOrder: c.battingOrder,
    lineupState: c.lineupState,
    paOpportunity: c.battingOrder === null ? "UNKNOWN"
      : c.battingOrder <= 4 ? "HIGH"
        : c.battingOrder <= 6 ? "AVERAGE" : "LOW",
    seasonPA: n(c.hitterFeatures, "pa"),
  };
}

function buildStarterMatchupEvidence(c: HRCandidate): object {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  const pitcherHRAllowed = n(c.pitcherFeatures, "home_runs_allowed");
  const pitcherBF        = n(c.pitcherFeatures, "bf") ?? n(c.pitcherFeatures, "pa");
  const pitcherHRBFPct   = (pitcherHRAllowed !== null && pitcherBF !== null && pitcherBF > 0)
    ? Number(((pitcherHRAllowed / pitcherBF) * 100).toFixed(2))
    : null;
  return {
    starterIdentityKnown: c.starterPlayerId !== null,
    starterPlayerId: c.starterPlayerId,
    starterState: c.starterState,
    starterThrows: c.starterThrows,
    hitterBats: c.hitterBats,
    effectivePlatoonSide: side,
    pitcherBarrelPct:    n(c.pitcherFeatures, pk("barrel_percent",   side)) ?? n(c.pitcherFeatures, "barrel_percent"),
    pitcherHardHitPct:   n(c.pitcherFeatures, pk("hard_hit_percent", side)) ?? n(c.pitcherFeatures, "hard_hit_percent"),
    pitcherHRAllowed,
    pitcherBF,
    pitcherHRBFPct,
    pitcherXSLGAllowed:  n(c.pitcherFeatures, pk("xslg_allowed",     side)) ?? n(c.pitcherFeatures, "xslg_allowed"),
    pitcherXWOBAAllowed: n(c.pitcherFeatures, pk("xwoba_allowed",    side)) ?? n(c.pitcherFeatures, "xwoba_allowed"),
    hitterBarrelPa:      n(c.hitterFeatures, "barrel_pa"),
    hitterAvgEv:         n(c.hitterFeatures, "avg_ev"),
    hitterPullPct:       n(c.hitterFeatures, "pull_percent"),
    hitterFbPct:         n(c.hitterFeatures, "fb_percent"),
    hitterISO:           n(c.hitterFeatures, "iso"),
  };
}

function buildBullpenPathEvidence(c: HRCandidate): object {
  return {
    status: c.bullpen.status,
    reason: c.bullpen.reason,
    computedAt: c.bullpen.computedAt,
    rolePath: c.bullpen.rolePath,
    rolePathArmIds: c.bullpen.armIds,
    availableArms: c.bullpen.availableArms,
    rolePathArmCount: c.bullpen.availableHighLeverage,
    barrelMetricArmCount: c.bullpen.barrelMetricArmCount,
    hardHitMetricArmCount: c.bullpen.hardHitMetricArmCount,
    metricCoverageComplete: c.bullpen.barrelMetricArmCount === c.bullpen.armIds.length
      && c.bullpen.hardHitMetricArmCount === c.bullpen.armIds.length,
    rolePathAvgBarrelPct: c.bullpen.avgBarrelPct,
    rolePathAvgHardHitPct: c.bullpen.avgHardHitPct,
    hrProneArmCount: c.bullpen.hrProneArmCount,
    hrProneBullpenFlag: c.bullpen.hrProneArmCount > 0,
    note: c.bullpen.reason,
  };
}

function buildParkEvidence(c: HRCandidate): object {
  const hrFactor = n(c.parkFeatures, "hr_factor");
  return {
    hrFactor,
    hrFactorPresent: hrFactor !== null,
    isParkFavorable: hrFactor !== null && hrFactor >= PARK_HR_FACTOR_FAVORABLE,
    isParkSuppressed: hrFactor !== null && hrFactor < PARK_HR_FACTOR_SUPPRESSED,
    parkNote: hrFactor === null
      ? "Park HR factor unavailable for this venue"
      : hrFactor >= PARK_HR_FACTOR_FAVORABLE
        ? "HR-friendly park — first-class primary mechanism"
        : hrFactor < PARK_HR_FACTOR_SUPPRESSED
          ? "Pitcher's park — suppresses HR"
          : "Neutral park (no significant HR effect)",
  };
}

function buildRecentVsSeasonVsCareer(c: HRCandidate): object {
  return {
    seasonBarrelPa:       n(c.hitterFeatures, "barrel_pa"),
    seasonBarrelPct:      n(c.hitterFeatures, "barrel_percent"),
    seasonAvgEv:          n(c.hitterFeatures, "avg_ev"),
    seasonPullPct:        n(c.hitterFeatures, "pull_percent"),
    seasonFbPct:          n(c.hitterFeatures, "fb_percent"),
    seasonGbPct:          n(c.hitterFeatures, "gb_percent"),
    seasonLaunchAngle:    n(c.hitterFeatures, "launch_angle"),
    seasonHardHitPct:     n(c.hitterFeatures, "hard_hit_percent"),
    seasonHomeRuns:       n(c.hitterFeatures, "home_runs"),
    seasonISO:            n(c.hitterFeatures, "iso"),
    seasonXSLG:           n(c.hitterFeatures, "xslg"),
    seasonPA:             n(c.hitterFeatures, "pa"),
    window: "SEASON",
    walkMetricsNote: "Walk metrics (BB%, O-Swing%) are intentionally absent — HR research is power-profile driven",
  };
}

function buildCounterEvidenceJson(c: HRCandidate): object {
  const pitcherHRAllowed = n(c.pitcherFeatures, "home_runs_allowed");
  const pitcherBF        = n(c.pitcherFeatures, "bf") ?? n(c.pitcherFeatures, "pa");
  const pitcherHRBFPct   = (pitcherHRAllowed !== null && pitcherBF !== null && pitcherBF > 0)
    ? Number(((pitcherHRAllowed / pitcherBF) * 100).toFixed(2))
    : null;
  return {
    flags: c.counterEvidence,
    count: c.counterEvidence.length,
    details: {
      lowBarrelRate: c.counterEvidence.includes("LOW_BARREL_RATE")
        ? `Barrel/PA < ${LOW_BARREL_RATE_THRESHOLD}% — insufficient barrel generation for HR` : null,
      groundBallDominant: c.counterEvidence.includes("GROUND_BALL_DOMINANT")
        ? `GB% ≥ ${GROUND_BALL_PCT_THRESHOLD}% — ground-ball profile suppresses fly-ball HR` : null,
      pitcherLowHRRate: c.counterEvidence.includes("PITCHER_LOW_HR_RATE")
        ? `Pitcher HR/BF < ${PITCHER_LOW_HR_BF_THRESHOLD}%${pitcherHRBFPct !== null ? ` (actual: ${pitcherHRBFPct}%)` : ""} — suppresses HR contact` : null,
      neutralPark: c.counterEvidence.includes("NEUTRAL_PARK")
        ? `Park HR factor < ${PARK_HR_FACTOR_SUPPRESSED} — park suppresses HR` : null,
      insufficientSample: c.counterEvidence.includes("INSUFFICIENT_SAMPLE")
        ? `Hitter PA < ${MIN_HITTER_PA} or pitcher BF < ${MIN_PITCHER_BF}` : null,
    },
  };
}

// ── DB write ──────────────────────────────────────────────────────────────────

/**
 * Anything that can run a query: the shared pool, or a client inside a
 * transaction. The slate write path takes one so it can be made atomic.
 */
type Queryable = Pick<typeof pool, "query">;

async function writeCandidate(
  executor: Queryable,
  c: HRCandidate,
  ingestRunId: string,
): Promise<string> {
  const result = await executor.query<{ candidate_id: string }>(
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
        opportunity_evidence = CASE
          WHEN market_research_candidates.opportunity_evidence->>'source' = 'FANTASYPROS'
            THEN jsonb_build_object('baseline', market_research_candidates.opportunity_evidence, 'research', EXCLUDED.opportunity_evidence)
          WHEN market_research_candidates.opportunity_evidence ? 'baseline'
            THEN jsonb_set(market_research_candidates.opportunity_evidence, '{research}', EXCLUDED.opportunity_evidence, true)
          ELSE EXCLUDED.opportunity_evidence
        END,
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
  await writeEvidenceBlocks(executor, candidateId, c);
  return candidateId;
}

async function writeEvidenceBlocks(
  executor: Queryable,
  candidateId: string,
  c: HRCandidate,
): Promise<void> {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);

  const barrelPa         = n(c.hitterFeatures, "barrel_pa");
  const avgEv            = n(c.hitterFeatures, "avg_ev");
  const hrFactor         = n(c.parkFeatures, "hr_factor");
  const pitcherBarrelPct = n(c.pitcherFeatures, pk("barrel_percent", side)) ?? n(c.pitcherFeatures, "barrel_percent");

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
      strength: c.battingOrder === null ? "UNKNOWN" : c.battingOrder <= 4 ? "MODERATE" : "WEAK",
      narrative: `Batting ${c.battingOrder ?? "unknown"} in lineup (${c.lineupState} source). Lower order = more PA opportunity for HR.`,
      rawEvidence: buildOpportunityEvidence(c),
    },
    {
      blockType: "RECENT_VS_SEASON_VS_CAREER", metricKey: "barrel_pa", metricLabel: "Barrel/PA",
      value: barrelPa, unit: "%", sampleSize: n(c.hitterFeatures, "pa"),
      direction: barrelPa === null ? "UNKNOWN" : barrelPa >= 5.0 ? "FAVORABLE" : barrelPa >= 3.0 ? "NEUTRAL" : "UNFAVORABLE",
      strength: barrelPa === null ? "UNKNOWN" : barrelPa >= 8.0 ? "STRONG" : barrelPa >= 5.0 ? "MODERATE" : "WEAK",
      narrative: "Barrel/PA (season). Primary HR power metric — barrel contact most predictive of HR outcome.",
      rawEvidence: buildRecentVsSeasonVsCareer(c),
    },
    {
      blockType: "RECENT_VS_SEASON_VS_CAREER", metricKey: "avg_ev", metricLabel: "Average exit velocity",
      value: avgEv, unit: "mph", sampleSize: n(c.hitterFeatures, "pa"),
      direction: avgEv === null ? "UNKNOWN" : avgEv >= 92.0 ? "FAVORABLE" : avgEv >= 88.0 ? "NEUTRAL" : "UNFAVORABLE",
      strength: avgEv === null ? "UNKNOWN" : avgEv >= 96.0 ? "STRONG" : avgEv >= 92.0 ? "MODERATE" : "WEAK",
      narrative: "Season average exit velocity. Higher exit velocity = more HR authority on contact.",
      rawEvidence: buildRecentVsSeasonVsCareer(c),
    },
    {
      blockType: "PARK", metricKey: "hr_factor", metricLabel: "Park HR factor",
      value: hrFactor, unit: "factor", sampleSize: null,
      direction: hrFactor === null ? "UNKNOWN"
        : hrFactor >= PARK_HR_FACTOR_FAVORABLE ? "FAVORABLE"
          : hrFactor < PARK_HR_FACTOR_SUPPRESSED ? "UNFAVORABLE" : "CONTEXT_ONLY",
      strength: hrFactor === null ? "UNKNOWN"
        : hrFactor >= 1.20 ? "STRONG"
          : hrFactor >= PARK_HR_FACTOR_FAVORABLE ? "MODERATE"
            : hrFactor < PARK_HR_FACTOR_SUPPRESSED ? "WEAK" : "CONTEXT_ONLY",
      narrative: hrFactor === null
        ? "Park HR factor unavailable. Park is a first-class primary mechanism for HR."
        : `Park HR factor ${hrFactor.toFixed(2)} — ${hrFactor >= PARK_HR_FACTOR_FAVORABLE ? "HR-friendly park enhances HR opportunity" : hrFactor < PARK_HR_FACTOR_SUPPRESSED ? "pitcher's park suppresses HR" : "neutral park context"}.`,
      rawEvidence: buildParkEvidence(c),
    },
    {
      blockType: "STARTER_MATCHUP", metricKey: "pitcher_barrel_percent", metricLabel: "Pitcher barrel% allowed",
      value: pitcherBarrelPct, unit: "%", sampleSize: null,
      direction: pitcherBarrelPct === null ? "UNKNOWN" : pitcherBarrelPct >= 8.0 ? "FAVORABLE" : pitcherBarrelPct >= 5.0 ? "NEUTRAL" : "UNFAVORABLE",
      strength: pitcherBarrelPct === null ? "UNKNOWN" : pitcherBarrelPct >= 12.0 ? "STRONG" : pitcherBarrelPct >= 8.0 ? "MODERATE" : "WEAK",
      narrative: `Pitcher season barrel% allowed${side ? ` vs ${side}HB` : ""}. Higher = more HR power-contact opportunity for hitter.`,
      rawEvidence: buildStarterMatchupEvidence(c),
    },
    {
      blockType: "BULLPEN_PATH", metricKey: "bullpen_avg_barrel_pct", metricLabel: "Bullpen avg barrel%",
      value: c.bullpen.avgBarrelPct, unit: "%", sampleSize: c.bullpen.availableHighLeverage,
      direction: c.bullpen.avgBarrelPct === null ? "UNKNOWN"
        : c.bullpen.avgBarrelPct >= 8.0 ? "FAVORABLE" : "CONTEXT_ONLY",
      strength: c.bullpen.hrProneArmCount > 1 ? "MODERATE" : c.bullpen.hrProneArmCount > 0 ? "WEAK" : "CONTEXT_ONLY",
      narrative: c.bullpen.status === "CURRENT"
        ? `Projected 7th/8th/9th role path (${c.bullpen.rolePath.map((arm) => arm.role).join(" → ")}). ${c.bullpen.hrProneArmCount} HR-prone arm(s) (barrel% ≥ ${MISMATCH_PITCHER_BARREL_PCT}%).`
        : `Bullpen path unavailable: ${c.bullpen.reason}`,
      rawEvidence: buildBullpenPathEvidence(c),
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
    await executor.query(
      `INSERT INTO market_research_evidence_blocks
         (candidate_id, block_type, source_id, metric_key, metric_label,
          value, unit, sample_size, direction, strength, narrative, raw_evidence, retrieved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (candidate_id, block_type, metric_key) DO UPDATE SET
         value = EXCLUDED.value, direction = EXCLUDED.direction, strength = EXCLUDED.strength,
         narrative = EXCLUDED.narrative, raw_evidence = EXCLUDED.raw_evidence, retrieved_at = EXCLUDED.retrieved_at`,
      [candidateId, b.blockType, HR_ENGINE_SOURCE, b.metricKey, b.metricLabel,
       b.value, b.unit, b.sampleSize, b.direction, b.strength, b.narrative, JSON.stringify(b.rawEvidence)],
    );
  }
}

// ── Main engine entry point ───────────────────────────────────────────────────

async function reconcileSlateCandidates(
  executor: Queryable,
  slateDate: string,
  candidates: HRCandidate[],
): Promise<number> {
  if (candidates.length === 0) {
    const result = await executor.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM market_research_candidates
         WHERE slate_date = $1 AND market = 'HOME_RUN'
         RETURNING 1
       ) SELECT count(*)::text FROM deleted`,
      [slateDate],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  const playerIds = candidates.map((c) => c.playerId);
  const gamePks   = candidates.map((c) => c.gamePk);

  const result = await executor.query<{ count: string }>(
    `WITH eligible AS (
       SELECT unnest($2::integer[]) AS player_id,
              unnest($3::bigint[])  AS game_pk
     ),
     deleted AS (
       DELETE FROM market_research_candidates mrc
       WHERE mrc.slate_date = $1 AND mrc.market = 'HOME_RUN'
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

export async function runHREngine(slateDate: string): Promise<HREngineResult> {
  const started = Date.now();
  const notes: string[] = [];
  // Hoisted so the catch block can mark the run FAILED if it was created
  let ingestRunId: string | null = null;

  try {
    await ensureHREngineSource();

    const games = await getSlateGames(slateDate);
    if (games.length === 0) {
      const staleRemoved = await reconcileSlateCandidates(pool, slateDate, []);
      const noGamesNote = staleRemoved > 0
        ? `No games on this date; ${staleRemoved} stale HR candidate(s) from a prior run have been cleared.`
        : "No games found for this date; HR board is empty.";
      return {
        market: "HR", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
        blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
        processingMs: Date.now() - started, notes: [noGamesNote], error: null,
      };
    }

    const gamePks = games.map((g) => g.gamePk);
    const { players: lineupPlayers, resolved: resolvedLineups } = await querySlateLineupPlayers(gamePks);

    if (lineupPlayers.length === 0) {
      notes.push("No lineup entries found. HR candidates require lineup data.");
    }
    if (resolvedLineups.conflicts.length > 0) {
      notes.push(
        `${resolvedLineups.conflicts.length} lineup source conflict(s) recorded; affected candidates carry a blocking evidence gap.`,
      );
    }

    // Create ingest run — hoisted ID is visible to catch block for FAILED marking
    const runResult = await pool.query<{ ingest_run_id: string }>(
      `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
       VALUES ($1, 'hr_engine_research', 'RUNNING', $2) RETURNING ingest_run_id`,
      [HR_ENGINE_SOURCE, slateDate],
    );
    ingestRunId = runResult.rows[0].ingest_run_id;

    // Per-game caches to avoid redundant DB queries
    const starterCache = new Map<string, StarterInfo>();
    const hitterCache  = new Map<number, FeatureMap>();
    const pitcherCache = new Map<number, FeatureMap>();
    const parkCache    = new Map<number, FeatureMap>();
    const bullpenCache = new Map<string, BullpenHRSummary>();
    // One query for the whole slate rather than one per candidate.
    const slateWeather = await getSlateWeather(slateDate);

    const candidates: HRCandidate[] = [];

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
        bullpenCache.set(bullpenKey, await getBullpenHRSummary(player.oppTeamId, slateDate));
      }
      const bullpen = bullpenCache.get(bullpenKey)!;

      const missingData: string[] = [];
      if (hitterFeatures.size === 0) missingData.push("No season hitter research data");
      if (starter.playerId === null)  missingData.push("Opposing starter identity unknown");
      else if (pitcherFeatures.size === 0) missingData.push("No season pitcher research data");
      if (player.venueId === null || parkFeatures.size === 0) missingData.push("Park factors unavailable");
      // A disagreement between lineup feeds is a blocking evidence gap on this
      // candidate, not something precedence quietly resolves.
      for (const conflict of conflictsFor(resolvedLineups, player.gamePk, player.playerId)) {
        missingData.push(conflict.detail);
      }
      // Bullpen state is disclosed on the candidate's bullpen evidence block and
      // is deliberately NOT written into missing_stale_evidence.
      //
      // getMarketResearchSelectionEligibility treats any non-empty
      // missing_stale_evidence as a blocking gap, so writing bullpen state here
      // made an incomplete or stale bullpen path a hard veto on selection
      // through the back door, which is exactly the gate task 2.2 removed from
      // sideResult. Task 3.4 makes the freshness signal honest, and an honest
      // signal attached to a veto would eliminate most pairs on most slates.

      const { primary: mechanism, secondary: secondaryMechanism } = classifyMechanism(
        hitterFeatures, pitcherFeatures, parkFeatures, player.bats, starter.throws,
      );

      const hitterPA  = n(hitterFeatures, "pa");
      const pitcherBF = n(pitcherFeatures, "bf") ?? n(pitcherFeatures, "pa");

      const gameWeather = slateWeather.get(player.gamePk) ?? null;
      const counterEvidence = checkCounterEvidence(
        hitterFeatures, pitcherFeatures, parkFeatures, hitterPA, pitcherBF, gameWeather,
        player.bats, starter.throws,
      );
      const baseEvidenceScore = computeEvidenceScore(
        hitterFeatures, pitcherFeatures, parkFeatures, bullpen,
        player.battingOrder, player.bats, starter.throws, counterEvidence,
        gameWeather,
      );
      const bvp = starter.playerId === null ? null : await getBatterPitcherEvidence(player.playerId, starter.playerId, slateDate, "HR");
      const evidenceScore = baseEvidenceScore + (bvp?.rankAdjustment ?? 0);
      // The BvP adjustment can order a tie, but cannot promote or fade research state.
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

    // One transaction for the whole slate.
    //
    // These writes previously ran in a bare loop on the shared pool with the
    // reconcile after them and nothing wrapping any of it, so a failure partway
    // through left a partially populated board next to an ingest run marked
    // FAILED, and the next reader saw a board that looked real and was not.
    let candidatesWritten = 0;
    let staleRemoved = 0;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const c of candidates) {
        await writeCandidate(client, c, ingestRunId);
        candidatesWritten++;
      }
      // After the writes, so current candidates are protected from deletion,
      // and inside the transaction, so a failure rolls the removal back too.
      staleRemoved = await reconcileSlateCandidates(client, slateDate, candidates);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (staleRemoved > 0) {
      notes.push(`Reconciliation removed ${staleRemoved} stale HR candidate(s) from this slate.`);
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
       JSON.stringify({ market: "HR", slateDate, games: games.length, staleRemoved, ...counts })],
    );

    return {
      market: "HR", slateDate, gamesProcessed: games.length,
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
      market: "HR", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
      blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
      processingMs: Date.now() - started, notes, error,
    };
  }
}
