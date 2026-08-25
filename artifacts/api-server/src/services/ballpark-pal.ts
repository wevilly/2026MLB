import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

/**
 * Daily-only Ballpark Pal adapter.
 *
 * The provider also exposes probabilities, implied odds, sportsbook-like model
 * prices, and fantasy scoring. This adapter never calls the probability or
 * matchup endpoints and removes fantasy fields before raw-payload retention.
 */
const SOURCE_ID = "BALLPARK_PAL";
const BASE_URL = "https://www.ballparkpal.com/api/v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? value
  : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
type Json = Record<string, unknown>;

type ProviderGame = {
  gameId: number;
  venueId: number | null;
  awayTeamId: number | null;
  homeTeamId: number | null;
  gamePk: number | null;
};

function apiKey() {
  const key = process.env.bpp_live;
  if (!key) throw new Error("Ballpark Pal is not configured: bpp_live secret is required.");
  return key;
}

async function request(path: string) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { accept: "application/json", "x-api-key": apiKey() },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (payload as Json).error === "object" && (payload as Json).error
      ? String(((payload as Json).error as Json).message ?? "provider error")
      : `HTTP ${response.status}`;
    throw new Error(`Ballpark Pal ${path} failed: ${message}`);
  }
  return { status: response.status, payload: payload as Json };
}

function array(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object") : [];
}

function envelopeData(payload: Json) {
  return payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data as Json : {};
}

function responseRows(payload: Json, key?: string) {
  const data = envelopeData(payload);
  return array(key ? data[key] : data.items ?? payload.items ?? payload.data);
}

function safeGame(row: Json): ProviderGame | null {
  const gameId = number(row.gameId);
  if (!gameId) return null;
  return {
    gameId,
    venueId: number(row.venueId),
    awayTeamId: number(row.teamAwayId),
    homeTeamId: number(row.teamHomeId),
    gamePk: null,
  };
}

function permittedBatters(rows: Json[]) {
  return rows.map((row) => ({
    playerId: number(row.playerId),
    teamId: number(row.teamId),
    playerName: typeof row.playerName === "string" ? row.playerName : null,
    battingPosition: number(row.battingPosition),
    plateAppearances: number(row.plateAppearances),
    atBats: number(row.atBats),
    singles: number(row.singles),
    doubles: number(row.doubles),
    triples: number(row.triples),
    homeRuns: number(row.homeRuns),
    hits: number(row.hits),
    totalBases: number(row.totalBases),
    rbis: number(row.rbis),
    runs: number(row.runs),
    walks: number(row.walks),
    strikeouts: number(row.strikeouts),
  })).filter((row) => row.playerId !== null);
}

function permittedPitchers(rows: Json[]) {
  return rows.map((row) => ({
    playerId: number(row.playerId),
    teamId: number(row.teamId),
    playerName: typeof row.playerName === "string" ? row.playerName : null,
    isStarter: row.isStarter === true,
    innings: number(row.innings),
    battersFaced: number(row.battersFaced),
    strikeouts: number(row.strikeouts),
    walks: number(row.walks),
    hitsAllowed: number(row.hitsAllowed),
    homeRunsAllowed: number(row.homeRunsAllowed),
    runsAllowed: number(row.runsAllowed),
  })).filter((row) => row.playerId !== null);
}

function permittedParkRows(rows: Json[]) {
  return rows.map((row) => ({
    gameId: number(row.gameId),
    venueId: number(row.venueId),
    runsPercent: number(row.runsPercent),
    homeRunsPercent: number(row.homeRunsPercent),
    doublesTriplesPercent: number(row.doublesTriplesPercent),
    singlesPercent: number(row.singlesPercent),
  })).filter((row) => row.gameId !== null);
}

async function storeRaw(ingestRunId: string, effectiveDate: string, payloadType: string, endpoint: string, payload: Json) {
  const body = JSON.stringify(payload);
  const result = await pool.query<{ raw_payload_id: string }>(
    `INSERT INTO raw_payloads (ingest_run_id, source_id, payload_type, effective_date, checksum, byte_count, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING raw_payload_id`,
    [ingestRunId, SOURCE_ID, payloadType, effectiveDate, hash(payload), Buffer.byteLength(body), {
      endpoint,
      provider: "Ballpark Pal API v1",
      retainedFieldPolicy: "daily counting-stat averages and park multipliers only; probabilities, odds, implied odds, matchup probabilities, and fantasy fields are excluded before retention",
      payload,
    }],
  );
  return result.rows[0].raw_payload_id;
}

async function existingPlayer(playerId: number) {
  const result = await pool.query(`SELECT 1 FROM players WHERE player_id = $1`, [playerId]);
  return Boolean(result.rowCount);
}

async function persistHitter(ingestRunId: string, rawPayloadId: string, effectiveDate: string, gamePk: number, row: ReturnType<typeof permittedBatters>[number]) {
  if (row.playerId === null || !await existingPlayer(row.playerId)) return false;
  const pa = row.plateAppearances;
  const ab = row.atBats;
  const xbh = [row.doubles, row.triples, row.homeRuns].every((value) => value !== null)
    ? (row.doubles ?? 0) + (row.triples ?? 0) + (row.homeRuns ?? 0) : null;
  const metrics: Array<[string, string, string, number | null, string, string]> = [
    ["opportunity", "pa", "Projected plate appearances", pa, "PA", "Ballpark Pal daily simulated average plate appearances."],
    ["opportunity", "ab", "Projected at bats", ab, "AB", "Ballpark Pal daily simulated average at bats."],
    ["core_offense", "avg", "Projected batting average", row.hits !== null && ab ? row.hits / ab : null, "rate", "Derived from permitted Ballpark Pal daily simulated hits and at bats."],
    ["core_offense", "slg", "Projected slugging", row.totalBases !== null && ab ? row.totalBases / ab : null, "rate", "Derived from permitted Ballpark Pal daily simulated total bases and at bats."],
    ["core_offense", "total_bases", "Projected total bases", row.totalBases, "count", "Ballpark Pal daily simulated average total bases."],
    ["xbh", "doubles", "Projected doubles", row.doubles, "count", "Ballpark Pal daily simulated average."],
    ["xbh", "triples", "Projected triples", row.triples, "count", "Ballpark Pal daily simulated average."],
    ["xbh", "home_runs", "Projected home runs", row.homeRuns, "count", "Ballpark Pal daily simulated average."],
    ["xbh", "xbh", "Projected extra-base hits", xbh, "count", "Derived as permitted doubles + triples + home runs."],
    ["xbh", "xbh_per_pa", "Projected XBH per PA", xbh !== null && pa ? xbh / pa : null, "rate", "Derived from permitted Ballpark Pal daily counting-stat averages."],
    ["discipline", "bb_percent", "Projected walk rate", row.walks !== null && pa ? (row.walks / pa) * 100 : null, "%", "Derived from permitted Ballpark Pal daily simulated walks and plate appearances."],
  ];
  const checksum = hash({ effectiveDate, row, metrics });
  const snapshot = await pool.query<{ research_snapshot_id: string }>(
    `INSERT INTO player_research_snapshots
     (player_id,source_id,ingest_run_id,raw_payload_id,research_window,effective_from,effective_to,sample_size,denominator_type,denominator,content_checksum,provenance)
     VALUES ($1,$2,$3,$4,'SEASON',$5,$5,$6,'PROJECTED_PA',$7,$8,$9) RETURNING research_snapshot_id`,
    [row.playerId, SOURCE_ID, ingestRunId, rawPayloadId, effectiveDate, pa === null ? null : Math.round(pa), pa, checksum, {
      provider: "Ballpark Pal API v1", effectiveDate, gamePk, coverage: "DAILY_ONLY",
      unavailableMetrics: ["xBA", "xSLG", "xwOBA", "exit velocity", "barrel rate", "pitch mix", "historical splits"],
    }],
  );
  for (const [family, key, label, value, unit, definition] of metrics) {
    await pool.query(
      `INSERT INTO player_research_features
       (research_snapshot_id,family,metric_key,metric_label,value,unit,denominator,sample_size,transformation,sample_status,definition,provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DERIVED',$9,$10,$11)`,
      [snapshot.rows[0].research_snapshot_id, family, key, label, value, unit, pa, pa === null ? null : Math.round(pa),
        value === null ? "NOT_FOUND" : "AVAILABLE", definition, { provider: "Ballpark Pal API v1", sourceFieldPolicy: "permitted_daily_average" }],
    );
  }
  return true;
}

async function persistPitcher(ingestRunId: string, rawPayloadId: string, effectiveDate: string, gamePk: number, row: ReturnType<typeof permittedPitchers>[number]) {
  if (row.playerId === null || !await existingPlayer(row.playerId)) return false;
  const bf = row.battersFaced;
  const metrics: Array<[string, string, string, number | null, string, string]> = [
    ["workload", "bf", "Projected batters faced", bf, "BF", "Ballpark Pal daily simulated average batters faced."],
    ["command", "bb_percent", "Projected walk rate", row.walks !== null && bf ? (row.walks / bf) * 100 : null, "%", "Derived from permitted Ballpark Pal daily simulated walks and batters faced."],
    ["xbh_vulnerability", "home_runs_allowed", "Projected home runs allowed", row.homeRunsAllowed, "count", "Ballpark Pal daily simulated average."],
  ];
  const checksum = hash({ effectiveDate, row, metrics });
  const snapshot = await pool.query<{ research_snapshot_id: string }>(
    `INSERT INTO pitcher_research_snapshots
     (player_id,source_id,ingest_run_id,raw_payload_id,research_window,role,effective_from,effective_to,sample_size,denominator_type,denominator,content_checksum,provenance)
     VALUES ($1,$2,$3,$4,'SEASON',$5,$6,$6,$7,'PROJECTED_BF',$8,$9,$10) RETURNING research_snapshot_id`,
    [row.playerId, SOURCE_ID, ingestRunId, rawPayloadId, row.isStarter ? "STARTER" : "MIXED", effectiveDate, bf === null ? null : Math.round(bf), bf, checksum, {
      provider: "Ballpark Pal API v1", effectiveDate, gamePk, coverage: "DAILY_ONLY",
      unavailableMetrics: ["xSLG allowed", "xwOBA allowed", "barrel rate", "pitch arsenal", "historical splits"],
    }],
  );
  for (const [family, key, label, value, unit, definition] of metrics) {
    await pool.query(
      `INSERT INTO pitcher_research_features
       (research_snapshot_id,family,metric_key,metric_label,value,unit,denominator,sample_size,transformation,sample_status,definition,provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DERIVED',$9,$10,$11)`,
      [snapshot.rows[0].research_snapshot_id, family, key, label, value, unit, bf, bf === null ? null : Math.round(bf),
        value === null ? "NOT_FOUND" : "AVAILABLE", definition, { provider: "Ballpark Pal API v1", sourceFieldPolicy: "permitted_daily_average" }],
    );
  }
  return true;
}

async function persistPark(ingestRunId: string, rawPayloadId: string, effectiveDate: string, gameId: number, row: ReturnType<typeof permittedParkRows>[number], games: Map<number, ProviderGame>) {
  const providerGame = games.get(gameId);
  if (!providerGame?.gamePk) return false;
  const venueId = providerGame?.venueId ?? row.venueId;
  if (!venueId) return false;
  const venue = await pool.query(`SELECT 1 FROM venues WHERE venue_id = $1`, [venueId]);
  if (!venue.rowCount) return false;
  const components: Array<[string, string, number | null]> = [
    ["hits_factor", "Singles factor", row.singlesPercent],
    ["doubles_factor", "Doubles/triples factor", row.doublesTriplesPercent],
    ["hr_factor", "Home run factor", row.homeRunsPercent],
  ];
  const checksum = hash({ effectiveDate, gameId, venueId, components });
  const snapshot = await pool.query<{ park_research_snapshot_id: string }>(
    `INSERT INTO park_research_snapshots (venue_id,source_id,ingest_run_id,raw_payload_id,season,span,content_checksum,provenance)
     VALUES ($1,$2,$3,$4,$5,'DAILY_GAME_CONTEXT',$6,$7) RETURNING park_research_snapshot_id`,
    [venueId, SOURCE_ID, ingestRunId, rawPayloadId, Number(effectiveDate.slice(0, 4)), checksum, {
      provider: "Ballpark Pal API v1", effectiveDate, gameId, gamePk: providerGame.gamePk,
      definition: "Daily modeled park multiplier. Source percent is normalized to a 100-neutral index for engine compatibility.",
    }],
  );
  for (const [key, label, percent] of components) {
    const value = percent === null ? null : 100 + percent;
    await pool.query(
      `INSERT INTO park_research_features
       (park_research_snapshot_id,metric_key,metric_label,value,batter_side,transformation,sample_status,definition,provenance)
       VALUES ($1,$2,$3,$4,NULL,'NORMALIZED',$5,$6,$7)`,
      [snapshot.rows[0].park_research_snapshot_id, key, label, value, value === null ? "NOT_FOUND" : "AVAILABLE",
        "Ballpark Pal daily game-level percent normalized to a 100-neutral index; it is not a historical Statcast factor.",
        { provider: "Ballpark Pal API v1", sourcePercent: percent, gameId, gamePk: providerGame.gamePk }],
    );
  }
  return true;
}

export async function ingestBallparkPalResearch(effectiveDate: string) {
  await pool.query(
    `INSERT INTO source_registry (source_id,name,source_type,base_url,expected_freshness_minutes,notes)
     VALUES ($1,'Ballpark Pal','RESEARCH',$2,180,'Daily-only API context. Permitted fields: daily simulated counting-stat averages and park multipliers. Probabilities, odds, implied odds, matchup probabilities, fantasy fields, pitch-level and historical fields are unavailable.')
     ON CONFLICT (source_id) DO UPDATE SET name=EXCLUDED.name, source_type=EXCLUDED.source_type, base_url=EXCLUDED.base_url, expected_freshness_minutes=EXCLUDED.expected_freshness_minutes, notes=EXCLUDED.notes`,
    [SOURCE_ID, BASE_URL],
  );
  const started = Date.now();
  const run = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id,job_name,status,effective_date,metadata)
     VALUES ($1,'ballpark_pal_daily_research','RUNNING',$2,$3) RETURNING ingest_run_id`,
    [SOURCE_ID, effectiveDate, { provider: "Ballpark Pal API v1", dailyOnly: true, prohibitedEndpoints: ["/projections/probabilities", "/matchups", "/matchups/predict"] }],
  );
  const ingestRunId = run.rows[0].ingest_run_id;
  let rowCount = 0;
  let normalized = 0;
  let rejected = 0;
  let httpStatus = 200;
  try {
    const gamesResponse = await request(`/games?date=${encodeURIComponent(effectiveDate)}`);
    httpStatus = gamesResponse.status;
    const games = responseRows(gamesResponse.payload).map(safeGame).filter((game): game is ProviderGame => game !== null);
    for (const game of games) {
      const canonical = await pool.query<{ game_pk: number }>(
        `SELECT game_pk FROM games WHERE game_date = $1 AND away_team_id = $2 AND home_team_id = $3
         ORDER BY game_pk LIMIT 1`,
        [effectiveDate, game.awayTeamId, game.homeTeamId],
      );
      game.gamePk = canonical.rows[0]?.game_pk ?? null;
    }
    const gameMap = new Map(games.map((game) => [game.gameId, game]));
    const gamesRaw = await storeRaw(ingestRunId, effectiveDate, "ballpark_pal_games_filtered", `/games?date=${effectiveDate}`, {
      games: games.map((game) => ({ gameId: game.gameId, gamePk: game.gamePk, venueId: game.venueId })),
    });
    rowCount += games.length;
    const parkResponse = await request(`/parkfactors?date=${encodeURIComponent(effectiveDate)}`);
    httpStatus = parkResponse.status;
    const parks = permittedParkRows(responseRows(parkResponse.payload));
    const parkRaw = await storeRaw(ingestRunId, effectiveDate, "ballpark_pal_park_factors_filtered", `/parkfactors?date=${effectiveDate}`, { parks });
    for (const park of parks) {
      if (await persistPark(ingestRunId, parkRaw, effectiveDate, park.gameId!, park, gameMap)) normalized += 1;
      else rejected += 1;
    }
    const batchSize = 4;
    for (let index = 0; index < games.length; index += batchSize) {
      const batch = games.slice(index, index + batchSize);
      const responses = await Promise.all(batch.map(async (game) => ({ game, response: await request(`/projections/averages?gameId=${game.gameId}`) })));
      for (const { game, response } of responses) {
        httpStatus = response.status;
        const data = envelopeData(response.payload);
        const batters = permittedBatters(responseRows(response.payload, "batters"));
        const pitchers = permittedPitchers(responseRows(response.payload, "pitchers"));
        const rawPayloadId = await storeRaw(ingestRunId, effectiveDate, "ballpark_pal_projection_averages_filtered", `/projections/averages?gameId=${game.gameId}`, {
          gameId: game.gameId, gamePk: game.gamePk, batters, pitchers,
        });
        if (!game.gamePk) {
          rejected += batters.length + pitchers.length;
          continue;
        }
        rowCount += batters.length + pitchers.length;
        for (const batter of batters) {
          if (await persistHitter(ingestRunId, rawPayloadId, effectiveDate, game.gamePk, batter)) normalized += 1;
          else rejected += 1;
        }
        for (const pitcher of pitchers) {
          if (await persistPitcher(ingestRunId, rawPayloadId, effectiveDate, game.gamePk, pitcher)) normalized += 1;
          else rejected += 1;
        }
      }
    }
    const status = rowCount === 0 ? "PARTIAL" : rejected ? "PARTIAL" : "SUCCESS";
    const noDataNote = rowCount === 0
      ? "Ballpark Pal returned no daily records for the requested date. Daily-only provider data is unavailable rather than backfilled from retired sources."
      : null;
    await pool.query(
      `UPDATE ingest_runs SET status=$2,finished_at=now(),row_count=$3,normalized_row_count=$4,rejected_row_count=$5,http_status=$6,duration_ms=$7,metadata=metadata || $8::jsonb WHERE ingest_run_id=$1`,
      [ingestRunId, status, rowCount, normalized, rejected, httpStatus, Date.now() - started, JSON.stringify({ gameReceiptRawPayloadId: gamesRaw, rawPayloadsFiltered: true, noData: rowCount === 0 })],
    );
    return {
      status: status as "SUCCESS" | "PARTIAL",
      sources: [{ source: "Ballpark Pal", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, status, error: noDataNote }],
      quarantinedRows: 0,
      notes: [
        "Ballpark Pal daily-only counting-stat averages and park multipliers were retained with filtered raw-payload lineage.",
        "Probabilities, odds, implied odds, matchup probability fields, fantasy fields, pitch-level metrics, expected stats, and historical projections were excluded or marked unavailable.",
        ...noDataNote ? [noDataNote] : [],
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE ingest_runs SET status='FAILED',finished_at=now(),row_count=$2,normalized_row_count=$3,rejected_row_count=$4,http_status=$5,duration_ms=$6,error_message=$7 WHERE ingest_run_id=$1`,
      [ingestRunId, rowCount, normalized, rejected, httpStatus, Date.now() - started, message],
    );
    return { status: "FAILED" as const, sources: [{ source: "Ballpark Pal", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, status: "FAILED", error: message }], quarantinedRows: 0, notes: [message] };
  }
}

export const BALLPARK_PAL_SOURCE_ID = SOURCE_ID;