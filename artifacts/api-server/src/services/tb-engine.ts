/**
 * Phase 3A – Total Bases Research Engine
 *
 * Identifies candidate hitters via CONTACT_VOLUME, POWER_ROUTE, and MULTI_PATH
 * mechanisms. Evaluates opportunity, pitcher matchup, bullpen path, and park
 * context, then writes structured research candidates into the shared Phase 3
 * contract tables.
 *
 * RANK, DON'T GATE contract:
 *   research_rank is an ordinal integer only. No state value removes a candidate
 *   from the board. Ties share the same rank value and are never collapsed.
 *   No sportsbook price, odds, EV, CLV, or implied probability is produced.
 *
 * Classification rule (documented for Phase 5 audit):
 *   POWER_ROUTE   — ≥2 of: xSLG ≥ 0.450, ISO ≥ 0.175, Barrel% ≥ 5.5, HardHit% ≥ 40
 *                   AND contact signals < 2
 *   MULTI_PATH    — power signals ≥ 2 AND contact signals ≥ 2
 *   CONTACT_VOLUME — default when neither above threshold is met
 *
 *   Power signals : xSLG ≥ 0.450 | ISO ≥ 0.175 | Barrel% ≥ 5.5 | HardHit% ≥ 40
 *   Contact signals: K% ≤ 22 | xBA ≥ 0.255 | batting order ≤ 5
 *
 * Competition ranking:
 *   Candidates sorted by evidenceScore DESC. Within a score group, alphabetical
 *   by player name as a tiebreaker for determinism. Rank jumps after a tie group
 *   (positions 1,1,3 not 1,1,2).
 */

import { pool } from "@workspace/db";
import { MARKET_TO_DB } from "./market-codes";
import { getBatterPitcherEvidence } from "./batter-pitcher-research";
import { getBullpenRolePath, type BullpenRolePath } from "./bullpen-foundation";
import { conflictsFor, querySlateLineupPlayers } from "./lineup-sources";
import {
  getSlateWeather,
  weatherAdjustment,
  type GameWeather,
} from "./weather-foundation";

// ── Source ID ─────────────────────────────────────────────────────────────────

const TB_ENGINE_SOURCE = "TB_ENGINE";
const MARKET = MARKET_TO_DB.TB;

// ── Mechanism thresholds ──────────────────────────────────────────────────────

const POWER_XSLG = 0.450;
const POWER_ISO = 0.175;
const POWER_BARREL = 5.5;
const POWER_HARDHT = 40.0;
const CONTACT_KPCT = 22.0;
const CONTACT_XBA = 0.255;
const CONTACT_ORDER = 5;

// ── Counter-evidence thresholds ───────────────────────────────────────────────

const HIGH_K_PITCHER = 26.0;
const LOW_PA_ORDER = 7;
const MIN_HITTER_PA = 50;
const MIN_PITCHER_BF = 60;
const STRONG_RELIEF_XSLG_CEILING = 0.370;

// ── Evidence score thresholds (not exposed externally) ────────────────────────

const SCORE_STRONG = 6;
const SCORE_POSITIVE = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

type N = number | null;
type FeatureMap = Map<string, N>;

export type TBMechanism = "CONTACT_VOLUME" | "POWER_ROUTE" | "MULTI_PATH";
export type TBResearchState = "STRONG" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "BLOCKED";

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
  /**
   * Fraction of the projected role path that carried an xslg_allowed research
   * row. The average is computed over whatever arms have the metric, so the
   * consumer needs the denominator to know how much of the path it describes.
   */
  metricCoverage: number;
}

interface TBCandidate {
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
  weather: GameWeather | null;
  bullpen: BullpenSummary;
  mechanism: TBMechanism;
  secondaryMechanism: TBMechanism | null;
  researchState: TBResearchState;
  counterEvidence: string[];
  evidenceScore: number;
  researchRank: number | null;
  missingData: string[];
}

export interface TBEngineResult {
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
 * Composite total-bases park factor.
 *
 * buildParkEvidence carried the note "Park factors are context only, not used
 * to gate or boost rank directly" and computeEvidenceScore read no park feature
 * at all, so Coors Field and Oracle Park ranked identically for an otherwise
 * identical hitter and matchup. The park research tables, the ingestion and the
 * per-side splits were all built and then not used.
 *
 * The raw HR factor is the wrong input on its own. A total-bases outcome is a
 * weighted mix of singles, doubles and home runs, so an HR-only factor
 * materially misprices a park whose doubles factor diverges from its HR factor,
 * which is precisely the interesting case.
 *
 * The weights approximate each component's share of total bases in a
 * league-average run environment: singles are the largest share of hits but
 * contribute one base each, doubles contribute two, home runs four. hits_factor
 * stands in for the contact component because the park research tables publish
 * no singles-only factor.
 */
export const TB_PARK_FACTOR_WEIGHTS = {
  hits: 0.40,
  doubles: 0.25,
  homeRuns: 0.35,
} as const;

/** Park factors are published on a 100 = neutral scale. */
const PARK_NEUTRAL = 100;

/**
 * Points of evidence score per 10 percent of park effect, and the hard cap.
 *
 * Park is a real effect but a second-order one. The cap is strictly below the
 * pitcher matchup term's maximum of 3 points, so the park can never outweigh
 * the starting pitcher.
 */
const PARK_SENSITIVITY = 1.0;
export const PARK_MAX_ADJUSTMENT = 2.0;

/**
 * Composite factors beyond these are structural, not a nudge.
 *
 * The composite total-bases factor spans a much narrower range than the HR
 * factor does, because singles and doubles vary far less across parks than home
 * runs do. Roughly 92 to 116 covers the league, so these thresholds pick out the
 * genuine outliers at each end rather than relabelling every hitter-friendly or
 * pitcher-friendly park as structural.
 */
export const PARK_EXTREME_HIGH = 115;
export const PARK_EXTREME_LOW = 92;

/**
 * Resolves a park metric, preferring the batter-side split.
 *
 * getParkFeatures already retrieves batter_side keyed rows and the code then
 * read only the unsplit key.
 */
function resolveParkMetric(map: FeatureMap, metricKey: string, batterSide: string | null): N {
  const split = batterSide ? n(map, `${metricKey}:${batterSide}`) : null;
  return split ?? n(map, metricKey);
}

export type ParkContext = {
  composite: N;
  hitsFactor: N;
  doublesFactor: N;
  hrFactor: N;
  usedBatterSideSplit: boolean;
  adjustment: number;
  environment: "EXTREME_HITTER_PARK" | "SUPPRESSIVE_PARK" | "NEUTRAL" | "UNKNOWN";
};

export function computeParkContext(park: FeatureMap, batterSide: string | null): ParkContext {
  const hitsFactor = resolveParkMetric(park, "hits_factor", batterSide);
  const doublesFactor = resolveParkMetric(park, "doubles_factor", batterSide);
  const hrFactor = resolveParkMetric(park, "hr_factor", batterSide);

  // Renormalise over whichever components are present so a missing factor does
  // not silently pull the composite toward zero.
  const components: Array<[N, number]> = [
    [hitsFactor, TB_PARK_FACTOR_WEIGHTS.hits],
    [doublesFactor, TB_PARK_FACTOR_WEIGHTS.doubles],
    [hrFactor, TB_PARK_FACTOR_WEIGHTS.homeRuns],
  ];
  let weighted = 0;
  let weight = 0;
  for (const [value, componentWeight] of components) {
    if (value === null) continue;
    weighted += value * componentWeight;
    weight += componentWeight;
  }
  const composite = weight > 0 ? weighted / weight : null;
  const usedBatterSideSplit = Boolean(batterSide) && [
    "hits_factor", "doubles_factor", "hr_factor",
  ].some((key) => n(park, `${key}:${batterSide}`) !== null);

  if (composite === null) {
    return {
      composite: null, hitsFactor, doublesFactor, hrFactor, usedBatterSideSplit,
      adjustment: 0, environment: "UNKNOWN",
    };
  }
  const raw = ((composite - PARK_NEUTRAL) / 10) * PARK_SENSITIVITY;
  const adjustment = Math.max(-PARK_MAX_ADJUSTMENT, Math.min(PARK_MAX_ADJUSTMENT, raw));
  const environment = composite >= PARK_EXTREME_HIGH
    ? "EXTREME_HITTER_PARK"
    : composite <= PARK_EXTREME_LOW
      ? "SUPPRESSIVE_PARK"
      : "NEUTRAL";
  return {
    composite: Number(composite.toFixed(4)),
    hitsFactor, doublesFactor, hrFactor, usedBatterSideSplit,
    adjustment: Number(adjustment.toFixed(4)),
    environment,
  };
}

/**
 * Expected plate appearances by lineup slot.
 *
 * A HEURISTIC, not a fitted quantity. Real expected plate appearance by lineup
 * slot is close to linear and well measured; the four-bucket step function this
 * replaces threw away most of that resolution.
 *
 * Known limitation, deliberately not modelled here: team run environment shifts
 * the whole curve, and once the modelling layer works this term is a candidate
 * to be learned rather than hand-specified.
 */
export const EXPECTED_PLATE_APPEARANCES_BY_SLOT: readonly number[] = [
  4.65, 4.55, 4.44, 4.34, 4.23, 4.13, 4.02, 3.92, 3.81,
];
export const EXPECTED_PA_IS_HEURISTIC = true;

export function expectedPlateAppearances(battingOrder: number | null): N {
  if (battingOrder === null) return null;
  const index = Math.round(battingOrder) - 1;
  if (index < 0 || index >= EXPECTED_PLATE_APPEARANCES_BY_SLOT.length) return null;
  return EXPECTED_PLATE_APPEARANCES_BY_SLOT[index];
}

/**
 * Scores opportunity on the continuous expected plate appearance value.
 *
 * Calibrated to reproduce the old endpoints exactly, +3 for the leadoff slot
 * and -1 for the ninth, so the change is a gain in resolution between them
 * rather than a change in overall weight.
 */
const PA_AT_LOWEST_SLOT = EXPECTED_PLATE_APPEARANCES_BY_SLOT[8];
const PA_AT_HIGHEST_SLOT = EXPECTED_PLATE_APPEARANCES_BY_SLOT[0];
const OPPORTUNITY_SPAN = 4;

export function opportunityScore(battingOrder: number | null): number {
  const expected = expectedPlateAppearances(battingOrder);
  if (expected === null) return 0;
  const slope = OPPORTUNITY_SPAN / (PA_AT_HIGHEST_SLOT - PA_AT_LOWEST_SLOT);
  return Number(((expected - PA_AT_LOWEST_SLOT) * slope - 1).toFixed(4));
}

/**
 * Metrics deliberately read unsplit, each with its reason.
 *
 * Anything not listed here resolves split-first with an unsplit fallback. Put
 * a metric in one of these maps only with a stated justification: an
 * unexplained unsplit read is how the same metric came to be resolved two
 * different ways in this file.
 */
export const UNSPLIT_HITTER_METRICS = new Map<string, string>([
  ["pa", "Season plate appearance count used as a sample denominator, not a rate."],
]);

export const UNSPLIT_PITCHER_METRICS = new Map<string, string>([
  ["bf", "Season batters-faced count used as a sample denominator, not a rate."],
  ["pa", "Season plate appearance count used as a sample denominator, not a rate."],
]);

/**
 * The single hitter metric resolver.
 *
 * classifyMechanism read n(hitter, hk('iso', side)) ?? n(hitter, 'iso') while
 * computeEvidenceScore read n(hitter, 'iso') with no split fallback, so the
 * same player in the same pass could be classified POWER_ROUTE on his platoon
 * split iso and then scored on his unsplit season iso. Every hitter metric
 * read in this file now goes through here.
 *
 * splitOnly is for the reads that genuinely want the split value and nothing
 * else, such as the "vs this pitcher hand" evidence fields, where falling back
 * to the season line would mislabel the number.
 */
export function resolveHitterMetric(
  map: FeatureMap,
  metricKey: string,
  pitcherHand: string | null,
  options: { splitOnly?: boolean } = {},
): N {
  if (UNSPLIT_HITTER_METRICS.has(metricKey)) return n(map, metricKey);
  const split = n(map, hk(metricKey, pitcherHand));
  if (options.splitOnly) return pitcherHand ? split : null;
  return split ?? n(map, metricKey);
}

/**
 * An explicitly unsplit read, for the evidence fields that are labelled
 * "season" and must show the season line rather than a platoon split. Named so
 * that an unsplit read is always a deliberate choice with a visible reason,
 * never an omission.
 */
function seasonHitterMetric(map: FeatureMap, metricKey: string): N {
  return n(map, metricKey);
}

/** The single pitcher metric resolver. Same rule, keyed by batter side. */
export function resolvePitcherMetric(
  map: FeatureMap,
  metricKey: string,
  batterSide: string | null,
  options: { splitOnly?: boolean } = {},
): N {
  if (UNSPLIT_PITCHER_METRICS.has(metricKey)) return n(map, metricKey);
  const split = n(map, pk(metricKey, batterSide));
  if (options.splitOnly) return batterSide ? split : null;
  return split ?? n(map, metricKey);
}

/**
 * Resolve the effective batter side for a given batter's handedness and the
 * pitcher's throwing arm. Switch hitters bat opposite the pitcher.
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
 * Switch hitters have no platoon risk.
 */
function isPlatoonDisfavored(bats: string | null, pitcherThrows: string | null): boolean {
  if (!bats || !pitcherThrows || bats === "S") return false;
  return bats === pitcherThrows;
}

// ── Feature extraction ────────────────────────────────────────────────────────

async function ensureTBEngineSource() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, notes)
     VALUES ($1, 'Total Bases Research Engine (Phase 3A)', 'RESEARCH',
             'Ordinal evidence-based ranking engine for TOTAL_BASES_2_PLUS market. ' ||
             'Writes to market_research_candidates. No odds, EV, or CLV produced.')
     ON CONFLICT (source_id) DO NOTHING`,
    [TB_ENGINE_SOURCE],
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

async function getBullpenSummary(teamId: number, slateDate: string): Promise<BullpenSummary> {
  const path = await getBullpenRolePath(teamId, slateDate);
  if (path.status !== "CURRENT") {
    return {
      ...path,
      availableHighLeverage: path.rolePath.length,
      avgXSLGAllowed: null,
      metricArmCount: 0,
      metricCoverage: 0,
    };
  }
  const armIds = path.armIds;

  let avgXSLGAllowed: N = null;
  let metricArmCount = 0;
  if (armIds.length > 0) {
    // Aggregate only the current projected 7th/8th/9th role path, never the
    // whole bullpen room. Historical reliever snapshots remain excluded.
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
    // Average over the arms that actually have the metric, and report the
    // denominator alongside it. Requiring metricArmCount to equal armIds.length
    // meant one arm missing an xslg_allowed research row discarded the other
    // two, which is a third-order gap deleting second-order evidence.
    avgXSLGAllowed = metricArmCount > 0 && xslg.rows[0]?.avg_xslg != null
      ? Number(xslg.rows[0].avg_xslg)
      : null;
  }
  return {
    ...path,
    availableHighLeverage: path.rolePath.length,
    avgXSLGAllowed,
    metricArmCount,
    /** Fraction of the projected role path that carried the metric. */
    metricCoverage: armIds.length ? metricArmCount / armIds.length : 0,
  };
}

// ── Classification logic ──────────────────────────────────────────────────────

function classifyMechanism(
  hitter: FeatureMap,
  battingOrder: number | null,
  bats: string | null,
  pitcherThrows: string | null,
): { primary: TBMechanism; secondary: TBMechanism | null } {
  const side = resolveBatterSide(bats, pitcherThrows);
  const xslg = resolveHitterMetric(hitter, "xslg", side);
  const iso = resolveHitterMetric(hitter, "iso", side);
  const barrel = resolveHitterMetric(hitter, "barrel_percent", side);
  const hardHit = resolveHitterMetric(hitter, "hard_hit_percent", side);
  const kPct = resolveHitterMetric(hitter, "k_percent", side);
  const xba = resolveHitterMetric(hitter, "xba", side);

  let powerSignals = 0;
  if (xslg !== null && xslg >= POWER_XSLG) powerSignals++;
  if (iso !== null && iso >= POWER_ISO) powerSignals++;
  if (barrel !== null && barrel >= POWER_BARREL) powerSignals++;
  if (hardHit !== null && hardHit >= POWER_HARDHT) powerSignals++;

  let contactSignals = 0;
  if (kPct !== null && kPct <= CONTACT_KPCT) contactSignals++;
  if (xba !== null && xba >= CONTACT_XBA) contactSignals++;
  if (battingOrder !== null && battingOrder <= CONTACT_ORDER) contactSignals++;

  if (powerSignals >= 2 && contactSignals >= 2) return { primary: "MULTI_PATH", secondary: null };
  if (powerSignals >= 2) return { primary: "POWER_ROUTE", secondary: contactSignals >= 1 ? "CONTACT_VOLUME" : null };
  return { primary: "CONTACT_VOLUME", secondary: powerSignals >= 1 ? "POWER_ROUTE" : null };
}

function checkCounterEvidence(
  hitter: FeatureMap,
  pitcher: FeatureMap,
  bullpen: BullpenSummary,
  battingOrder: number | null,
  bats: string | null,
  pitcherThrows: string | null,
  hitterPA: N,
  pitcherBF: N,
  weather: GameWeather | null = null,
): string[] {
  const counters: string[] = [];
  const effectiveBatterSide = resolveBatterSide(bats, pitcherThrows);

  // Pitcher K-rate counter
  const pitcherK = resolvePitcherMetric(pitcher, "k_percent", effectiveBatterSide);
  if (pitcherK !== null && pitcherK >= HIGH_K_PITCHER) counters.push("HIGH_PITCHER_K_RATE");

  // Low-PA batting slot
  if (battingOrder !== null && battingOrder >= LOW_PA_ORDER) counters.push("LOW_PA_SLOT");

  // Platoon risk
  if (isPlatoonDisfavored(bats, pitcherThrows)) counters.push("PLATOON_RISK");

  // Strong available relief path
  if (
    bullpen.availableHighLeverage > 0 &&
    bullpen.avgXSLGAllowed !== null &&
    bullpen.avgXSLGAllowed < STRONG_RELIEF_XSLG_CEILING
  ) {
    counters.push("STRONG_RELIEF_PATH");
  }

  // Weather extremes. Encoded as flags rather than score nudges because their
  // effect is not linear: a 15 mph wind blowing in does not suppress total
  // bases three times as much as a 5 mph wind blowing in.
  counters.push(...weatherAdjustment("TB", weather).flags);

  // Insufficient sample
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
  park: FeatureMap = new Map(),
  weather: GameWeather | null = null,
): number {
  const side = resolveBatterSide(bats, pitcherThrows);
  const effectiveBatterSide = side;

  const xslg = resolveHitterMetric(hitter, "xslg", side);
  const iso = resolveHitterMetric(hitter, "iso", side);
  const barrel = resolveHitterMetric(hitter, "barrel_percent", side);
  const pitcherXSLGAllowed = resolvePitcherMetric(pitcher, "xslg_allowed", effectiveBatterSide);

  let score = 0;

  // Opportunity, scored on the continuous expected plate appearance value
  // rather than a four-bucket step function on batting order.
  score += opportunityScore(battingOrder);

  // Hitter xSLG
  if (xslg !== null) {
    if (xslg >= 0.520) score += 4;
    else if (xslg >= 0.470) score += 3;
    else if (xslg >= 0.420) score += 2;
    else if (xslg >= 0.380) score += 1;
  }

  // Pitcher xSLG allowed
  if (pitcherXSLGAllowed !== null) {
    if (pitcherXSLGAllowed >= 0.480) score += 3;
    else if (pitcherXSLGAllowed >= 0.430) score += 2;
    else if (pitcherXSLGAllowed >= 0.390) score += 1;
    else if (pitcherXSLGAllowed < 0.350) score -= 1;
  }

  // Power quality bonuses
  if (barrel !== null && barrel >= 8.0) score += 1;
  if (iso !== null && iso >= 0.200) score += 1;

  // Park, as a bounded second-order adjustment. Capped strictly below the
  // pitcher matchup term's maximum of 3, so the venue can never outweigh the
  // starting pitcher.
  score += computeParkContext(park, side).adjustment;

  // Weather, as a bounded second-order adjustment with market-specific
  // coefficients. A closed roof contributes exactly zero and is distinguishable
  // in the evidence from weather that is simply missing.
  score += weatherAdjustment("TB", weather).adjustment;

  // Counter-evidence penalties
  for (const c of counterEvidence) {
    if (c === "HIGH_PITCHER_K_RATE") score -= 1.5;
    else if (c === "LOW_PA_SLOT") score -= 1.5;
    else if (c === "PLATOON_RISK") score -= 1.0;
    else if (c === "STRONG_RELIEF_PATH") score -= 0.5;
    else if (c === "EXTREME_COLD") score -= 1.0;
    else if (c === "STRONG_WIND_IN") score -= 1.0;
    else if (c === "STRONG_WIND_OUT") score += 1.0;
    // INSUFFICIENT_SAMPLE: noted but no score penalty (data quality, not opponent quality)
  }

  return score;
}

function assignResearchState(
  hasStarterIdentity: boolean,
  _hasBattingOrder: boolean,
  evidenceScore: number,
): TBResearchState {
  // BLOCKED: no starter identity — cannot assess the matchup that drives TB market
  if (!hasStarterIdentity) return "BLOCKED";
  if (evidenceScore >= SCORE_STRONG) return "STRONG";
  if (evidenceScore >= SCORE_POSITIVE) return "POSITIVE";
  if (evidenceScore >= 0) return "NEUTRAL";
  return "NEGATIVE";
}

/**
 * Competition ranking: sorted by evidenceScore DESC, tiebreaker = player name ASC.
 * Ties share the same rank; the rank after a k-way tie skips k−1 positions.
 * Mutates researchRank in place on each element.
 */
function assignCompetitionRanks(candidates: TBCandidate[]): void {
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

function buildOpportunityEvidence(c: TBCandidate): object {
  const expectedPA = expectedPlateAppearances(c.battingOrder);
  return {
    battingOrder: c.battingOrder,
    lineupState: c.lineupState,
    // The actual figure, not only the label. The label is retained because
    // consumers read it, but it is now derived from the number rather than
    // being the only thing the engine knows.
    expectedPlateAppearances: expectedPA,
    expectedPlateAppearancesBasis: "HEURISTIC",
    expectedPlateAppearancesNote:
      "Hand-specified expected plate appearances by lineup slot. A heuristic, not a fitted "
      + "quantity, and it does not yet account for team run environment.",
    paOpportunity: c.battingOrder === null ? "UNKNOWN"
      : c.battingOrder <= 2 ? "HIGH"
        : c.battingOrder <= 4 ? "ABOVE_AVERAGE"
          : c.battingOrder <= 6 ? "AVERAGE" : "LOW",
    seasonPA: seasonHitterMetric(c.hitterFeatures, "pa"),
  };
}

function buildStarterMatchupEvidence(c: TBCandidate): object {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  return {
    starterIdentityKnown: c.starterPlayerId !== null,
    starterPlayerId: c.starterPlayerId,
    starterState: c.starterState,
    starterThrows: c.starterThrows,
    hitterBats: c.hitterBats,
    effectivePlatoonSide: side,
    platoonDisfavored: isPlatoonDisfavored(c.hitterBats, c.starterThrows),
    pitcherXSLGAllowed: resolvePitcherMetric(c.pitcherFeatures, "xslg_allowed", side),
    pitcherKPct: resolvePitcherMetric(c.pitcherFeatures, "k_percent", side),
    pitcherHardHitPct: resolvePitcherMetric(c.pitcherFeatures, "hard_hit_percent", side),
    hitterXSLGvsPitcherHand: resolveHitterMetric(c.hitterFeatures, "xslg", side, { splitOnly: true }),
    hitterSLGvsPitcherHand: resolveHitterMetric(c.hitterFeatures, "slg", side, { splitOnly: true }),
  };
}

function buildBullpenPathEvidence(c: TBCandidate): object {
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
    // The denominator behind rolePathAvgXSLGAllowed. The average is taken over
    // the arms that have the metric, so the consumer is told how much of the
    // projected path it actually describes.
    metricCoverage: Number(c.bullpen.metricCoverage.toFixed(4)),
    rolePathAvgXSLGAllowed: c.bullpen.avgXSLGAllowed,
    reliefPathFavorable: c.bullpen.avgXSLGAllowed !== null && c.bullpen.avgXSLGAllowed >= STRONG_RELIEF_XSLG_CEILING,
    note: c.bullpen.reason,
  };
}

function buildParkEvidence(c: TBCandidate): object {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  const context = computeParkContext(c.parkFeatures, side);
  return {
    compositeTotalBasesFactor: context.composite,
    compositeWeights: TB_PARK_FACTOR_WEIGHTS,
    hitsFactor: context.hitsFactor,
    doublesFactor: context.doublesFactor,
    hrFactor: context.hrFactor,
    batterSide: side,
    usedBatterSideSplit: context.usedBatterSideSplit,
    rankAdjustment: context.adjustment,
    maxRankAdjustment: PARK_MAX_ADJUSTMENT,
    environment: context.environment,
    note: context.environment === "EXTREME_HITTER_PARK"
      ? `Structural hitter park: composite total-bases factor ${context.composite}. `
        + "This is an environment override, not a nudge."
      : context.environment === "SUPPRESSIVE_PARK"
        ? `Structural suppressive park: composite total-bases factor ${context.composite}. `
          + "This is an environment override, not a nudge."
        : "Park is a bounded ranking input: a composite total-bases factor "
          + `worth at most ${PARK_MAX_ADJUSTMENT} points, which cannot outweigh the starting pitcher term.`,
  };
}

function buildRecentVsSeasonVsCareer(c: TBCandidate): object {
  return {
    seasonSLG: seasonHitterMetric(c.hitterFeatures, "slg"),
    seasonXSLG: seasonHitterMetric(c.hitterFeatures, "xslg"),
    seasonISO: seasonHitterMetric(c.hitterFeatures, "iso"),
    seasonXBA: seasonHitterMetric(c.hitterFeatures, "xba"),
    seasonKPct: seasonHitterMetric(c.hitterFeatures, "k_percent"),
    seasonHardHitPct: seasonHitterMetric(c.hitterFeatures, "hard_hit_percent"),
    seasonBarrelPct: seasonHitterMetric(c.hitterFeatures, "barrel_percent"),
    seasonPA: seasonHitterMetric(c.hitterFeatures, "pa"),
    window: "SEASON",
  };
}

function buildCounterEvidenceJson(c: TBCandidate): object {
  return {
    flags: c.counterEvidence,
    count: c.counterEvidence.length,
    details: {
      highPitcherKRate: c.counterEvidence.includes("HIGH_PITCHER_K_RATE") ? `Pitcher K% ≥ ${HIGH_K_PITCHER}%` : null,
      lowPaSlot: c.counterEvidence.includes("LOW_PA_SLOT") ? `Batting order ≥ ${LOW_PA_ORDER}` : null,
      platoonRisk: c.counterEvidence.includes("PLATOON_RISK") ? `Same-side platoon disadvantage (${c.hitterBats} vs ${c.starterThrows})` : null,
      strongReliefPath: c.counterEvidence.includes("STRONG_RELIEF_PATH") ? `High-leverage arms available with avg xSLG allowed < ${STRONG_RELIEF_XSLG_CEILING}` : null,
      insufficientSample: c.counterEvidence.includes("INSUFFICIENT_SAMPLE") ? `Hitter PA < ${MIN_HITTER_PA} or pitcher BF < ${MIN_PITCHER_BF}` : null,
    },
  };
}

// ── DB write ──────────────────────────────────────────────────────────────────

/**
 * Anything that can run a query: the shared pool, or a client inside a
 * transaction. Every write in this engine takes one so the whole slate can be
 * written atomically.
 */
type Queryable = Pick<typeof pool, "query">;

const RANK_SEMANTICS =
  "RANK_DONT_GATE: ordinal rank with transparent feature evidence; ties surfaced not collapsed; no threshold or gate implied";

const CANDIDATE_COLUMNS = 17;
const CANDIDATE_CHUNK_ROWS = 200;

function candidateValues(c: TBCandidate, ingestRunId: string) {
  return [
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
    RANK_SEMANTICS,
    ingestRunId,
  ];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * Upserts every candidate for the slate.
 *
 * Previously this was one INSERT per candidate plus roughly six evidence-block
 * inserts per candidate, all issued sequentially on the shared pool. A ten-game
 * slate is about 180 players and cost over a thousand sequential round trips,
 * and a slow refresh that runs close to first pitch is a refresh that misses
 * the freeze window.
 */
export async function writeCandidates(
  executor: Queryable,
  candidates: TBCandidate[],
  ingestRunId: string,
): Promise<Map<string, string>> {
  const candidateIds = new Map<string, string>();
  if (!candidates.length) return candidateIds;

  for (const batch of chunk(candidates, CANDIDATE_CHUNK_ROWS)) {
    const values: unknown[] = [];
    const rowPlaceholders = batch.map((c, rowIndex) => {
      values.push(...candidateValues(c, ingestRunId));
      const base = rowIndex * CANDIDATE_COLUMNS;
      return `(${Array.from({ length: CANDIDATE_COLUMNS }, (_, column) => `$${base + column + 1}`).join(",")})`;
    });
    const result = await executor.query<{ candidate_id: string; player_id: number; game_pk: string }>(
      `INSERT INTO market_research_candidates
         (slate_date, game_pk, player_id, market, research_rank, research_state,
          primary_mechanism, secondary_mechanism,
          opportunity_evidence, starter_matchup_evidence, bullpen_path_evidence,
          park_evidence, recent_vs_season_vs_career, counter_evidence,
          missing_stale_evidence, rank_semantics, ingest_run_id)
       VALUES ${rowPlaceholders.join(",")}
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
       RETURNING candidate_id, player_id, game_pk::text AS game_pk`,
      values,
    );
    for (const row of result.rows) {
      candidateIds.set(`${row.player_id}:${Number(row.game_pk)}`, row.candidate_id);
    }
  }
  return candidateIds;
}

type EvidenceBlock = {
  blockType: string; metricKey: string; metricLabel: string;
  value: N; unit: string | null; sampleSize: N;
  direction: string; strength: string; narrative: string; rawEvidence: object;
};

/** Builds the evidence blocks for one candidate. Pure: it writes nothing. */
export function buildEvidenceBlocks(c: TBCandidate): EvidenceBlock[] {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  const pitcherXSLGAllowed = resolvePitcherMetric(c.pitcherFeatures, "xslg_allowed", side);
  const hitterXSLG = resolveHitterMetric(c.hitterFeatures, "xslg", side);

  const blocks: EvidenceBlock[] = [
    {
      blockType: "OPPORTUNITY", metricKey: "batting_order", metricLabel: "Batting order slot",
      value: c.battingOrder, unit: "slot", sampleSize: null,
      direction: c.battingOrder === null ? "UNKNOWN" : c.battingOrder <= 4 ? "FAVORABLE" : c.battingOrder <= 6 ? "NEUTRAL" : "UNFAVORABLE",
      strength: c.battingOrder === null ? "UNKNOWN" : c.battingOrder <= 2 ? "STRONG" : c.battingOrder <= 4 ? "MODERATE" : "WEAK",
      narrative: `Batting ${c.battingOrder ?? "unknown"} in lineup (${c.lineupState} source). Lower order = more PA opportunity.`,
      rawEvidence: buildOpportunityEvidence(c),
    },
    {
      blockType: "STARTER_MATCHUP", metricKey: "pitcher_xslg_allowed", metricLabel: "Pitcher xSLG allowed",
      value: pitcherXSLGAllowed, unit: "rate", sampleSize: null,
      direction: pitcherXSLGAllowed === null ? "UNKNOWN" : pitcherXSLGAllowed >= 0.430 ? "FAVORABLE" : pitcherXSLGAllowed >= 0.380 ? "NEUTRAL" : "UNFAVORABLE",
      strength: pitcherXSLGAllowed === null ? "UNKNOWN" : pitcherXSLGAllowed >= 0.480 ? "STRONG" : pitcherXSLGAllowed >= 0.430 ? "MODERATE" : "WEAK",
      narrative: `Pitcher xSLG allowed season avg${side ? ` vs ${side}HB` : ""}. Higher = more total-base opportunity.`,
      rawEvidence: buildStarterMatchupEvidence(c),
    },
    {
      blockType: "RECENT_VS_SEASON_VS_CAREER", metricKey: "season_xslg", metricLabel: "Season xSLG",
      value: hitterXSLG, unit: "rate", sampleSize: seasonHitterMetric(c.hitterFeatures, "pa"),
      direction: hitterXSLG === null ? "UNKNOWN" : hitterXSLG >= 0.450 ? "FAVORABLE" : hitterXSLG >= 0.380 ? "NEUTRAL" : "UNFAVORABLE",
      strength: hitterXSLG === null ? "UNKNOWN" : hitterXSLG >= 0.500 ? "STRONG" : hitterXSLG >= 0.430 ? "MODERATE" : "WEAK",
      narrative: "Hitter expected SLG (season). Derived from Statcast exit velocity and launch angle.",
      rawEvidence: buildRecentVsSeasonVsCareer(c),
    },
    {
      blockType: "BULLPEN_PATH", metricKey: "bullpen_path_summary", metricLabel: "Bullpen path summary",
      value: c.bullpen.avgXSLGAllowed, unit: "rate", sampleSize: c.bullpen.availableHighLeverage,
      direction: c.bullpen.avgXSLGAllowed === null ? "UNKNOWN" : c.bullpen.avgXSLGAllowed >= STRONG_RELIEF_XSLG_CEILING ? "FAVORABLE" : "UNFAVORABLE",
      strength: c.bullpen.availableHighLeverage > 0 ? "MODERATE" : "WEAK",
      narrative: c.bullpen.status === "CURRENT"
        ? `Projected 7th/8th/9th role path (${c.bullpen.rolePath.map((arm) => arm.role).join(" → ")}). Avg xSLG allowed by those arms.`
        : `Bullpen path unavailable: ${c.bullpen.reason}`,
      rawEvidence: buildBullpenPathEvidence(c),
    },
    (() => {
      const weather = weatherAdjustment("TB", c.weather);
      return {
        blockType: "PARK",
        metricKey: "weather_wind_out_component",
        metricLabel: "Wind component along centre field",
        value: c.weather?.windOutComponentMph ?? null,
        unit: "mph",
        sampleSize: null,
        direction: weather.environment === "CLOSED_ROOF"
          ? "NEUTRAL"
          : c.weather?.windOutComponentMph == null
            ? "UNKNOWN"
            : c.weather.windOutComponentMph > 0 ? "FAVORABLE" : "UNFAVORABLE",
        strength: weather.flags.length ? "STRUCTURAL_ENVIRONMENT" : "BOUNDED_RANK_INPUT",
        narrative: `${weather.detail} Worth ${weather.adjustment} rank points`
          + `${weather.flags.length ? `, plus flags ${weather.flags.join(", ")}` : ""}.`,
        rawEvidence: {
          environment: weather.environment,
          temperatureF: c.weather?.temperatureF ?? null,
          windSpeedMph: c.weather?.windSpeedMph ?? null,
          windDirectionDegrees: c.weather?.windDirectionDegrees ?? null,
          windOutComponentMph: c.weather?.windOutComponentMph ?? null,
          windComponent: c.weather?.windComponent ?? "UNKNOWN",
          roofState: c.weather?.roofState ?? "UNKNOWN",
          weatherNeutral: c.weather?.weatherNeutral ?? false,
          sourceFreshness: c.weather?.sourceFreshness ?? null,
          retrievedAt: c.weather?.retrievedAt ?? null,
          rankAdjustment: weather.adjustment,
          flags: weather.flags,
          note: weather.environment === "CLOSED_ROOF"
            ? "A closed roof is neutral weather, which is a different fact from missing weather."
            : weather.environment === "UNKNOWN"
              ? "No usable weather observation. This is missing weather, not neutral weather."
              : "Weather is a bounded ranking input with market-specific coefficients.",
        },
      };
    })(),
    (() => {
      const side = resolveBatterSide(c.hitterBats, c.starterThrows);
      const park = computeParkContext(c.parkFeatures, side);
      return {
        blockType: "PARK",
        metricKey: "park_total_bases_factor",
        metricLabel: "Composite total bases park factor",
        value: park.composite,
        unit: "factor",
        sampleSize: null,
        direction: park.composite === null
          ? "UNKNOWN"
          : park.composite >= 110 ? "FAVORABLE" : park.composite >= 90 ? "NEUTRAL" : "UNFAVORABLE",
        strength: park.environment === "NEUTRAL" || park.environment === "UNKNOWN"
          ? "BOUNDED_RANK_INPUT"
          : "STRUCTURAL_ENVIRONMENT",
        narrative: `Composite total bases park factor ${park.composite ?? "unavailable"}, weighted `
          + `${TB_PARK_FACTOR_WEIGHTS.hits} hits / ${TB_PARK_FACTOR_WEIGHTS.doubles} doubles / `
          + `${TB_PARK_FACTOR_WEIGHTS.homeRuns} home runs. Worth ${park.adjustment} rank points, `
          + `bounded at ${PARK_MAX_ADJUSTMENT} so it cannot outweigh the starting pitcher.`,
        rawEvidence: buildParkEvidence(c),
      };
    })(),
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

  return blocks;
}

const EVIDENCE_BLOCK_COLUMNS = 12;
const EVIDENCE_BLOCK_CHUNK_ROWS = 300;

/**
 * Writes every evidence block for the slate in as few statements as the
 * parameter limit allows, instead of roughly six sequential inserts per
 * candidate.
 *
 * Rows are deduplicated on (candidate_id, block_type, metric_key) first: a
 * multi-row ON CONFLICT DO UPDATE cannot affect the same row twice, and a
 * duplicate within one statement would abort the whole slate.
 */
export async function writeEvidenceBlocks(
  executor: Queryable,
  rows: Array<{ candidateId: string; block: EvidenceBlock }>,
): Promise<number> {
  const deduplicated = new Map<string, { candidateId: string; block: EvidenceBlock }>();
  for (const row of rows) {
    deduplicated.set(`${row.candidateId}:${row.block.blockType}:${row.block.metricKey}`, row);
  }
  const ordered = [...deduplicated.values()];
  for (const batch of chunk(ordered, EVIDENCE_BLOCK_CHUNK_ROWS)) {
    const values: unknown[] = [];
    const placeholders = batch.map(({ candidateId, block }, rowIndex) => {
      values.push(
        candidateId, block.blockType, TB_ENGINE_SOURCE, block.metricKey, block.metricLabel,
        block.value, block.unit, block.sampleSize, block.direction, block.strength,
        block.narrative, JSON.stringify(block.rawEvidence),
      );
      const base = rowIndex * EVIDENCE_BLOCK_COLUMNS;
      const columns = Array.from({ length: EVIDENCE_BLOCK_COLUMNS }, (_, column) => `$${base + column + 1}`);
      return `(${columns.join(",")},now())`;
    });
    await executor.query(
      `INSERT INTO market_research_evidence_blocks
         (candidate_id, block_type, source_id, metric_key, metric_label,
          value, unit, sample_size, direction, strength, narrative, raw_evidence, retrieved_at)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (candidate_id, block_type, metric_key) DO UPDATE SET
         value = EXCLUDED.value, direction = EXCLUDED.direction, strength = EXCLUDED.strength,
         narrative = EXCLUDED.narrative, raw_evidence = EXCLUDED.raw_evidence, retrieved_at = EXCLUDED.retrieved_at`,
      values,
    );
  }
  return ordered.length;
}

// ── Main engine entry point ───────────────────────────────────────────────────

/**
 * Reconcile the TB candidate set for a slate after a successful run.
 * Deletes any market_research_candidates rows (and their cascaded evidence blocks
 * and provenance) that belonged to a prior TB run for this slate but are NOT in
 * the current candidate set. This ensures stale candidates from removed lineup
 * entries do not persist on the market board between reruns.
 */
async function reconcileSlateCandidates(
  executor: Queryable,
  slateDate: string,
  candidates: TBCandidate[],
): Promise<number> {
  if (candidates.length === 0) {
    // No candidates this run — wipe all TB candidates for this slate
    const result = await executor.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM market_research_candidates
         WHERE slate_date = $1 AND market = 'TOTAL_BASES_2_PLUS'
         RETURNING 1
       ) SELECT count(*)::text FROM deleted`,
      [slateDate],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // Delete rows whose (player_id, game_pk) pair is not in the current candidate set.
  // Uses unnest to build the eligible set without string concatenation.
  const playerIds = candidates.map((c) => c.playerId);
  const gamePks = candidates.map((c) => c.gamePk);

  const result = await executor.query<{ count: string }>(
    `WITH eligible AS (
       SELECT unnest($2::integer[]) AS player_id,
              unnest($3::bigint[])  AS game_pk
     ),
     deleted AS (
       DELETE FROM market_research_candidates mrc
       WHERE mrc.slate_date = $1 AND mrc.market = 'TOTAL_BASES_2_PLUS'
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

export async function runTBEngine(slateDate: string): Promise<TBEngineResult> {
  const started = Date.now();
  const notes: string[] = [];
  // Hoisted so the catch block can mark the run FAILED if it was created
  let ingestRunId: string | null = null;

  try {
    await ensureTBEngineSource();

    const games = await getSlateGames(slateDate);
    if (games.length === 0) {
      // Reconcile even with zero games: a previously-run slate whose games were
      // cancelled/removed must still have its stale candidates cleared so the
      // market board does not show output from an invalid game.
      const staleRemoved = await reconcileSlateCandidates(pool, slateDate, []);
      const noGamesNote = staleRemoved > 0
        ? `No games on this date; ${staleRemoved} stale TB candidate(s) from a prior run have been cleared.`
        : "No games found for this date; TB board is empty.";
      return {
        market: "TB", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
        blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
        processingMs: Date.now() - started, notes: [noGamesNote], error: null,
      };
    }

    const gamePks = games.map((g) => g.gamePk);
    const { players: lineupPlayers, resolved: resolvedLineups } = await querySlateLineupPlayers(gamePks);

    if (lineupPlayers.length === 0) {
      notes.push("No lineup entries found. TB candidates require lineup data.");
    }
    if (resolvedLineups.conflicts.length > 0) {
      notes.push(
        `${resolvedLineups.conflicts.length} lineup source conflict(s) recorded; affected candidates carry a blocking evidence gap.`,
      );
    }

    // Create ingest run — hoisted ID is visible to catch block for FAILED marking
    const runResult = await pool.query<{ ingest_run_id: string }>(
      `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
       VALUES ($1, 'tb_engine_research', 'RUNNING', $2) RETURNING ingest_run_id`,
      [TB_ENGINE_SOURCE, slateDate],
    );
    ingestRunId = runResult.rows[0].ingest_run_id;

    // Per-game caches to avoid redundant DB queries
    const starterCache = new Map<string, StarterInfo>();
    const hitterCache = new Map<number, FeatureMap>();
    const pitcherCache = new Map<number, FeatureMap>();
    const parkCache = new Map<number, FeatureMap>();
    const bullpenCache = new Map<string, BullpenSummary>();
    const bvpCache = new Map<string, Awaited<ReturnType<typeof getBatterPitcherEvidence>>>();
    // One query for the whole slate rather than one per candidate.
    const slateWeather = await getSlateWeather(slateDate);

    const candidates: TBCandidate[] = [];

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
      const parkFeatures = player.venueId !== null ? (parkCache.get(player.venueId) ?? new Map()) : new Map<string, N>();

      const bullpenKey = `${player.oppTeamId}:${slateDate}`;
      if (!bullpenCache.has(bullpenKey)) {
        bullpenCache.set(bullpenKey, await getBullpenSummary(player.oppTeamId, slateDate));
      }
      const bullpen = bullpenCache.get(bullpenKey)!;

      const missingData: string[] = [];
      if (hitterFeatures.size === 0) missingData.push("No season hitter research data");
      if (starter.playerId === null) missingData.push("Opposing starter identity unknown");
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
        hitterFeatures, player.battingOrder, player.bats, starter.throws,
      );
      const hitterPA = resolveHitterMetric(hitterFeatures, "pa", null);
      const pitcherBF = resolvePitcherMetric(pitcherFeatures, "bf", null)
        ?? resolvePitcherMetric(pitcherFeatures, "pa", null);
      const gameWeather = slateWeather.get(player.gamePk) ?? null;
      const counterEvidence = checkCounterEvidence(
        hitterFeatures, pitcherFeatures, bullpen,
        player.battingOrder, player.bats, starter.throws,
        hitterPA, pitcherBF, gameWeather,
      );
      const baseEvidenceScore = computeEvidenceScore(
        hitterFeatures, pitcherFeatures,
        player.battingOrder, player.bats, starter.throws, counterEvidence,
        parkFeatures, gameWeather,
      );
      // Cached by (batter, starter). The same starter faces every hitter in the
      // opposing lineup, so this was one uncached lookup per candidate.
      let bvp: Awaited<ReturnType<typeof getBatterPitcherEvidence>> | null = null;
      if (starter.playerId !== null) {
        const bvpKey = `${player.playerId}:${starter.playerId}`;
        if (!bvpCache.has(bvpKey)) {
          bvpCache.set(bvpKey, await getBatterPitcherEvidence(player.playerId, starter.playerId, slateDate, "TB"));
        }
        bvp = bvpCache.get(bvpKey) ?? null;
      }
      const evidenceScore = baseEvidenceScore + (bvp?.rankAdjustment ?? 0);
      // Named matchup evidence orders otherwise-qualified candidates only; it must never
      // change the persisted research state or downstream selection eligibility.
      const researchState = assignResearchState(starter.playerId !== null, player.battingOrder !== null, baseEvidenceScore);

      candidates.push({
        playerId: player.playerId, playerName: player.playerName, gamePk: player.gamePk,
        slateDate, battingOrder: player.battingOrder, lineupState: player.lineupState,
        hitterBats: player.bats, starterPlayerId: starter.playerId,
        starterThrows: starter.throws, starterState: starter.starterState,
        hitterFeatures, pitcherFeatures, parkFeatures, bullpen,
        weather: gameWeather,
        mechanism, secondaryMechanism, researchState, counterEvidence,
        evidenceScore, researchRank: null, missingData,
      });
    }

    assignCompetitionRanks(candidates);

    // One transaction for the whole slate.
    //
    // These writes used to run in a bare loop on the shared pool with the
    // reconcile after them and nothing wrapping any of it, so a failure partway
    // through left a partially populated board alongside an ingest run marked
    // FAILED. The next reader saw a board that looked real and was not.
    // daily-market-board.ts already did this correctly; this engine did not.
    let candidatesWritten = 0;
    let evidenceBlocksWritten = 0;
    let staleRemoved = 0;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const candidateIds = await writeCandidates(client, candidates, ingestRunId);
      candidatesWritten = candidateIds.size;
      const evidenceRows = candidates.flatMap((c) => {
        const candidateId = candidateIds.get(`${c.playerId}:${c.gamePk}`);
        if (!candidateId) return [];
        return buildEvidenceBlocks(c).map((block) => ({ candidateId, block }));
      });
      evidenceBlocksWritten = await writeEvidenceBlocks(client, evidenceRows);
      // Reconcile inside the same transaction and after the writes, so current
      // candidates are protected from deletion and a failure rolls the removal
      // back with everything else.
      staleRemoved = await reconcileSlateCandidates(client, slateDate, candidates);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (staleRemoved > 0) {
      notes.push(`Reconciliation removed ${staleRemoved} stale TB candidate(s) from this slate.`);
    }
    notes.push(`Wrote ${candidatesWritten} candidate(s) and ${evidenceBlocksWritten} evidence block(s) in one transaction.`);

    const counts = {
      strong: candidates.filter((c) => c.researchState === "STRONG").length,
      positive: candidates.filter((c) => c.researchState === "POSITIVE").length,
      neutral: candidates.filter((c) => c.researchState === "NEUTRAL").length,
      negative: candidates.filter((c) => c.researchState === "NEGATIVE").length,
      blocked: candidates.filter((c) => c.researchState === "BLOCKED").length,
    };

    await pool.query(
      `UPDATE ingest_runs SET finished_at = now(), status = 'SUCCESS',
         row_count = $2, normalized_row_count = $3, metadata = $4
       WHERE ingest_run_id = $1`,
      [ingestRunId, candidates.length, candidatesWritten,
       JSON.stringify({ market: "TB", slateDate, games: games.length, staleRemoved, ...counts })],
    );

    return {
      market: "TB", slateDate, gamesProcessed: games.length,
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
      market: "TB", slateDate, gamesProcessed: 0, candidatesProcessed: 0, candidatesWritten: 0,
      blockedCandidates: 0, strongCandidates: 0, positiveCandidates: 0, neutralCandidates: 0, negativeCandidates: 0,
      processingMs: Date.now() - started, notes, error,
    };
  }
}
