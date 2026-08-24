/**
 * Single source of truth for the market code vocabulary.
 *
 * Two vocabularies exist and both are load bearing: the short code used by the
 * modelling layer and the HTTP contract (TB, XBH, WALK, HR) and the database
 * market_type enum value stored on every row. Before this module the mapping
 * was written out inline, as record literals in four services and as chains of
 * ternaries in several more, which is how the two vocabularies drift.
 *
 * This module is deliberately free of database and I/O imports so that it can
 * be unit tested and imported from anywhere.
 */

export const MODEL_MARKETS = ["TB", "XBH", "WALK", "HR"] as const;
export type ModelMarket = (typeof MODEL_MARKETS)[number];

export const DB_MARKETS = [
  "TOTAL_BASES_2_PLUS",
  "EXTRA_BASE_HIT",
  "BATTER_WALK",
  "HOME_RUN",
] as const;
export type DbModelMarket = (typeof DB_MARKETS)[number];

export const MARKET_TO_DB: Record<ModelMarket, DbModelMarket> = {
  TB: "TOTAL_BASES_2_PLUS",
  XBH: "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR: "HOME_RUN",
};

export const DB_TO_MARKET: Record<DbModelMarket, ModelMarket> = {
  TOTAL_BASES_2_PLUS: "TB",
  EXTRA_BASE_HIT: "XBH",
  BATTER_WALK: "WALK",
  HOME_RUN: "HR",
};

export function isModelMarket(value: unknown): value is ModelMarket {
  return typeof value === "string" && (MODEL_MARKETS as readonly string[]).includes(value);
}

export function isDbModelMarket(value: unknown): value is DbModelMarket {
  return typeof value === "string" && (DB_MARKETS as readonly string[]).includes(value);
}

/** Short code to database enum value. Throws rather than returning a guess. */
export function toDbMarket(market: ModelMarket): DbModelMarket {
  const dbMarket = MARKET_TO_DB[market];
  if (!dbMarket) throw new Error(`Unknown model market "${market}".`);
  return dbMarket;
}

/** Database enum value to short code. Throws rather than returning a guess. */
export function toShortMarket(dbMarket: string): ModelMarket {
  const market = DB_TO_MARKET[dbMarket as DbModelMarket];
  if (!market) throw new Error(`Unknown database market "${dbMarket}".`);
  return market;
}

/** Database enum value to short code, or null when the market is not modelled. */
export function toShortMarketOrNull(dbMarket: string): ModelMarket | null {
  return DB_TO_MARKET[dbMarket as DbModelMarket] ?? null;
}


// ── Round Robin vocabulary ────────────────────────────────────────────────────
//
// The Round Robin board carries a fifth market, H+R+RBI, which is research-only
// and has no model contract. It belongs in this module rather than in a second
// record literal inside the routes.

export const ROUND_ROBIN_MARKETS = ["TB", "XBH", "WALK", "HR", "H_R_RBI"] as const;
export type RoundRobinMarketCode = (typeof ROUND_ROBIN_MARKETS)[number];

export const HRRBI_DB_MARKET = "HITS_RUNS_RBI_2_PLUS";

export const RR_MARKET_TO_DB: Record<RoundRobinMarketCode, string> = {
  ...MARKET_TO_DB,
  H_R_RBI: HRRBI_DB_MARKET,
};

export const RR_DB_TO_MARKET: Record<string, RoundRobinMarketCode> = {
  ...DB_TO_MARKET,
  [HRRBI_DB_MARKET]: "H_R_RBI",
};

/** Database enum value to Round Robin short code, or null when unknown. */
export function toRoundRobinMarketOrNull(dbMarket: string): RoundRobinMarketCode | null {
  return RR_DB_TO_MARKET[dbMarket] ?? null;
}
