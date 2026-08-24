import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import {
  DB_TO_MARKET,
  MARKET_TO_DB,
  MODEL_MARKETS,
  toShortMarketOrNull,
} from "./market-codes";

const MLB_SOURCE = "MLB_OFFICIAL";
const MLB_GAME_FEED_URL = "https://statsapi.mlb.com/api/v1.1/game";
// The market vocabulary lives in market-codes.ts. It used to be a record
// literal here and a chain of ternaries in three more places in this file.
const MARKETS = MODEL_MARKETS;
const DB_MARKETS = MARKET_TO_DB;
const SHORT_MARKETS: Record<string, Market | undefined> = DB_TO_MARKET;
export const CORRECTION_REASONS = [
  "LATE_SCRATCH",
  "LINEUP_ERROR",
  "DATA_INGEST_FAILURE",
  "IDENTITY_ERROR",
  "SOURCE_UNAVAILABLE",
  "HUMAN_CORRECTION",
  // Added by remediation task 3.3. Five of the six values above were
  // unreachable because every correction was labelled DATA_INGEST_FAILURE, and
  // the two real transitions below had no value at all.
  "GAME_RESUMPTION",
  "OFFICIAL_STAT_CORRECTION",
] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

/**
 * The walk settlement definition.
 *
 * MLB's baseOnBalls includes intentional walks; intentionalWalks is exposed as
 * a separate field, and hit by pitch is a third field that baseOnBalls does not
 * include. Which of the three the operator is actually graded against at the
 * book has NOT been established, so this preserves the behaviour that was
 * already in place and labels it as an assumption rather than guessing a new
 * one. Every settled row carries the definition that produced it.
 *
 * To change the policy: flip the flags here, set assumed to false, and re-grade
 * historically. No feed re-fetch is required, because walks, intentional walks
 * and hit by pitch are each persisted separately regardless of which definition
 * is active.
 */
export const WALK_SETTLEMENT_POLICY = {
  countIntentionalWalks: true,
  countHitByPitch: false,
  assumed: true,
  statement:
    "Walks are graded as MLB baseOnBalls, which includes intentional walks and excludes hit by pitch. "
    + "This is the assumed definition, carried forward from the previous implementation, and has not been "
    + "confirmed against the operator's settlement rule.",
} as const;

export function walkDefinitionLabel(policy = WALK_SETTLEMENT_POLICY): string {
  return `BB${policy.countIntentionalWalks ? "+IBB" : "-IBB"}${policy.countHitByPitch ? "+HBP" : ""}`
    + `${policy.assumed ? " (assumed)" : ""}`;
}

type JsonObject = Record<string, unknown>;
type DbClient = Pick<typeof pool, "query">;
type Market = (typeof MARKETS)[number];
type SettlementState = "PENDING" | "SETTLED" | "POSTPONED" | "NO_ACTION" | "DISPUTED";

export class SettlementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementValidationError";
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? Math.trunc(result) : 0;
}

function date(value: unknown): string {
  const result = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new SettlementValidationError("date must use YYYY-MM-DD");
  }
  return result;
}

function gamePk(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new SettlementValidationError("gamePk must be a positive integer");
  }
  return result;
}

function checksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertNoBettingData(value: unknown, path = "metadata"): void {
  const denied = /(odds?|price|payout|sportsbook|bookmaker|implied[_ ]?probability|expected[_ ]?value|(^|[_ ])ev($|[_ ])|clv|vig|stake|wager|bet)/i;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoBettingData(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && denied.test(value)) {
      throw new SettlementValidationError(`Settlement metadata contains prohibited betting content at ${path}`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (denied.test(key)) {
      throw new SettlementValidationError(`Settlement metadata contains prohibited betting key "${key}"`);
    }
    assertNoBettingData(child, `${path}.${key}`);
  }
}

function isFinal(payload: JsonObject): boolean {
  const gameDataStatus = object(object(payload.gameData).status);
  const status = String(payload.status ?? gameDataStatus.detailedState ?? "");
  const code = String(gameDataStatus.statusCode ?? object(object(payload.liveData).boxscore).statusCode ?? "");
  return code === "F" || ["Final", "Game Over", "Completed Early"].includes(status);
}

type BattingLine = {
  playerId: number;
  fullName: string;
  singles: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  /** Total bases as the feed reported them, or null when the feed did not. */
  reportedTotalBases: number | null;
  /** MLB baseOnBalls, which includes intentional walks. */
  walks: number;
  /** Intentional walks, reported separately by the feed. */
  intentionalWalks: number;
  /** Hit by pitch. Not included in baseOnBalls. */
  hitByPitch: number;
  plateAppearances: number;
  atBats: number;
};

function battingLines(payload: JsonObject): BattingLine[] {
  const fixtureLines = Array.isArray(payload.batting) ? payload.batting.map(object) : [];
  if (fixtureLines.length) {
    return fixtureLines.flatMap((line) => {
      const playerId = gamePk(line.playerId);
      const doubles = number(line.doubles);
      const triples = number(line.triples);
      const homeRuns = number(line.homeRuns);
      const hits = number(line.hits);
      const singles = Math.max(0, hits - doubles - triples - homeRuns);
      return [{
        playerId,
        fullName: String(line.fullName ?? `MLB player ${playerId}`),
        singles,
        doubles,
        triples,
        homeRuns,
        reportedTotalBases: line.totalBases == null ? null : number(line.totalBases),
        walks: number(line.baseOnBalls ?? line.walks),
        intentionalWalks: number(line.intentionalWalks),
        hitByPitch: number(line.hitByPitch ?? line.hitBatsmen),
        plateAppearances: number(line.plateAppearances),
        atBats: number(line.atBats),
      }];
    });
  }

  const teams = object(object(object(payload.liveData).boxscore).teams);
  return ["away", "home"].flatMap((side) => {
    const players = object(object(teams[side]).players);
    return Object.values(players).flatMap((entry) => {
      const player = object(entry);
      const person = object(player.person);
      const stats = object(object(player.stats).batting);
      const playerId = Number(person.id);
      if (!Number.isSafeInteger(playerId) || playerId <= 0 || !Object.keys(stats).length) return [];
      const doubles = number(stats.doubles);
      const triples = number(stats.triples);
      const homeRuns = number(stats.homeRuns);
      const hits = number(stats.hits);
      const singles = Math.max(0, hits - doubles - triples - homeRuns);
      return [{
        playerId,
        fullName: String(person.fullName ?? `MLB player ${playerId}`),
        singles,
        doubles,
        triples,
        homeRuns,
        reportedTotalBases: stats.totalBases == null ? null : number(stats.totalBases),
        walks: number(stats.baseOnBalls),
        intentionalWalks: number(stats.intentionalWalks),
        hitByPitch: number(stats.hitByPitch),
        plateAppearances: number(stats.plateAppearances),
        atBats: number(stats.atBats),
      }];
    });
  });
}

/**
 * Grades one market from one batting line.
 *
 * Total bases are recomputed from the components AND cross-checked against the
 * value the feed reported. The reported field was previously parsed and then
 * ignored entirely, so a disagreement between the two was invisible. A
 * disagreement now returns a discrepancy, and the caller settles that outcome
 * DISPUTED rather than picking one of the two numbers and moving on.
 *
 * Walks are graded through WALK_SETTLEMENT_POLICY. The components are persisted
 * separately whatever the policy says.
 */
function outcomeFor(market: Market, line: BattingLine, policy = WALK_SETTLEMENT_POLICY) {
  const computedTotalBases = line.singles + line.doubles * 2 + line.triples * 3 + line.homeRuns * 4;
  let discrepancy: string | null = null;
  let value: number;
  if (market === "TB") {
    value = computedTotalBases;
    if (line.reportedTotalBases !== null && line.reportedTotalBases !== computedTotalBases) {
      discrepancy = `Total bases disagree for player ${line.playerId}: components give `
        + `${computedTotalBases}, the feed reported ${line.reportedTotalBases}.`;
    }
  } else if (market === "XBH") {
    value = line.doubles + line.triples + line.homeRuns;
  } else if (market === "WALK") {
    value = line.walks
      - (policy.countIntentionalWalks ? 0 : line.intentionalWalks)
      + (policy.countHitByPitch ? line.hitByPitch : 0);
    value = Math.max(0, value);
  } else {
    value = line.homeRuns;
  }
  return { value, hit: market === "TB" ? value >= 2 : value >= 1, discrepancy };
}

async function startSettlementRun(effectiveDate: string) {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, base_url, notes)
     VALUES ($1, 'MLB Official', 'OFFICIAL', 'https://statsapi.mlb.com',
             'Official source for postgame settlement only')
     ON CONFLICT (source_id) DO NOTHING`,
    [MLB_SOURCE],
  );
  const result = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ($1, 'mlb-official-settlement', 'RUNNING', $2)
     RETURNING ingest_run_id`,
    [MLB_SOURCE, effectiveDate],
  );
  return result.rows[0].ingest_run_id;
}

async function finishSettlementRun(ingestRunId: string, status: "SUCCESS" | "PARTIAL" | "FAILED", rowCount: number, errorMessage: string | null = null) {
  await pool.query(
    `UPDATE ingest_runs
     SET finished_at = now(), status = $2, row_count = $3, normalized_row_count = $3,
         rejected_row_count = 0, error_message = $4
     WHERE ingest_run_id = $1`,
    [ingestRunId, status, rowCount, errorMessage],
  );
}

async function ensurePlayer(client: DbClient, playerId: number, fullName: string) {
  await client.query(
    `INSERT INTO players (player_id, full_name)
     VALUES ($1, $2)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId, fullName],
  );
}

/**
 * Classifies a correction from the transition that produced it.
 *
 * Every correction used to be labelled DATA_INGEST_FAILURE by
 * `const taxonomy = correctionOf ? 'DATA_INGEST_FAILURE' : null`, which made
 * five of the six taxonomy values unreachable and told an operator nothing
 * about what had actually happened.
 */
export function classifyCorrection(input: {
  priorState: SettlementState;
  newState: SettlementState;
  priorHadPlateAppearances: boolean;
  newHasPlateAppearances: boolean;
  statLineChanged: boolean;
  lateScratch: boolean;
}): CorrectionReason {
  // A game that was postponed or suspended and later completed is a resumption,
  // not an ingest failure.
  if (input.priorState === "POSTPONED" && input.newState === "SETTLED") return "GAME_RESUMPTION";
  // A player who was in the settled record with appearances and now has none was
  // scratched after the record was written.
  if (input.lateScratch || (input.priorHadPlateAppearances && !input.newHasPlateAppearances)) {
    return "LATE_SCRATCH";
  }
  // A changed stat line on a game that was already final is MLB revising its
  // own numbers.
  if (input.priorState === "SETTLED" && input.newState === "SETTLED" && input.statLineChanged) {
    return "OFFICIAL_STAT_CORRECTION";
  }
  if (input.priorState === "NO_ACTION" && input.newState === "SETTLED") return "GAME_RESUMPTION";
  return "DATA_INGEST_FAILURE";
}

async function appendSettlementOutcome(
  client: DbClient,
  line: BattingLine,
  market: Market,
  settlementState: SettlementState,
  slateDate: string,
  gamePkValue: number,
  ingestRunId: string,
  sourceMetadata: JsonObject,
  options: { settledWithoutSnapshot?: boolean; lateScratch?: boolean } = {},
) {
  const { value, hit, discrepancy } = outcomeFor(market, line);
  // A disagreement between the components and the reported total is not settled
  // as though one of them were right. DISPUTED is excluded from training by the
  // settlement_state = 'SETTLED' filter every training query already applies.
  const effectiveState: SettlementState = discrepancy && settlementState === "SETTLED"
    ? "DISPUTED"
    : settlementState;
  const dbMarket = DB_MARKETS[market];
  const existing = await client.query<{
    outcome_id: string;
    outcome_value: string;
    outcome_hit: boolean;
    singles: number | null;
    doubles: number | null;
    triples: number | null;
    home_runs: number | null;
    walks: number | null;
    intentional_walks: number | null;
    hit_by_pitch: number | null;
    plate_appearances: number | null;
    at_bats: number | null;
    settlement_state: SettlementState;
    correction_of: string | null;
  }>(
    `SELECT outcome_id, outcome_value, outcome_hit, singles, doubles, triples, home_runs,
            walks, intentional_walks, hit_by_pitch, plate_appearances, at_bats,
            settlement_state, correction_of
     FROM historical_outcomes
     WHERE player_id = $1 AND game_pk = $2 AND market = $3
     ORDER BY created_at DESC LIMIT 1`,
    [line.playerId, gamePkValue, dbMarket],
  );
  const prior = existing.rows[0];
  const same = prior
    && Number(prior.outcome_value) === value
    && prior.outcome_hit === hit
    && prior.singles === line.singles
    && prior.doubles === line.doubles
    && prior.triples === line.triples
    && prior.home_runs === line.homeRuns
    && prior.walks === line.walks
    && prior.intentional_walks === line.intentionalWalks
    && prior.hit_by_pitch === line.hitByPitch
    && prior.plate_appearances === line.plateAppearances
    && prior.at_bats === line.atBats
    && prior.settlement_state === effectiveState;
  if (same) return { outcomeId: prior.outcome_id, created: false, corrected: false, discrepancy, taxonomy: null };

  const correctionOf = prior && prior.settlement_state !== "PENDING" ? prior.outcome_id : null;
  const statLineChanged = Boolean(prior) && (
    prior.singles !== line.singles
    || prior.doubles !== line.doubles
    || prior.triples !== line.triples
    || prior.home_runs !== line.homeRuns
    || prior.walks !== line.walks
    || prior.intentional_walks !== line.intentionalWalks
    || prior.hit_by_pitch !== line.hitByPitch
  );
  const taxonomy = correctionOf
    ? classifyCorrection({
      priorState: prior!.settlement_state,
      newState: effectiveState,
      priorHadPlateAppearances: (prior!.plate_appearances ?? 0) > 0,
      newHasPlateAppearances: line.plateAppearances > 0,
      statLineChanged,
      lateScratch: options.lateScratch === true,
    })
    : null;
  const result = await client.query<{ outcome_id: string }>(
    `INSERT INTO historical_outcomes
       (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
        plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
        intentional_walks, hit_by_pitch, walk_definition, settled_without_snapshot,
        settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata,
        correction_of, process_error_taxonomy, correction_note, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, now(), $19, $20, $21, $22, $23, $24, '{}')
     RETURNING outcome_id`,
    [
      line.playerId, gamePkValue, slateDate, dbMarket, value, hit,
      line.plateAppearances, line.atBats, line.singles, line.doubles, line.triples,
      line.homeRuns, line.walks, line.intentionalWalks, line.hitByPitch,
      walkDefinitionLabel(), options.settledWithoutSnapshot === true,
      effectiveState, MLB_SOURCE, ingestRunId,
      discrepancy ? { ...sourceMetadata, totalBasesDiscrepancy: discrepancy } : sourceMetadata,
      correctionOf, taxonomy,
      correctionOf
        ? `Official MLB result superseded a prior settled observation (${taxonomy}).`
        : discrepancy ?? null,
    ],
  );
  return {
    outcomeId: result.rows[0].outcome_id,
    created: true,
    corrected: Boolean(correctionOf),
    discrepancy,
    taxonomy,
  };
}

export async function settleOfficialGame(rawGamePk: unknown) {
  const gamePkValue = gamePk(rawGamePk);
  const game = await pool.query<{ game_date: string }>(
    `SELECT game_date::text AS game_date FROM games WHERE game_pk = $1`,
    [gamePkValue],
  );
  if (!game.rows[0]) throw new SettlementValidationError(`Game ${gamePkValue} not found`);
  const slateDate = date(game.rows[0].game_date);
  const ingestRunId = await startSettlementRun(slateDate);
  try {
    const endpoint = `${MLB_GAME_FEED_URL}/${gamePkValue}/feed/live`;
    const response = await fetch(endpoint);
    const payload = await response.json() as JsonObject;
    if (!response.ok) throw new Error(`MLB game feed ${gamePkValue} returned HTTP ${response.status}`);
    const gameStatus = String(object(object(payload.gameData).status).detailedState ?? payload.status ?? "");
    const statusLower = gameStatus.toLowerCase();
    const terminalState: SettlementState = statusLower === "postponed" || statusLower === "suspended"
      ? "POSTPONED"
      : statusLower === "cancelled" || statusLower === "canceled" || statusLower === "no decision"
        ? "NO_ACTION"
        : "PENDING";
    if (!isFinal(payload) && terminalState === "PENDING") {
      await finishSettlementRun(ingestRunId, "SUCCESS", 0);
      return { gamePk: gamePkValue, slateDate, ingestRunId, state: "PENDING" as const, lines: 0, outcomesWritten: 0, corrections: 0 };
    }
    const lines = battingLines(payload);

    // The settlement universe is the UNION of frozen snapshots and the daily
    // market board.
    //
    // The loop used to iterate only pregame_feature_snapshots, so a candidate
    // that reached the board but never got a snapshot was never settled, never
    // entered historical_outcomes, and vanished from the record silently.
    const frozen = await pool.query<{ player_id: number; market: string }>(
      `SELECT DISTINCT ON (player_id, market) player_id, market
       FROM pregame_feature_snapshots
       WHERE game_pk = $1 AND slate_date = $2
       ORDER BY player_id, market, created_at DESC`,
      [gamePkValue, slateDate],
    );
    const boarded = await pool.query<{ player_id: number; market: string }>(
      `SELECT DISTINCT player_id, market::text AS market
       FROM daily_market_board
       WHERE game_pk = $1 AND slate_date = $2
         AND market <> 'HITS_RUNS_RBI_2_PLUS'`,
      [gamePkValue, slateDate],
    );
    const linesByPlayer = new Map(lines.map((line) => [line.playerId, line]));
    const universe = new Map<number, Map<Market, { hasSnapshot: boolean }>>();
    const addToUniverse = (playerId: number, dbMarket: string, hasSnapshot: boolean) => {
      const market = SHORT_MARKETS[dbMarket];
      if (!market) return;
      if (!universe.has(playerId)) universe.set(playerId, new Map());
      const markets = universe.get(playerId)!;
      const existing = markets.get(market);
      markets.set(market, { hasSnapshot: hasSnapshot || existing?.hasSnapshot === true });
    };
    for (const row of frozen.rows) addToUniverse(row.player_id, row.market, true);
    for (const row of boarded.rows) addToUniverse(row.player_id, row.market, false);
    const boardCandidateCount = boarded.rows.length;
    const sourceMetadata = {
      provider: "MLB Stats API",
      endpoint,
      gamePk: gamePkValue,
      status: object(object(payload.gameData).status).detailedState ?? payload.status ?? "Final",
      responseChecksum: checksum(payload),
    };
    assertNoBettingData(sourceMetadata);
    const client = await pool.connect();
    let outcomesWritten = 0;
    let corrections = 0;
    let settledWithoutSnapshot = 0;
    const discrepancies: string[] = [];
    const settledKeys = new Set<string>();
    try {
      await client.query("BEGIN");
      // One final game is one settlement unit. The transaction-scoped advisory
      // lock makes retrying refreshes idempotent instead of appending competing
      // original outcomes or sibling corrections.
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [gamePkValue, 4142]);
      for (const [playerId, markets] of universe) {
        const observed = linesByPlayer.get(playerId);
        const line: BattingLine = observed && observed.plateAppearances > 0
          ? observed
          : {
              playerId,
              fullName: observed?.fullName ?? `MLB player ${playerId}`,
              singles: 0, doubles: 0, triples: 0, homeRuns: 0, reportedTotalBases: null,
              walks: 0, intentionalWalks: 0, hitByPitch: 0, plateAppearances: 0, atBats: 0,
            };
        await ensurePlayer(client, line.playerId, line.fullName);
        const state = terminalState === "PENDING" ? (observed && observed.plateAppearances > 0 ? "SETTLED" : "NO_ACTION") : terminalState;
        for (const [market, membership] of markets) {
          const result = await appendSettlementOutcome(
            client, line, market, state, slateDate, gamePkValue, ingestRunId, sourceMetadata,
            { settledWithoutSnapshot: !membership.hasSnapshot },
          );
          if (result.created) outcomesWritten += 1;
          if (result.corrected) corrections += 1;
          if (!membership.hasSnapshot) settledWithoutSnapshot += 1;
          if (result.discrepancy) discrepancies.push(result.discrepancy);
          settledKeys.add(`${playerId}:${market}`);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // Reconciliation. Every board candidate either settled or appears by name
    // in unsettleable with the reason it did not.
    const unsettleable = boarded.rows
      .filter((row) => {
        const market = SHORT_MARKETS[row.market];
        return !market || !settledKeys.has(`${row.player_id}:${market}`);
      })
      .map((row) => ({
        playerId: row.player_id,
        market: row.market,
        reason: SHORT_MARKETS[row.market]
          ? "The candidate was on the board but produced no settlement row."
          : `Market ${row.market} has no settlement contract.`,
      }));
    const reconciliation = {
      boardCandidates: boardCandidateCount,
      settled: settledKeys.size,
      settledWithoutSnapshot,
      unsettleable,
      totalBasesDiscrepancies: discrepancies,
      walkDefinition: walkDefinitionLabel(),
      walkDefinitionAssumed: WALK_SETTLEMENT_POLICY.assumed,
      walkDefinitionStatement: WALK_SETTLEMENT_POLICY.statement,
    };
    await finishSettlementRun(
      ingestRunId,
      unsettleable.length || discrepancies.length ? "PARTIAL" : "SUCCESS",
      outcomesWritten,
      unsettleable.length
        ? `${unsettleable.length} board candidate(s) could not be settled.`
        : discrepancies.length
          ? `${discrepancies.length} total bases discrepancy/discrepancies were settled DISPUTED.`
          : null,
    );
    const resultState: SettlementState = terminalState === "PENDING" ? "SETTLED" : terminalState;
    return {
      gamePk: gamePkValue,
      slateDate,
      ingestRunId,
      state: resultState,
      lines: lines.length,
      outcomesWritten,
      corrections,
      reconciliation,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSettlementRun(ingestRunId, "FAILED", 0, message);
    throw error;
  }
}

export async function settleOfficialDate(rawDate: unknown) {
  const slateDate = date(rawDate);
  const games = await pool.query<{ game_pk: number }>(
    `SELECT game_pk::bigint AS game_pk FROM games
     WHERE game_date = $1
       AND game_status IN ('Final', 'Game Over', 'Completed Early', 'Postponed', 'Suspended', 'Cancelled', 'Canceled', 'No Decision')
     ORDER BY game_pk`,
    [slateDate],
  );
  const results = [];
  for (const row of games.rows) results.push(await settleOfficialGame(row.game_pk));
  const reconciliation = {
    boardCandidates: results.reduce((total, r) => total + (r.reconciliation?.boardCandidates ?? 0), 0),
    settled: results.reduce((total, r) => total + (r.reconciliation?.settled ?? 0), 0),
    settledWithoutSnapshot: results.reduce((total, r) => total + (r.reconciliation?.settledWithoutSnapshot ?? 0), 0),
    unsettleable: results.flatMap((r) => (r.reconciliation?.unsettleable ?? []).map(
      (entry) => ({ ...entry, gamePk: r.gamePk }),
    )),
    totalBasesDiscrepancies: results.flatMap((r) => r.reconciliation?.totalBasesDiscrepancies ?? []),
    walkDefinition: walkDefinitionLabel(),
    walkDefinitionAssumed: WALK_SETTLEMENT_POLICY.assumed,
    walkDefinitionStatement: WALK_SETTLEMENT_POLICY.statement,
  };
  return {
    source: "MLB Official",
    slateDate,
    gamesFound: games.rows.length,
    gamesSettled: results.filter((result) => result.state !== "PENDING").length,
    outcomesWritten: results.reduce((total, result) => total + result.outcomesWritten, 0),
    corrections: results.reduce((total, result) => total + result.corrections, 0),
    reconciliation,
    games: results,
  };
}

export async function createMarketPostmortem(input: {
  snapshotId: string;
  outcomeId: string;
  notes?: string | null;
  processErrorTaxonomy?: string | null;
}) {
  if (!input.snapshotId || !input.outcomeId) throw new SettlementValidationError("snapshotId and outcomeId are required");
  assertNoBettingData(input);
  const linked = await pool.query<{
    snapshot_id: string;
    outcome_id: string;
    player_id: number;
    game_pk: number;
    market: string;
    feature_hash: string;
    outcome_value: string;
    outcome_hit: boolean;
    settlement_state: SettlementState;
    research_rank: number | null;
    research_state: string | null;
    primary_mechanism: string | null;
  }>(
    `SELECT pfs.snapshot_id, ho.outcome_id, pfs.player_id, pfs.game_pk::bigint AS game_pk,
            pfs.market, pfs.feature_hash, ho.outcome_value, ho.outcome_hit,
            ho.settlement_state, pfs.research_rank, pfs.research_state, pfs.primary_mechanism
     FROM pregame_feature_snapshots pfs
     JOIN historical_outcomes ho ON ho.player_id = pfs.player_id
       AND ho.game_pk = pfs.game_pk AND ho.market = pfs.market
      WHERE pfs.snapshot_id = $1 AND ho.outcome_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM historical_outcomes newer WHERE newer.correction_of = ho.outcome_id
        )`,
    [input.snapshotId, input.outcomeId],
  );
  const row = linked.rows[0];
  if (!row) throw new SettlementValidationError("Snapshot and outcome do not describe the same player, game, and market");
  if (row.settlement_state !== "SETTLED") throw new SettlementValidationError("Postmortems require a SETTLED official outcome");
  const result = await pool.query<{ postmortem_id: string; created_at: string }>(
    `INSERT INTO market_postmortems
       (snapshot_id, outcome_id, player_id, game_pk, market, snapshot_feature_hash,
        outcome_value, outcome_hit, research_rank, research_state, primary_mechanism,
         notes, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING postmortem_id, created_at`,
    [
      row.snapshot_id, row.outcome_id, row.player_id, row.game_pk, row.market,
      row.feature_hash, row.outcome_value, row.outcome_hit, row.research_rank,
        row.research_state, row.primary_mechanism, input.notes ?? null,
        input.processErrorTaxonomy ? { processErrorTaxonomy: input.processErrorTaxonomy } : {},
    ],
  );
  return {
    postmortemId: result.rows[0].postmortem_id,
    snapshotId: row.snapshot_id,
    outcomeId: row.outcome_id,
    playerId: row.player_id,
    gamePk: Number(row.game_pk),
    market: toShortMarketOrNull(row.market),
    outcomeValue: Number(row.outcome_value),
    outcomeHit: row.outcome_hit,
    researchRank: row.research_rank,
    researchState: row.research_state,
    primaryMechanism: row.primary_mechanism,
    notes: input.notes ?? null,
    createdAt: result.rows[0].created_at,
  };
}

export async function querySettlements(filters: { gamePk?: number | null; playerId?: number | null; market?: string | null; dateFrom?: string | null; dateTo?: string | null }) {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (value: unknown, clause: string) => { params.push(value); where.push(clause.replace("?", `$${params.length}`)); };
  if (filters.gamePk != null) add(filters.gamePk, "ho.game_pk = ?");
  if (filters.playerId != null) add(filters.playerId, "ho.player_id = ?");
  if (filters.market) add(DB_MARKETS[filters.market as Market] ?? filters.market, "ho.market = ?");
  if (filters.dateFrom) add(filters.dateFrom, "ho.slate_date >= ?");
  if (filters.dateTo) add(filters.dateTo, "ho.slate_date <= ?");
  const result = await pool.query(
    `SELECT ho.outcome_id, ho.player_id, p.full_name, ho.game_pk::bigint AS game_pk,
            ho.slate_date::text AS slate_date, ho.market, ho.outcome_value, ho.outcome_hit,
            ho.singles, ho.doubles, ho.triples, ho.home_runs, ho.walks,
            ho.plate_appearances, ho.at_bats, ho.settlement_state, ho.settled_at,
            ho.source_id, ho.ingest_run_id, ho.official_source_metadata,
            ho.correction_of, ho.process_error_taxonomy, ho.correction_note
     FROM historical_outcomes ho JOIN players p ON p.player_id = ho.player_id
     WHERE ho.settlement_state IN ('SETTLED', 'POSTPONED', 'NO_ACTION', 'DISPUTED')
       AND ho.source_id = 'MLB_OFFICIAL'
       AND NOT EXISTS (
         SELECT 1 FROM historical_outcomes newer WHERE newer.correction_of = ho.outcome_id
       )
       ${where.length ? `AND ${where.join(" AND ")}` : ""}
     ORDER BY ho.slate_date DESC, ho.created_at DESC
     LIMIT 500`,
    params,
  );
  return result.rows.map((row) => ({
    outcomeId: row.outcome_id,
    playerId: row.player_id,
    playerName: row.full_name,
    gamePk: Number(row.game_pk),
    slateDate: row.slate_date,
    market: toShortMarketOrNull(row.market),
    outcomeValue: Number(row.outcome_value),
    outcomeHit: row.outcome_hit,
    components: { singles: row.singles, doubles: row.doubles, triples: row.triples, homeRuns: row.home_runs, walks: row.walks, plateAppearances: row.plate_appearances, atBats: row.at_bats },
    settlementState: row.settlement_state,
    settledAt: row.settled_at,
    sourceId: row.source_id,
    ingestRunId: row.ingest_run_id,
    officialSourceMetadata: row.official_source_metadata,
    correctionOf: row.correction_of,
    processErrorTaxonomy: row.process_error_taxonomy,
    correctionNote: row.correction_note,
  }));
}

export async function queryMarketPostmortems(filters: { playerId?: number | null; market?: string | null }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.playerId != null) { params.push(filters.playerId); where.push(`mp.player_id = $${params.length}`); }
  if (filters.market) { params.push(DB_MARKETS[filters.market as Market] ?? filters.market); where.push(`mp.market = $${params.length}`); }
  const result = await pool.query(
    `SELECT mp.postmortem_id, mp.snapshot_id, mp.outcome_id, mp.player_id, p.full_name,
            mp.game_pk::bigint AS game_pk, mp.market, mp.snapshot_feature_hash,
            mp.outcome_value, mp.outcome_hit, mp.research_rank, mp.research_state,
            mp.primary_mechanism, mp.notes, mp.created_at
     FROM market_postmortems mp JOIN players p ON p.player_id = mp.player_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY mp.created_at DESC LIMIT 500`,
    params,
  );
  return result.rows.map((row) => ({
    postmortemId: row.postmortem_id,
    snapshotId: row.snapshot_id,
    outcomeId: row.outcome_id,
    playerId: row.player_id,
    playerName: row.full_name,
    gamePk: Number(row.game_pk),
    market: toShortMarketOrNull(row.market),
    snapshotFeatureHash: row.snapshot_feature_hash,
    outcomeValue: Number(row.outcome_value),
    outcomeHit: row.outcome_hit,
    researchRank: row.research_rank,
    researchState: row.research_state,
    primaryMechanism: row.primary_mechanism,
    notes: row.notes,
    createdAt: row.created_at,
  }));
}
