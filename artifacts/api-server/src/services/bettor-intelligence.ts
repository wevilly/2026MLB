import { pool } from "@workspace/db";

export const BETTOR_MARKETS = ["TB", "XBH", "WALK", "HR"] as const;
export type BettorMarket = (typeof BETTOR_MARKETS)[number];

/**
 * The complete Phase 3-approved mechanism vocabulary. Bettor evidence is
 * constrained to these baseball mechanisms; it cannot introduce a free-form
 * theory that later gets misread as independent confirmation.
 */
export const BETTOR_MECHANISMS = [
  "CONTACT_VOLUME",
  "POWER_ROUTE",
  "MULTI_PATH",
  "DOUBLE_ROUTE",
  "TRIPLE_ROUTE",
  "HOME_RUN_ROUTE",
  "PATIENCE_VS_COMMAND",
  "COUNT_CREATION",
  "BULLPEN_WALK_PATH",
  "PULL_AIR",
  "BARREL_POWER",
  "PITCH_SHAPE_MISMATCH",
  "PARK_ENVIRONMENT",
] as const;
export type BettorMechanism = (typeof BETTOR_MECHANISMS)[number];

export const MAX_RETAINED_REASONING_LENGTH = 500;
const LIKELY_COPY_THRESHOLD = 0.8;
const LINEAGE_THRESHOLD = 0.5;
const COPY_WINDOW_MS = 24 * 60 * 60 * 1000;

const DB_MARKET: Record<BettorMarket, string> = {
  TB: "TOTAL_BASES_2_PLUS",
  XBH: "EXTRA_BASE_HIT",
  WALK: "BATTER_WALK",
  HR: "HOME_RUN",
};

const SHORT_MARKET: Record<string, BettorMarket> = {
  TOTAL_BASES_2_PLUS: "TB",
  EXTRA_BASE_HIT: "XBH",
  BATTER_WALK: "WALK",
  HOME_RUN: "HR",
};

export class BettorIntelligenceValidationError extends Error {}
export class BettorIntelligenceConflictError extends Error {}

export type BettorSourceInput = {
  platform: string;
  accountHandle: string;
  personIdentityKey?: string | null;
  personLevelCrossPlatform?: boolean;
};

export type BettorPickInput = {
  sourceId: string;
  slateDate: string;
  playerId: number;
  market: BettorMarket;
  pickDirection: "YES" | "NO";
  mechanismTags: BettorMechanism[];
  reasoning: string;
  sourceUrl?: string | null;
  postedAt: string;
};

type SourceRow = {
  source_id: string;
  platform: string;
  account_handle: string;
  person_identity_key: string | null;
  person_level_cross_platform: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

type LineageRow = {
  lineage_id: string;
  prior_pick_id: string;
  confidence: string | number;
  method: string;
  prior_source_id: string;
  prior_platform: string;
  prior_account_handle: string;
};

type PickRow = {
  pick_id: string;
  slate_date: string;
  player_id: number;
  player_name: string;
  market: string;
  pick_direction: "YES" | "NO";
  mechanism_tags: BettorMechanism[] | string;
  reasoning_paraphrase: string;
  original_text_retained_flag: boolean;
  source_url: string | null;
  posted_at: string | Date;
  ingested_at: string | Date;
  source_id: string;
  duplication_flag: "INDEPENDENT" | "IS_LIKELY_COPY";
  platform: string;
  account_handle: string;
  person_identity_key: string | null;
  person_level_cross_platform: boolean;
} & Partial<LineageRow>;

function iso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizedOptional(value: string | null | undefined, field: string, maxLength = 160) {
  if (value == null) return null;
  if (typeof value !== "string") throw new BettorIntelligenceValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new BettorIntelligenceValidationError(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function requiredText(value: string, field: string, maxLength = 160) {
  const normalized = normalizedOptional(value, field, maxLength);
  if (!normalized) throw new BettorIntelligenceValidationError(`${field} is required`);
  return normalized;
}

function summarizeReasoning(value: string, mechanismTags: BettorMechanism[]) {
  if (typeof value !== "string") throw new BettorIntelligenceValidationError("reasoning must be a string");
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return { reasoningParaphrase: "No independent reasoning supplied.", originalTextRetainedFlag: false };
  if (normalized.length <= MAX_RETAINED_REASONING_LENGTH) {
    return { reasoningParaphrase: normalized, originalTextRetainedFlag: true };
  }

  const mechanismSummary = mechanismTags.length ? mechanismTags.join(", ") : "no approved mechanism tags";
  return {
    reasoningParaphrase: `Extended source rationale was omitted because it exceeded the ${MAX_RETAINED_REASONING_LENGTH}-character retention limit. Recorded mechanisms: ${mechanismSummary}.`,
    originalTextRetainedFlag: false,
  };
}

function normalizeReasoning(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSimilarity(left: string, right: string) {
  const leftTokens = new Set(normalizeReasoning(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeReasoning(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function mechanismSimilarity(left: BettorMechanism[], right: BettorMechanism[]) {
  const leftTags = new Set(left);
  const rightTags = new Set(right);
  if (leftTags.size === 0 && rightTags.size === 0) return 1;
  if (leftTags.size === 0 || rightTags.size === 0) return 0;
  const intersection = [...leftTags].filter((tag) => rightTags.has(tag)).length;
  return intersection / new Set([...leftTags, ...rightTags]).size;
}

function parseMechanismTags(value: BettorMechanism[] | string | null | undefined): BettorMechanism[] {
  if (Array.isArray(value)) return value;
  if (!value || value === "{}") return [];
  if (value.startsWith("{") && value.endsWith("}")) {
    return value.slice(1, -1).split(",").filter(Boolean) as BettorMechanism[];
  }
  return [];
}

function compareDuplicate(
  incoming: Pick<BettorPickInput, "reasoning" | "mechanismTags" | "postedAt" | "pickDirection">,
  prior: { reasoning_paraphrase: string; mechanism_tags: BettorMechanism[] | string; posted_at: string | Date; pick_direction: "YES" | "NO" },
) {
  if (incoming.pickDirection !== prior.pick_direction) return null;
  const timingDistance = Math.abs(new Date(incoming.postedAt).getTime() - new Date(prior.posted_at).getTime());
  if (!Number.isFinite(timingDistance) || timingDistance > COPY_WINDOW_MS) return null;

  const reasonScore = tokenSimilarity(incoming.reasoning, prior.reasoning_paraphrase);
  const tagScore = mechanismSimilarity(incoming.mechanismTags, parseMechanismTags(prior.mechanism_tags));
  const confidence = Number((0.4 + reasonScore * 0.35 + tagScore * 0.25).toFixed(3));
  if (confidence < LINEAGE_THRESHOLD) return null;
  return { confidence, method: "TIMING_MECHANISM_REASONING_V1" };
}

function mapSource(row: SourceRow) {
  return {
    sourceId: row.source_id,
    platform: row.platform,
    accountHandle: row.account_handle,
    personIdentityKey: row.person_identity_key,
    personLevelCrossPlatform: row.person_level_cross_platform,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapPick(row: PickRow, lineage: LineageRow[]) {
  return {
    pickId: row.pick_id,
    slateDate: row.slate_date,
    playerId: row.player_id,
    playerName: row.player_name,
    market: SHORT_MARKET[row.market],
    pickDirection: row.pick_direction,
    mechanismTags: parseMechanismTags(row.mechanism_tags),
    reasoningParaphrase: row.reasoning_paraphrase,
    originalTextRetainedFlag: row.original_text_retained_flag,
    sourceUrl: row.source_url,
    postedAt: iso(row.posted_at),
    ingestedAt: iso(row.ingested_at),
    duplicationFlag: row.duplication_flag,
    isLikelyCopy: row.duplication_flag === "IS_LIKELY_COPY",
    source: {
      sourceId: row.source_id,
      platform: row.platform,
      accountHandle: row.account_handle,
      personIdentityKey: row.person_identity_key,
      personLevelCrossPlatform: row.person_level_cross_platform,
    },
    duplicationLineage: lineage.map((edge) => ({
      lineageId: edge.lineage_id,
      priorPickId: edge.prior_pick_id,
      confidence: Number(edge.confidence),
      method: edge.method,
      priorSource: {
        sourceId: edge.prior_source_id,
        platform: edge.prior_platform,
        accountHandle: edge.prior_account_handle,
      },
    })),
  };
}

export async function createBettorSource(input: BettorSourceInput) {
  const platform = requiredText(input.platform, "platform");
  const accountHandle = requiredText(input.accountHandle, "accountHandle");
  const personIdentityKey = normalizedOptional(input.personIdentityKey, "personIdentityKey");
  const personLevelCrossPlatform = Boolean(input.personLevelCrossPlatform && personIdentityKey);
  const result = await pool.query<SourceRow>(
    `INSERT INTO bettor_sources
       (platform, account_handle, person_identity_key, person_level_cross_platform)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform, account_handle) DO UPDATE
       SET person_identity_key = EXCLUDED.person_identity_key,
           person_level_cross_platform = EXCLUDED.person_level_cross_platform,
           updated_at = now()
     RETURNING source_id, platform, account_handle, person_identity_key,
               person_level_cross_platform, created_at, updated_at`,
    [platform, accountHandle, personIdentityKey, personLevelCrossPlatform],
  );
  return mapSource(result.rows[0]);
}

export async function updateBettorSource(sourceId: string, input: Partial<BettorSourceInput>) {
  const existing = await pool.query<SourceRow>(
    `SELECT source_id, platform, account_handle, person_identity_key,
            person_level_cross_platform, created_at, updated_at
       FROM bettor_sources WHERE source_id = $1`,
    [sourceId],
  );
  if (!existing.rows[0]) throw new BettorIntelligenceValidationError("Bettor source not found");
  const current = existing.rows[0];
  const platform = input.platform === undefined ? current.platform : requiredText(input.platform, "platform");
  const accountHandle = input.accountHandle === undefined
    ? current.account_handle
    : requiredText(input.accountHandle, "accountHandle");
  const personIdentityKey = input.personIdentityKey === undefined
    ? current.person_identity_key
    : normalizedOptional(input.personIdentityKey, "personIdentityKey");
  const personLevelCrossPlatform = input.personLevelCrossPlatform === undefined
    ? current.person_level_cross_platform
    : Boolean(input.personLevelCrossPlatform && personIdentityKey);

  try {
    const result = await pool.query<SourceRow>(
      `UPDATE bettor_sources
          SET platform = $2, account_handle = $3, person_identity_key = $4,
              person_level_cross_platform = $5, updated_at = now()
        WHERE source_id = $1
        RETURNING source_id, platform, account_handle, person_identity_key,
                  person_level_cross_platform, created_at, updated_at`,
      [sourceId, platform, accountHandle, personIdentityKey, personLevelCrossPlatform],
    );
    return mapSource(result.rows[0]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new BettorIntelligenceConflictError("A source already exists for that platform and account");
    }
    throw error;
  }
}

export async function queryBettorSources() {
  const result = await pool.query<SourceRow>(
    `SELECT source_id, platform, account_handle, person_identity_key,
            person_level_cross_platform, created_at, updated_at
       FROM bettor_sources
      ORDER BY platform, account_handle`,
  );
  return result.rows.map(mapSource);
}

export async function deleteBettorSource(sourceId: string) {
  const count = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM bettor_picks WHERE source_id = $1`,
    [sourceId],
  );
  if ((count.rows[0]?.count ?? 0) > 0) {
    throw new BettorIntelligenceConflictError("A source with ingested picks cannot be deleted");
  }
  const result = await pool.query<{ source_id: string }>(
    `DELETE FROM bettor_sources WHERE source_id = $1 RETURNING source_id`,
    [sourceId],
  );
  if (!result.rows[0]) throw new BettorIntelligenceValidationError("Bettor source not found");
  return { sourceId: result.rows[0].source_id, deleted: true };
}

async function queryPickRows(filters: { date?: string; market?: BettorMarket; pickId?: string }) {
  const params: string[] = [];
  const conditions: string[] = [];
  if (filters.date) {
    params.push(filters.date);
    conditions.push(`bp.slate_date = $${params.length}`);
  }
  if (filters.market) {
    params.push(DB_MARKET[filters.market]);
    conditions.push(`bp.market = $${params.length}`);
  }
  if (filters.pickId) {
    params.push(filters.pickId);
    conditions.push(`bp.pick_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query<PickRow>(
    `SELECT bp.pick_id, bp.slate_date::text, bp.player_id, p.full_name AS player_name,
            bp.market, bp.pick_direction, bp.mechanism_tags, bp.reasoning_paraphrase,
            bp.original_text_retained_flag, bp.source_url, bp.posted_at, bp.ingested_at,
            bp.source_id, bp.duplication_flag, bs.platform, bs.account_handle,
            bs.person_identity_key, bs.person_level_cross_platform,
            dl.lineage_id, dl.prior_pick_id, dl.confidence, dl.method,
            prior_bs.source_id AS prior_source_id, prior_bs.platform AS prior_platform,
            prior_bs.account_handle AS prior_account_handle
       FROM bettor_picks bp
       JOIN bettor_sources bs ON bs.source_id = bp.source_id
       JOIN players p ON p.player_id = bp.player_id
       LEFT JOIN pick_duplication_lineage dl ON dl.pick_id = bp.pick_id
       LEFT JOIN bettor_picks prior_bp ON prior_bp.pick_id = dl.prior_pick_id
       LEFT JOIN bettor_sources prior_bs ON prior_bs.source_id = prior_bp.source_id
       ${where}
      ORDER BY bp.posted_at DESC, bp.ingested_at DESC, dl.confidence DESC`,
    params,
  );

  const grouped = new Map<string, { row: PickRow; lineage: LineageRow[] }>();
  for (const row of result.rows) {
    const current = grouped.get(row.pick_id) ?? { row, lineage: [] };
    if (row.lineage_id && row.prior_pick_id && row.prior_source_id && row.prior_platform && row.prior_account_handle) {
      current.lineage.push({
        lineage_id: row.lineage_id,
        prior_pick_id: row.prior_pick_id,
        confidence: row.confidence!,
        method: row.method!,
        prior_source_id: row.prior_source_id,
        prior_platform: row.prior_platform,
        prior_account_handle: row.prior_account_handle,
      });
    }
    grouped.set(row.pick_id, current);
  }
  return [...grouped.values()].map(({ row, lineage }) => mapPick(row, lineage));
}

export async function queryBettorPicks(filters: { date: string; market?: BettorMarket | null }) {
  return queryPickRows({ date: filters.date, market: filters.market ?? undefined });
}

export async function ingestBettorPick(input: BettorPickInput) {
  if (!BETTOR_MARKETS.includes(input.market)) {
    throw new BettorIntelligenceValidationError("market must be TB, XBH, WALK, or HR");
  }
  if (!["YES", "NO"].includes(input.pickDirection)) {
    throw new BettorIntelligenceValidationError("pickDirection must be YES or NO");
  }
  if (
    !Array.isArray(input.mechanismTags)
    || input.mechanismTags.some((tag) => !BETTOR_MECHANISMS.includes(tag))
    || new Set(input.mechanismTags).size !== input.mechanismTags.length
  ) {
    throw new BettorIntelligenceValidationError("mechanismTags must use the approved Phase 3 mechanism vocabulary");
  }
  if (!Number.isSafeInteger(input.playerId) || input.playerId <= 0) {
    throw new BettorIntelligenceValidationError("playerId must be a positive integer");
  }
  if (Number.isNaN(new Date(input.postedAt).getTime())) {
    throw new BettorIntelligenceValidationError("postedAt must be a valid date-time");
  }

  const summary = summarizeReasoning(input.reasoning, input.mechanismTags);
  const sourceUrl = normalizedOptional(input.sourceUrl, "sourceUrl", 2048);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await client.query<{ source_id: string }>("SELECT source_id FROM bettor_sources WHERE source_id = $1", [input.sourceId]);
    if (!source.rows[0]) throw new BettorIntelligenceValidationError("Bettor source not found");

    const existingOwnPick = await client.query<{ pick_id: string }>(
      `SELECT pick_id FROM bettor_picks
        WHERE source_id = $1 AND slate_date = $2 AND player_id = $3 AND market = $4`,
      [input.sourceId, input.slateDate, input.playerId, DB_MARKET[input.market]],
    );
    if (existingOwnPick.rows[0]) {
      throw new BettorIntelligenceConflictError("This source already has a pick for the same player, market, and date");
    }

    const prior = await client.query<{
      pick_id: string;
      reasoning_paraphrase: string;
      mechanism_tags: BettorMechanism[] | string;
      posted_at: string | Date;
      pick_direction: "YES" | "NO";
    }>(
      `SELECT pick_id, reasoning_paraphrase, mechanism_tags, posted_at, pick_direction
         FROM bettor_picks
        WHERE slate_date = $1 AND player_id = $2 AND market = $3
          AND source_id <> $4 AND posted_at <= $5
        ORDER BY posted_at ASC, ingested_at ASC`,
      [input.slateDate, input.playerId, DB_MARKET[input.market], input.sourceId, input.postedAt],
    );
    const lineage = prior.rows.flatMap((row) => {
      const comparison = compareDuplicate({ ...input, reasoning: summary.reasoningParaphrase }, row);
      return comparison ? [{ priorPickId: row.pick_id, ...comparison }] : [];
    });
    const isLikelyCopy = lineage.some((edge) => edge.confidence >= LIKELY_COPY_THRESHOLD);

    const inserted = await client.query<{ pick_id: string }>(
      `INSERT INTO bettor_picks
         (slate_date, player_id, market, pick_direction, mechanism_tags,
          reasoning_paraphrase, original_text_retained_flag, source_url, posted_at,
          source_id, duplication_flag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING pick_id`,
      [
        input.slateDate,
        input.playerId,
        DB_MARKET[input.market],
        input.pickDirection,
        input.mechanismTags,
        summary.reasoningParaphrase,
        summary.originalTextRetainedFlag,
        sourceUrl,
        input.postedAt,
        input.sourceId,
        isLikelyCopy ? "IS_LIKELY_COPY" : "INDEPENDENT",
      ],
    );
    for (const edge of lineage) {
      await client.query(
        `INSERT INTO pick_duplication_lineage (pick_id, prior_pick_id, confidence, method)
         VALUES ($1, $2, $3, $4)`,
        [inserted.rows[0].pick_id, edge.priorPickId, edge.confidence, edge.method],
      );
    }
    await client.query("COMMIT");
    const pick = (await queryPickRows({ pickId: inserted.rows[0].pick_id }))[0];
    return { pick, lineageCreated: lineage.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}