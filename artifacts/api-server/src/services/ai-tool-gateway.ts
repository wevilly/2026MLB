import { pool } from "@workspace/db";
import { getBullpenRoom } from "./bullpen-foundation";
import { queryDailyMarketBoard } from "./daily-market-board";
import { queryFeatureStore } from "./feature-store";
import { getPitcherLab, getPlayerLab } from "./research-foundation";
import { querySettlements } from "./settlement";
import { queryBettorPicks } from "./bettor-intelligence";

const MARKET_VALUES = ["TB", "XBH", "WALK", "HR"] as const;
const RESEARCH_WINDOWS = ["SEASON", "CAREER", "ROLLING_7", "ROLLING_14", "ROLLING_30", "ROLLING_60"] as const;

type AiToolStatus = "SUCCESS" | "REJECTED" | "ERROR";
type ToolParameters = Record<string, unknown>;
type ToolDefinition = {
  toolName: string;
  description: string;
  dataSource: string;
  prohibitedActions: string[];
};

class AiToolValidationError extends Error {}
class LiveWebSearchProviderError extends Error {}

const DEFAULT_PROHIBITED_ACTIONS = [
  "No INSERT, UPDATE, DELETE, or DDL against internal platform tables.",
  "No prediction writes, model activation, settlement changes, or bettor-pick posting.",
  "No access to credentials, secrets, or raw session data.",
];

const ALLOWED_PARAMETER_KEYS: Record<string, string[]> = {
  READ_MARKET_BOARD: ["date", "market"],
  READ_FEATURE_SNAPSHOTS: ["playerId", "market", "dateFrom", "dateTo", "limit"],
  READ_SETTLEMENT_RECORDS: ["gamePk", "playerId", "market", "dateFrom", "dateTo"],
  READ_BETTOR_PICKS: ["date", "market"],
  READ_BULLPEN_STATE: ["date", "team"],
  READ_PLAYER_RESEARCH: ["playerId", "search", "window", "date"],
  READ_PITCHER_RESEARCH: ["playerId", "search", "window", "date"],
  LIVE_WEB_SEARCH: ["query", "limit"],
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    toolName: "READ_MARKET_BOARD",
    description: "Read the persisted daily market board for one slate date and optional market.",
    dataSource: "daily_market_board + market_research_candidates + model_versions",
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
  },
  {
    toolName: "READ_FEATURE_SNAPSHOTS",
    description: "Read immutable pregame feature snapshots using documented player, market, date, and limit filters.",
    dataSource: "pregame_feature_snapshots",
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
  },
  {
    toolName: "READ_SETTLEMENT_RECORDS",
    description: "Read terminal MLB-official settlement records using documented game, player, market, and date filters.",
    dataSource: "historical_outcomes (MLB_OFFICIAL terminal records)",
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
  },
  {
    toolName: "READ_BETTOR_PICKS",
    description: "Read source-attributed bettor picks with stored duplication lineage for one slate date.",
    dataSource: "bettor_picks + pick_duplication_lineage + bettor_sources",
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
  },
  {
    toolName: "READ_BULLPEN_STATE",
    description: "Read persisted bullpen availability state and freshness for one slate date and optional team.",
    dataSource: "bullpen_availability_observations + relief_appearance_log",
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
  },
  {
    toolName: "READ_PLAYER_RESEARCH",
    description: "Read canonical hitter research from the internal research foundation.",
    dataSource: "player research snapshots and normalized evidence",
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
  },
  {
    toolName: "READ_PITCHER_RESEARCH",
    description: "Read canonical pitcher research from the internal research foundation.",
    dataSource: "pitcher research snapshots and normalized evidence",
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
  },
  {
    toolName: "LIVE_WEB_SEARCH",
    description: "Run a bounded live public-web research search and return title, URL, and snippet results.",
    dataSource: "public web search adapter (DuckDuckGo HTML)",
    prohibitedActions: [
      ...DEFAULT_PROHIBITED_ACTIONS,
      "No fetching user-supplied URLs or submitting forms; only a fixed outbound search endpoint is used.",
    ],
  },
];

export type AiToolCallInput = {
  toolName: string;
  parameters: ToolParameters;
  sessionId: string;
  requestId: string;
};

export type AiToolCallResult = {
  callId: string;
  toolName: string;
  status: AiToolStatus;
  result: Record<string, unknown> | null;
  error: string | null;
};

export async function ensureAiToolRegistry() {
  for (const tool of TOOL_DEFINITIONS) {
    await pool.query(
      `INSERT INTO ai_tool_registry
         (tool_name, description, data_source, access_level, prohibited_actions, active)
       VALUES ($1, $2, $3, 'READ_ONLY', $4::jsonb, true)
       ON CONFLICT (tool_name) DO UPDATE SET
         description = EXCLUDED.description,
         data_source = EXCLUDED.data_source,
         access_level = EXCLUDED.access_level,
         prohibited_actions = EXCLUDED.prohibited_actions,
         updated_at = now()`,
      [tool.toolName, tool.description, tool.dataSource, JSON.stringify(tool.prohibitedActions)],
    );
  }
}

export async function queryAiToolRegistry() {
  await ensureAiToolRegistry();
  const result = await pool.query<{
    tool_name: string;
    description: string;
    data_source: string;
    access_level: "READ_ONLY";
    prohibited_actions: string[];
    active: boolean;
  }>(
    `SELECT tool_name, description, data_source, access_level, prohibited_actions, active
       FROM ai_tool_registry
      ORDER BY tool_name`,
  );
  return result.rows.map((row) => ({
    toolName: row.tool_name,
    description: row.description,
    dataSource: row.data_source,
    accessLevel: row.access_level,
    prohibitedActions: row.prohibited_actions,
    active: row.active,
  }));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requireDate(parameters: ToolParameters, key = "date") {
  const value = parameters[key];
  if (!isDate(value)) throw new AiToolValidationError(`${key} must be a real YYYY-MM-DD date`);
  return value;
}

function optionalDate(parameters: ToolParameters, key: string) {
  const value = parameters[key];
  if (value == null || value === "") return null;
  if (!isDate(value)) throw new AiToolValidationError(`${key} must be a real YYYY-MM-DD date`);
  return value;
}

function optionalPositiveInteger(parameters: ToolParameters, key: string) {
  const value = parameters[key];
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new AiToolValidationError(`${key} must be a positive integer`);
  return parsed;
}

function optionalMarket(parameters: ToolParameters) {
  const value = parameters.market;
  if (value == null || value === "") return null;
  const market = String(value).trim().toUpperCase();
  if (!MARKET_VALUES.includes(market as typeof MARKET_VALUES[number])) {
    throw new AiToolValidationError("market must be TB, XBH, WALK, or HR");
  }
  return market as typeof MARKET_VALUES[number];
}

function optionalResearchWindow(parameters: ToolParameters) {
  const value = parameters.window;
  if (value == null || value === "") return "SEASON";
  const window = String(value).trim().toUpperCase();
  if (!RESEARCH_WINDOWS.includes(window as typeof RESEARCH_WINDOWS[number])) {
    throw new AiToolValidationError("window must be SEASON, CAREER, ROLLING_7, ROLLING_14, ROLLING_30, or ROLLING_60");
  }
  return window as typeof RESEARCH_WINDOWS[number];
}

function optionalLimit(parameters: ToolParameters, fallback = 200, maximum = 500) {
  const value = parameters.limit;
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AiToolValidationError(`limit must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function summaryFor(result: Record<string, unknown>) {
  const data = result.data;
  const resultCount = Array.isArray(data)
    ? data.length
    : data && typeof data === "object" && "total" in data && typeof data.total === "number"
      ? data.total
      : null;
  return { resultCount, resultKeys: Object.keys(result).slice(0, 20) };
}

async function logToolCall(
  toolName: string,
  parameters: ToolParameters,
  sessionId: string,
  requestId: string,
  status: AiToolStatus,
  responseSummary: Record<string, unknown>,
  rejectionReason: string | null,
  toolDefinition: Record<string, unknown>,
) {
  const result = await pool.query<{ call_id: string }>(
    `INSERT INTO ai_tool_call_log
       (tool_name, parameters, response_summary, tool_definition, request_id, session_id, status, rejection_reason)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7, $8)
     RETURNING call_id`,
    [toolName, JSON.stringify(parameters), JSON.stringify(responseSummary), JSON.stringify(toolDefinition), requestId, sessionId, status, rejectionReason],
  );
  return result.rows[0].call_id;
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function outboundResultUrl(rawHref: string) {
  const decoded = rawHref.replace(/&amp;/g, "&");
  const base = new URL(decoded, "https://duckduckgo.com");
  const redirected = base.searchParams.get("uddg");
  const candidate = redirected ?? base.toString();
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.toString().length > 2048) return null;
  return parsed.toString();
}

async function readSearchHtml(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  const maxBytes = 1_000_000;
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new LiveWebSearchProviderError("live web search provider returned non-HTML content");
  }
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new LiveWebSearchProviderError("live web search provider response exceeded the size limit");
  }
  if (!response.body) throw new LiveWebSearchProviderError("live web search provider returned an empty response stream");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteCount += next.value.byteLength;
    if (byteCount > maxBytes) {
      await reader.cancel();
      throw new LiveWebSearchProviderError("live web search provider response exceeded the size limit");
    }
    chunks.push(next.value);
  }
  const payload = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(payload);
}

async function liveWebSearch(parameters: ToolParameters) {
  const query = typeof parameters.query === "string" ? parameters.query.trim() : "";
  if (query.length < 3 || query.length > 300) throw new AiToolValidationError("query must be between 3 and 300 characters");
  const count = optionalLimit(parameters, 5, 8);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "user-agent": "MLBAnalystResearch/1.0 (+https://replit.com)" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new LiveWebSearchProviderError(`live web search provider returned HTTP ${response.status}`);
  const html = await readSearchHtml(response);
  const matches = [...html.matchAll(
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,2000}?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/g,
  )];
  const results = matches.slice(0, count).flatMap((match) => {
    try {
      const url = outboundResultUrl(match[1]);
      if (!url) return [];
      return [{ title: stripHtml(match[2]).slice(0, 300), url, snippet: stripHtml(match[3]).slice(0, 700) }];
    } catch {
      return [];
    }
  });
  return { data: { query, provider: "DuckDuckGo HTML", results } };
}

async function executeReadTool(toolName: string, parameters: ToolParameters): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "READ_MARKET_BOARD": {
      const date = requireDate(parameters);
      const market = optionalMarket(parameters);
      return { data: await queryDailyMarketBoard(date, market) };
    }
    case "READ_FEATURE_SNAPSHOTS":
      return {
        data: await queryFeatureStore({
          playerId: optionalPositiveInteger(parameters, "playerId"),
          market: optionalMarket(parameters),
          dateFrom: optionalDate(parameters, "dateFrom"),
          dateTo: optionalDate(parameters, "dateTo"),
          limit: optionalLimit(parameters),
        }),
      };
    case "READ_SETTLEMENT_RECORDS":
      return {
        data: await querySettlements({
          gamePk: optionalPositiveInteger(parameters, "gamePk"),
          playerId: optionalPositiveInteger(parameters, "playerId"),
          market: optionalMarket(parameters),
          dateFrom: optionalDate(parameters, "dateFrom"),
          dateTo: optionalDate(parameters, "dateTo"),
        }),
      };
    case "READ_BETTOR_PICKS": {
      const date = requireDate(parameters);
      return { data: await queryBettorPicks({ date, market: optionalMarket(parameters) }) };
    }
    case "READ_BULLPEN_STATE": {
      const date = requireDate(parameters);
      const team = parameters.team == null ? undefined : String(parameters.team).trim().toUpperCase();
      if (team !== undefined && !/^[A-Z]{2,5}$/.test(team)) throw new AiToolValidationError("team must be a 2–5 letter abbreviation");
      return { data: await getBullpenRoom(date, team) };
    }
    case "READ_PLAYER_RESEARCH":
      return {
        data: await getPlayerLab(
          optionalPositiveInteger(parameters, "playerId"),
          parameters.search == null ? "" : String(parameters.search).trim().slice(0, 160),
          optionalResearchWindow(parameters),
          requireDate(parameters),
        ),
      };
    case "READ_PITCHER_RESEARCH":
      return {
        data: await getPitcherLab(
          optionalPositiveInteger(parameters, "playerId"),
          parameters.search == null ? "" : String(parameters.search).trim().slice(0, 160),
          optionalResearchWindow(parameters),
          requireDate(parameters),
        ),
      };
    case "LIVE_WEB_SEARCH":
      return liveWebSearch(parameters);
    default:
      throw new AiToolValidationError("tool is not registered for execution");
  }
}

function validateParameterKeys(toolName: string, parameters: ToolParameters) {
  const allowed = ALLOWED_PARAMETER_KEYS[toolName] ?? [];
  const unexpected = Object.keys(parameters).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new AiToolValidationError(
      `Unsupported parameter(s) for ${toolName}: ${unexpected.join(", ")}. Tool calls may not include actions or write instructions.`,
    );
  }
}

export async function rejectAiToolCall(input: AiToolCallInput, error: string): Promise<AiToolCallResult> {
  const callId = await logToolCall(
    input.toolName,
    input.parameters,
    input.sessionId,
    input.requestId,
    "REJECTED",
    { error },
    error,
    {},
  );
  return { callId, toolName: input.toolName, status: "REJECTED", result: null, error };
}

export async function executeAiToolCall(input: AiToolCallInput): Promise<AiToolCallResult> {
  await ensureAiToolRegistry();
  const registry = await pool.query<{
    tool_name: string; description: string; data_source: string; access_level: string; prohibited_actions: string[]; active: boolean;
  }>(
    `SELECT tool_name, description, data_source, access_level, prohibited_actions, active FROM ai_tool_registry WHERE tool_name = $1`,
    [input.toolName],
  );
  const tool = registry.rows[0];
  if (!tool || !tool.active || tool.access_level !== "READ_ONLY") {
    const error = `Tool '${input.toolName}' is not an active READ_ONLY tool. Write operations are prohibited.`;
    const callId = await logToolCall(input.toolName, input.parameters, input.sessionId, input.requestId, "REJECTED", { error }, error, {});
    return { callId, toolName: input.toolName, status: "REJECTED", result: null, error };
  }
  const toolDefinition = {
    description: tool.description,
    dataSource: tool.data_source,
    accessLevel: tool.access_level,
    prohibitedActions: tool.prohibited_actions,
  };

  try {
    validateParameterKeys(input.toolName, input.parameters);
    const result = await executeReadTool(input.toolName, input.parameters);
    const callId = await logToolCall(input.toolName, input.parameters, input.sessionId, input.requestId, "SUCCESS", summaryFor(result), null, toolDefinition);
    return { callId, toolName: input.toolName, status: "SUCCESS", result, error: null };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "Tool execution failed";
    const status: AiToolStatus = caught instanceof AiToolValidationError ? "REJECTED" : "ERROR";
    const callId = await logToolCall(input.toolName, input.parameters, input.sessionId, input.requestId, status, { error }, error, toolDefinition);
    return { callId, toolName: input.toolName, status, result: null, error };
  }
}