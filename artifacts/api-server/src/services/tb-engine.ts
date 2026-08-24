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
import { getBatterPitcherEvidence } from "./batter-pitcher-research";
import { getBullpenRolePath, type BullpenRolePath } from "./bullpen-foundation";

// ── Source ID ─────────────────────────────────────────────────────────────────

const TB_ENGINE_SOURCE = "TB_ENGINE";
const MARKET = "TOTAL_BASES_2_PLUS";

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
): { primary: TBMechanism; secondary: TBMechanism | null } {
  const side = resolveBatterSide(bats, pitcherThrows);
  const xslg = n(hitter, hk("xslg", side)) ?? n(hitter, "xslg");
  const iso = n(hitter, hk("iso", side)) ?? n(hitter, "iso");
  const barrel = n(hitter, "barrel_percent");
  const hardHit = n(hitter, "hard_hit_percent");
  const kPct = n(hitter, hk("k_percent", side)) ?? n(hitter, "k_percent");
  const xba = n(hitter, hk("xba", side)) ?? n(hitter, "xba");

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
): string[] {
  const counters: string[] = [];
  const effectiveBatterSide = resolveBatterSide(bats, pitcherThrows);

  // Pitcher K-rate counter
  const pitcherK = n(pitcher, pk("k_percent", effectiveBatterSide)) ?? n(pitcher, "k_percent");
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
): number {
  const side = resolveBatterSide(bats, pitcherThrows);
  const effectiveBatterSide = side;

  const xslg = n(hitter, hk("xslg", side)) ?? n(hitter, "xslg");
  const iso = n(hitter, "iso");
  const barrel = n(hitter, "barrel_percent");
  const pitcherXSLGAllowed = n(pitcher, pk("xslg_allowed", effectiveBatterSide)) ?? n(pitcher, "xslg_allowed");

  let score = 0;

  // Batting order (PA opportunity)
  if (battingOrder !== null) {
    if (battingOrder <= 2) score += 3;
    else if (battingOrder <= 4) score += 2;
    else if (battingOrder <= 6) score += 1;
    else score -= 1;
  }

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

  // Counter-evidence penalties
  for (const c of counterEvidence) {
    if (c === "HIGH_PITCHER_K_RATE") score -= 1.5;
    else if (c === "LOW_PA_SLOT") score -= 1.5;
    else if (c === "PLATOON_RISK") score -= 1.0;
    else if (c === "STRONG_RELIEF_PATH") score -= 0.5;
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
    pitcherXSLGAllowed: n(c.pitcherFeatures, pk("xslg_allowed", side)) ?? n(c.pitcherFeatures, "xslg_allowed"),
    pitcherKPct: n(c.pitcherFeatures, pk("k_percent", side)) ?? n(c.pitcherFeatures, "k_percent"),
    pitcherHardHitPct: n(c.pitcherFeatures, pk("hard_hit_percent", side)) ?? n(c.pitcherFeatures, "hard_hit_percent"),
    hitterXSLGvsPitcherHand: n(c.hitterFeatures, hk("xslg", side)),
    hitterSLGvsPitcherHand: n(c.hitterFeatures, hk("slg", side)),
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
    rolePathAvgXSLGAllowed: c.bullpen.avgXSLGAllowed,
    reliefPathFavorable: c.bullpen.avgXSLGAllowed !== null && c.bullpen.avgXSLGAllowed >= STRONG_RELIEF_XSLG_CEILING,
    note: c.bullpen.reason,
  };
}

function buildParkEvidence(c: TBCandidate): object {
  return {
    hrFactor: n(c.parkFeatures, "hr_factor"),
    doublesFactor: n(c.parkFeatures, "doubles_factor"),
    note: "Park factors are context only — not used to gate or boost rank directly",
  };
}

function buildRecentVsSeasonVsCareer(c: TBCandidate): object {
  return {
    seasonSLG: n(c.hitterFeatures, "slg"),
    seasonXSLG: n(c.hitterFeatures, "xslg"),
    seasonISO: n(c.hitterFeatures, "iso"),
    seasonXBA: n(c.hitterFeatures, "xba"),
    seasonKPct: n(c.hitterFeatures, "k_percent"),
    seasonHardHitPct: n(c.hitterFeatures, "hard_hit_percent"),
    seasonBarrelPct: n(c.hitterFeatures, "barrel_percent"),
    seasonPA: n(c.hitterFeatures, "pa"),
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

async function writeCandidate(c: TBCandidate, ingestRunId: string): Promise<string> {
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
  await writeEvidenceBlocks(candidateId, c);
  return candidateId;
}

async function writeEvidenceBlocks(candidateId: string, c: TBCandidate): Promise<void> {
  const side = resolveBatterSide(c.hitterBats, c.starterThrows);
  const pitcherXSLGAllowed = n(c.pitcherFeatures, pk("xslg_allowed", side)) ?? n(c.pitcherFeatures, "xslg_allowed");
  const hitterXSLG = n(c.hitterFeatures, hk("xslg", side)) ?? n(c.hitterFeatures, "xslg");

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
      value: hitterXSLG, unit: "rate", sampleSize: n(c.hitterFeatures, "pa"),
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
    {
      blockType: "PARK", metricKey: "park_hr_factor", metricLabel: "Park HR factor",
      value: n(c.parkFeatures, "hr_factor"), unit: "factor", sampleSize: null,
      direction: (() => { const v = n(c.parkFeatures, "hr_factor"); return v === null ? "UNKNOWN" : v >= 110 ? "FAVORABLE" : v >= 90 ? "NEUTRAL" : "UNFAVORABLE"; })(),
      strength: "CONTEXT_ONLY",
      narrative: "Park HR factor (Baseball Savant Statcast). Context only — not used to gate or boost rank.",
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
      [candidateId, b.blockType, TB_ENGINE_SOURCE, b.metricKey, b.metricLabel,
       b.value, b.unit, b.sampleSize, b.direction, b.strength, b.narrative, JSON.stringify(b.rawEvidence)],
    );
  }
}

// ── Main engine entry point ───────────────────────────────────────────────────

/**
 * Reconcile the TB candidate set for a slate after a successful run.
 * Deletes any market_research_candidates rows (and their cascaded evidence blocks
 * and provenance) that belonged to a prior TB run for this slate but are NOT in
 * the current candidate set. This ensures stale candidates from removed lineup
 * entries do not persist on the market board between reruns.
 */
async function reconcileSlateCandidates(slateDate: string, candidates: TBCandidate[]): Promise<number> {
  if (candidates.length === 0) {
    // No candidates this run — wipe all TB candidates for this slate
    const result = await pool.query<{ count: string }>(
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

  const result = await pool.query<{ count: string }>(
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
      const staleRemoved = await reconcileSlateCandidates(slateDate, []);
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
    const lineupPlayers = await getSlateLineupPlayers(gamePks);

    if (lineupPlayers.length === 0) {
      notes.push("No lineup entries found. TB candidates require lineup data.");
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
      if (bullpen.status !== "CURRENT") {
        missingData.push(`Bullpen path ${bullpen.status.toLowerCase()}: ${bullpen.reason}`);
      } else if (bullpen.metricArmCount !== bullpen.armIds.length) {
        missingData.push(`Bullpen role-path xSLG research incomplete (${bullpen.metricArmCount}/${bullpen.armIds.length} arms)`);
      }

      const { primary: mechanism, secondary: secondaryMechanism } = classifyMechanism(
        hitterFeatures, player.battingOrder, player.bats, starter.throws,
      );
      const hitterPA = n(hitterFeatures, "pa");
      const pitcherBF = n(pitcherFeatures, "bf") ?? n(pitcherFeatures, "pa");
      const counterEvidence = checkCounterEvidence(
        hitterFeatures, pitcherFeatures, bullpen,
        player.battingOrder, player.bats, starter.throws,
        hitterPA, pitcherBF,
      );
      const baseEvidenceScore = computeEvidenceScore(
        hitterFeatures, pitcherFeatures,
        player.battingOrder, player.bats, starter.throws, counterEvidence,
      );
      const bvp = starter.playerId === null ? null : await getBatterPitcherEvidence(player.playerId, starter.playerId, slateDate, "TB");
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

    // Reconcile: remove TB candidates from prior runs that are no longer in this lineup.
    // Must run after writes so current candidates are protected from deletion.
    const staleRemoved = await reconcileSlateCandidates(slateDate, candidates);
    if (staleRemoved > 0) {
      notes.push(`Reconciliation removed ${staleRemoved} stale TB candidate(s) from this slate.`);
    }

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
