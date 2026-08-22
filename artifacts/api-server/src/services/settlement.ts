import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

const MLB_SOURCE = "MLB_OFFICIAL";
const MLB_GAME_FEED_URL = "https://statsapi.mlb.com/api/v1.1/game";
const MARKETS = ["TB", "XBH", "WALK", "HR"] as const;
const DB_MARKETS = {
  TB: "TOTAL_BASES_2_PLUS",
  XBH: "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR: "HOME_RUN",
} as const;
const CORRECTION_REASONS = [
  "LATE_SCRATCH",
  "LINEUP_ERROR",
  "DATA_INGEST_FAILURE",
  "IDENTITY_ERROR",
  "SOURCE_UNAVAILABLE",
  "HUMAN_CORRECTION",
] as const;

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
  totalBases: number;
  walks: number;
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
        totalBases: number(line.totalBases) || singles + doubles * 2 + triples * 3 + homeRuns * 4,
        walks: number(line.baseOnBalls ?? line.walks),
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
        totalBases: number(stats.totalBases) || singles + doubles * 2 + triples * 3 + homeRuns * 4,
        walks: number(stats.baseOnBalls),
        plateAppearances: number(stats.plateAppearances),
        atBats: number(stats.atBats),
      }];
    });
  });
}

function outcomeFor(market: Market, line: BattingLine) {
  const value = market === "TB"
    ? line.singles + line.doubles * 2 + line.triples * 3 + line.homeRuns * 4
    : market === "XBH"
      ? line.doubles + line.triples + line.homeRuns
      : market === "WALK" ? line.walks : line.homeRuns;
  return { value, hit: market === "TB" ? value >= 2 : value >= 1 };
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

async function appendSettlementOutcome(
  client: DbClient,
  line: BattingLine,
  market: Market,
  settlementState: SettlementState,
  slateDate: string,
  gamePkValue: number,
  ingestRunId: string,
  sourceMetadata: JsonObject,
) {
  const { value, hit } = outcomeFor(market, line);
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
    plate_appearances: number | null;
    at_bats: number | null;
    settlement_state: SettlementState;
    correction_of: string | null;
  }>(
    `SELECT outcome_id, outcome_value, outcome_hit, singles, doubles, triples, home_runs,
            walks, plate_appearances, at_bats, settlement_state, correction_of
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
    && prior.plate_appearances === line.plateAppearances
    && prior.at_bats === line.atBats
    && prior.settlement_state === settlementState;
  if (same) return { outcomeId: prior.outcome_id, created: false, corrected: false };

  const correctionOf = prior && prior.settlement_state !== "PENDING" ? prior.outcome_id : null;
  const taxonomy = correctionOf ? "DATA_INGEST_FAILURE" : null;
  const result = await client.query<{ outcome_id: string }>(
    `INSERT INTO historical_outcomes
       (player_id, game_pk, slate_date, market, outcome_value, outcome_hit,
        plate_appearances, at_bats, singles, doubles, triples, home_runs, walks,
        settlement_state, settled_at, source_id, ingest_run_id, official_source_metadata,
        correction_of, process_error_taxonomy, correction_note, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, now(), $15, $16, $17, $18, $19, $20, '{}')
     RETURNING outcome_id`,
    [
      line.playerId, gamePkValue, slateDate, dbMarket, value, hit,
      line.plateAppearances, line.atBats, line.singles, line.doubles, line.triples,
      line.homeRuns, line.walks, settlementState, MLB_SOURCE, ingestRunId, sourceMetadata,
      correctionOf, taxonomy,
      correctionOf ? "Official MLB result superseded a prior settled observation." : null,
    ],
  );
  return { outcomeId: result.rows[0].outcome_id, created: true, corrected: Boolean(correctionOf) };
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
    const frozen = await pool.query<{ player_id: number; market: string }>(
      `SELECT DISTINCT ON (player_id, market) player_id, market
       FROM pregame_feature_snapshots
       WHERE game_pk = $1 AND slate_date = $2
       ORDER BY player_id, market, created_at DESC`,
      [gamePkValue, slateDate],
    );
    const linesByPlayer = new Map(lines.map((line) => [line.playerId, line]));
    const frozenPlayers = new Map<number, Set<Market>>();
    for (const row of frozen.rows) {
      const market = row.market === "TOTAL_BASES_2_PLUS" ? "TB" : row.market === "EXTRA_BASE_HIT" ? "XBH" : row.market === "BATTER_WALK" ? "WALK" : "HR";
      const markets = frozenPlayers.get(row.player_id) ?? new Set<Market>();
      markets.add(market);
      frozenPlayers.set(row.player_id, markets);
    }
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
    try {
      await client.query("BEGIN");
      // One final game is one settlement unit. The transaction-scoped advisory
      // lock makes retrying refreshes idempotent instead of appending competing
      // original outcomes or sibling corrections.
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [gamePkValue, 4142]);
      for (const [frozenPlayerId, markets] of frozenPlayers) {
        const observed = linesByPlayer.get(frozenPlayerId);
        const line = observed && observed.plateAppearances > 0
          ? observed
          : {
              playerId: frozenPlayerId,
              fullName: observed?.fullName ?? `MLB player ${frozenPlayerId}`,
              singles: 0, doubles: 0, triples: 0, homeRuns: 0, totalBases: 0,
              walks: 0, plateAppearances: 0, atBats: 0,
            };
        await ensurePlayer(client, line.playerId, line.fullName);
        const state = terminalState === "PENDING" ? (observed && observed.plateAppearances > 0 ? "SETTLED" : "NO_ACTION") : terminalState;
        for (const market of markets) {
          const result = await appendSettlementOutcome(client, line, market, state, slateDate, gamePkValue, ingestRunId, sourceMetadata);
          if (result.created) outcomesWritten += 1;
          if (result.corrected) corrections += 1;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await finishSettlementRun(ingestRunId, "SUCCESS", outcomesWritten);
    const resultState: SettlementState = terminalState === "PENDING" ? "SETTLED" : terminalState;
    return {
      gamePk: gamePkValue,
      slateDate,
      ingestRunId,
      state: resultState,
      lines: lines.length,
      outcomesWritten,
      corrections,
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
  return {
    source: "MLB Official",
    slateDate,
    gamesFound: games.rows.length,
    gamesSettled: results.filter((result) => result.state !== "PENDING").length,
    outcomesWritten: results.reduce((total, result) => total + result.outcomesWritten, 0),
    corrections: results.reduce((total, result) => total + result.corrections, 0),
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
    market: row.market === "TOTAL_BASES_2_PLUS" ? "TB" : row.market === "EXTRA_BASE_HIT" ? "XBH" : row.market === "BATTER_WALK" ? "WALK" : "HR",
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
    market: row.market === "TOTAL_BASES_2_PLUS" ? "TB" : row.market === "EXTRA_BASE_HIT" ? "XBH" : row.market === "BATTER_WALK" ? "WALK" : "HR",
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
    market: row.market === "TOTAL_BASES_2_PLUS" ? "TB" : row.market === "EXTRA_BASE_HIT" ? "XBH" : row.market === "BATTER_WALK" ? "WALK" : "HR",
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

export { CORRECTION_REASONS };