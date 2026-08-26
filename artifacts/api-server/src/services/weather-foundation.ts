/**
 * Weather foundation.
 *
 * Before this service there was no weather ingestion, no weather table, no
 * weather feature, and no weather term in any scoring function. The word did
 * not appear in the engines: a 34 degree game with a 15 mph wind blowing in
 * ranked identically to a 78 degree game with the same wind blowing out.
 *
 * Built on the same pattern as bullpen-foundation: ingest per-game forecast,
 * persist observations with a REAL source freshness timestamp taken from the
 * upstream forecast rather than from now(), and expose a getGameWeather
 * accessor. Failures are logged and counted, never swallowed, per task 3.5,
 * from the first day this service exists.
 *
 * Wind direction is the load-bearing field. Wind speed alone is not usable.
 */
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

export const WEATHER_SOURCE = "OPEN_METEO";
export const FANTASYPROS_WEATHER_SOURCE = "FANTASYPROS";
const WEATHER_SOURCE_TYPE = "WEATHER";
const WEATHER_BASE = "https://api.open-meteo.com/v1/forecast";
const MLB_VENUE_BASE = "https://statsapi.mlb.com/api/v1/venues";

type JsonObject = Record<string, unknown>;
type N = number | null;

export type WeatherIngestFailure = { scope: string; detail: string; fatal: boolean };

function recordFailure(failures: WeatherIngestFailure[], scope: string, error: unknown, fatal = false) {
  const detail = error instanceof Error ? error.message : String(error);
  failures.push({ scope, detail, fatal });
  logger.error({ scope, detail, fatal }, "weather ingest failure");
  return detail;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): N {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

// ── Pure wind geometry ────────────────────────────────────────────────────────

export type WindComponent = "OUT" | "IN" | "CROSS" | "CALM" | "UNKNOWN";

/** Below this a wind has no usable direction. */
export const CALM_WIND_MPH = 3;
/** Below this fraction of the wind speed, the along-field component is a crosswind. */
const CROSSWIND_FRACTION = 0.35;

export type WindResolution = {
  outComponentMph: N;
  component: WindComponent;
  relativeDegrees: N;
};

/**
 * Resolves a wind against the park's orientation.
 *
 * windFromDegrees follows the meteorological convention: the compass bearing
 * the wind is coming FROM. parkBearingDegrees is the bearing from home plate to
 * centre field. A wind blowing OUT to centre therefore comes FROM
 * parkBearing + 180, which is where the sign comes from.
 */
export function resolveWind(
  windSpeedMph: N,
  windFromDegrees: N,
  parkBearingDegrees: N,
): WindResolution {
  if (windSpeedMph === null) return { outComponentMph: null, component: "UNKNOWN", relativeDegrees: null };
  if (windSpeedMph < CALM_WIND_MPH) return { outComponentMph: 0, component: "CALM", relativeDegrees: null };
  if (windFromDegrees === null || parkBearingDegrees === null) {
    // Speed without a usable direction is not usable at all. Saying UNKNOWN is
    // the honest answer; guessing a sign is not.
    return { outComponentMph: null, component: "UNKNOWN", relativeDegrees: null };
  }
  const blowingOutFrom = (parkBearingDegrees + 180) % 360;
  const delta = (((windFromDegrees - blowingOutFrom) % 360) + 540) % 360 - 180;
  const outComponentMph = windSpeedMph * Math.cos((delta * Math.PI) / 180);
  const component: WindComponent = Math.abs(outComponentMph) < windSpeedMph * CROSSWIND_FRACTION
    ? "CROSS"
    : outComponentMph > 0 ? "OUT" : "IN";
  return {
    outComponentMph: Number(outComponentMph.toFixed(4)),
    component,
    relativeDegrees: Number(delta.toFixed(2)),
  };
}

// ── Per-market response ───────────────────────────────────────────────────────

export type WeatherMarket = "TB" | "XBH" | "WALK" | "HR";

/**
 * Weather coefficients, per market.
 *
 * Suppression that is correct for total bases and home runs is not correct for
 * walks, which are largely indifferent to wind and cold, so each market has its
 * own coefficients rather than one shared curve applied everywhere.
 *
 *   windOutPerMph        points per mph of wind blowing out to centre
 *   temperaturePerDegree points per degree Fahrenheit above the reference
 *   maxAdjustment        hard cap, in both directions
 *
 * Every cap is strictly below the pitcher matchup term's maximum of 3 points.
 * These are hand-specified starting values, not fitted quantities: once the
 * modelling layer works they are candidates to be learned.
 */
export const REFERENCE_TEMPERATURE_F = 70;
export const MARKET_WEATHER_COEFFICIENTS: Record<WeatherMarket, {
  windOutPerMph: number;
  temperaturePerDegree: number;
  maxAdjustment: number;
}> = {
  HR: { windOutPerMph: 0.070, temperaturePerDegree: 0.020, maxAdjustment: 2.0 },
  TB: { windOutPerMph: 0.045, temperaturePerDegree: 0.013, maxAdjustment: 1.5 },
  XBH: { windOutPerMph: 0.050, temperaturePerDegree: 0.014, maxAdjustment: 1.5 },
  // Walks are largely indifferent to wind and temperature. The coefficients are
  // deliberately near zero rather than absent, so the market carries a weather
  // term that says so instead of inheriting another market's.
  WALK: { windOutPerMph: 0.004, temperaturePerDegree: 0.002, maxAdjustment: 0.3 },
};

/** Extremes are flagged, not scored linearly: their effect is not linear. */
export const EXTREME_COLD_F = 45;
export const STRONG_WIND_MPH = 12;

export type WeatherEnvironment = "OPEN_AIR" | "CLOSED_ROOF" | "UNKNOWN";

export type GameWeather = {
  gamePk: number;
  venueId: number | null;
  temperatureF: N;
  windSpeedMph: N;
  windDirectionDegrees: N;
  windOutComponentMph: N;
  windComponent: WindComponent;
  roofState: string;
  weatherNeutral: boolean;
  environment: WeatherEnvironment;
  sourceId: string;
  sourceFreshness: string | null;
  retrievedAt: string | null;
  forecastForUtc: string | null;
};

/** Human-readable provenance for a stored observation's source_id. */
export function weatherSourceLabel(sourceId: string): string {
  if (sourceId === FANTASYPROS_WEATHER_SOURCE) return "FantasyPros";
  if (sourceId === WEATHER_SOURCE) return "Open-Meteo";
  return sourceId;
}

/**
 * Roof label for a game card. Prefers the stored observation's roof state;
 * falls back to the venue's roof type; says "Roof unknown" only when neither
 * exists. Never the bare string "NOT FOUND".
 */
export function formatRoofLabel(weather: GameWeather | null, venueRoofType: string | null): string {
  const roofState = weather?.roofState?.toUpperCase();
  if (roofState === "CLOSED") return "Roof closed";
  if (roofState === "OPEN") return "Roof open";
  if (roofState === "NONE") return "Open air";
  const roofType = venueRoofType?.toUpperCase();
  if (roofType === "DOME") return "Dome";
  if (roofType === "RETRACTABLE") return "Retractable roof";
  if (roofType === "OPEN") return "Open air";
  return "Roof unknown";
}

/**
 * One-line weather summary for a game card, sourced from the stored preferred
 * observation. An "unavailable" wording is used only when the database truly
 * has no usable observation for the game; a dome is neutral, not missing.
 */
export function formatWeatherSummary(weather: GameWeather | null): string {
  if (!weather) return "No stored weather observation";
  if (weather.weatherNeutral) {
    return `Roof ${weather.roofState.toLowerCase()} · weather neutral · ${weatherSourceLabel(weather.sourceId)}`;
  }
  const parts: string[] = [];
  if (weather.temperatureF !== null) parts.push(`${Math.round(weather.temperatureF)}°F`);
  if (weather.windSpeedMph !== null) {
    const speed = `${Math.round(weather.windSpeedMph)} mph`;
    switch (weather.windComponent) {
      case "OUT": parts.push(`wind out ${speed}`); break;
      case "IN": parts.push(`wind in ${speed}`); break;
      case "CROSS": parts.push(`crosswind ${speed}`); break;
      case "CALM": parts.push("calm wind"); break;
      default: parts.push(`wind ${speed}`);
    }
  }
  if (!parts.length) return `Observation stored without usable temperature or wind · ${weatherSourceLabel(weather.sourceId)}`;
  return `${parts.join(" · ")} · ${weatherSourceLabel(weather.sourceId)}`;
}

export type WeatherAdjustment = {
  adjustment: number;
  flags: string[];
  environment: WeatherEnvironment;
  detail: string;
};

/**
 * The bounded weather term for one market, plus the extreme flags.
 *
 * A closed roof is NEUTRAL: a zero adjustment with no flags, and an environment
 * that says why. Missing weather is UNKNOWN: also a zero adjustment, but
 * distinguishable in the evidence from a dome.
 */
export function weatherAdjustment(market: WeatherMarket, weather: GameWeather | null): WeatherAdjustment {
  if (!weather) {
    return { adjustment: 0, flags: [], environment: "UNKNOWN", detail: "No weather observation for this game." };
  }
  if (weather.weatherNeutral) {
    return {
      adjustment: 0,
      flags: [],
      environment: "CLOSED_ROOF",
      detail: `Roof ${weather.roofState.toLowerCase()}: weather is neutral, not missing.`,
    };
  }
  const coefficients = MARKET_WEATHER_COEFFICIENTS[market];
  const flags: string[] = [];

  const temperature = weather.temperatureF;
  const wind = weather.windOutComponentMph;

  if (temperature !== null && temperature <= EXTREME_COLD_F) flags.push("EXTREME_COLD");
  if (wind !== null && wind <= -STRONG_WIND_MPH) flags.push("STRONG_WIND_IN");
  if (wind !== null && wind >= STRONG_WIND_MPH) flags.push("STRONG_WIND_OUT");

  if (temperature === null && wind === null) {
    return {
      adjustment: 0,
      flags,
      environment: "UNKNOWN",
      detail: "Weather observation exists but carries neither a usable temperature nor a usable wind direction.",
    };
  }

  // The linear term is clamped at the extremes: beyond them the effect is
  // carried by the flags, which are counter-evidence and are not linear.
  const clampedWind = wind === null
    ? 0
    : Math.max(-STRONG_WIND_MPH, Math.min(STRONG_WIND_MPH, wind));
  const clampedTemperature = temperature === null
    ? REFERENCE_TEMPERATURE_F
    : Math.max(EXTREME_COLD_F, temperature);

  const raw = clampedWind * coefficients.windOutPerMph
    + (clampedTemperature - REFERENCE_TEMPERATURE_F) * coefficients.temperaturePerDegree;
  const adjustment = Math.max(
    -coefficients.maxAdjustment,
    Math.min(coefficients.maxAdjustment, raw),
  );
  return {
    adjustment: Number(adjustment.toFixed(4)),
    flags,
    environment: "OPEN_AIR",
    detail: `${temperature ?? "unknown"}F, wind ${weather.windComponent.toLowerCase()} `
      + `${wind === null ? "unknown" : Math.abs(wind).toFixed(1)} mph along centre field.`,
  };
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

/**
 * Hydrates venue coordinates, roof type and field orientation from the MLB
 * Stats API. A forecast cannot be requested without coordinates, and the wind
 * sign cannot be resolved without the orientation.
 */
export async function ingestVenueGeography(
  venueIds: number[],
  failures: WeatherIngestFailure[],
): Promise<number> {
  if (!venueIds.length) return 0;
  let updated = 0;
  try {
    const url = `${MLB_VENUE_BASE}?venueIds=${venueIds.join(",")}&hydrate=location,fieldInfo`;
    const response = await fetch(url);
    if (!response.ok) {
      recordFailure(failures, "venues", new Error(`MLB venues endpoint returned HTTP ${response.status}`), true);
      return 0;
    }
    const payload = await response.json() as JsonObject;
    for (const entry of asArray(payload.venues)) {
      const venue = asObject(entry);
      const venueId = asNumber(venue.id);
      if (venueId === null) continue;
      const location = asObject(venue.location);
      const coordinates = asObject(location.defaultCoordinates);
      const fieldInfo = asObject(venue.fieldInfo);
      const roofType = String(fieldInfo.roofType ?? "").trim().toUpperCase() || null;
      const orientation = asNumber(location.azimuthAngle);
      await pool.query(
        `UPDATE venues
            SET latitude = COALESCE($2, latitude),
                longitude = COALESCE($3, longitude),
                orientation_degrees = COALESCE($4, orientation_degrees),
                roof_type = COALESCE($5, roof_type)
          WHERE venue_id = $1`,
        [venueId, asNumber(coordinates.latitude), asNumber(coordinates.longitude), orientation, roofType],
      );
      updated += 1;
    }
  } catch (error) {
    recordFailure(failures, "venues", error, true);
  }
  return updated;
}

type SlateGame = {
  gamePk: number;
  venueId: number | null;
  startTimeUtc: string | null;
  latitude: N;
  longitude: N;
  orientationDegrees: N;
  roofType: string | null;
};

async function slateGames(slateDate: string): Promise<SlateGame[]> {
  const result = await pool.query<{
    game_pk: string; venue_id: number | null; start_time_utc: string | null;
    latitude: string | null; longitude: string | null;
    orientation_degrees: number | null; roof_type: string | null;
  }>(
    `SELECT g.game_pk::text AS game_pk, g.venue_id, g.start_time_utc::text AS start_time_utc,
            v.latitude::text AS latitude, v.longitude::text AS longitude,
            v.orientation_degrees, v.roof_type
       FROM games g
       LEFT JOIN venues v ON v.venue_id = g.venue_id
      WHERE g.game_date = $1
      ORDER BY g.game_pk`,
    [slateDate],
  );
  return result.rows.map((row) => ({
    gamePk: Number(row.game_pk),
    venueId: row.venue_id,
    startTimeUtc: row.start_time_utc,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    orientationDegrees: row.orientation_degrees === null ? null : Number(row.orientation_degrees),
    roofType: row.roof_type,
  }));
}

/** Picks the forecast hour closest to first pitch. */
function forecastAtHour(hourly: JsonObject, target: string | null) {
  const times = asArray(hourly.time).map(String);
  if (!times.length) return null;
  const targetMs = target ? Date.parse(target) : Number.NaN;
  let index = 0;
  if (Number.isFinite(targetMs)) {
    let bestDistance = Number.POSITIVE_INFINITY;
    times.forEach((time, position) => {
      const distance = Math.abs(Date.parse(`${time}Z`) - targetMs);
      if (Number.isFinite(distance) && distance < bestDistance) {
        bestDistance = distance;
        index = position;
      }
    });
  }
  const at = (key: string) => asNumber(asArray(hourly[key])[index]);
  return {
    time: times[index],
    temperatureF: at("temperature_2m"),
    windSpeedMph: at("wind_speed_10m"),
    windDirectionDegrees: at("wind_direction_10m"),
    humidityPercent: at("relative_humidity_2m"),
    precipitationProbability: at("precipitation_probability"),
  };
}

export type WeatherRefreshResult = {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  slateDate: string;
  ingestRunId: string | null;
  gamesFound: number;
  observationsWritten: number;
  domedGames: number;
  // Games whose pregame weather is already carried by an append-only
  // FantasyPros observation, so this Open-Meteo refresh deliberately wrote
  // nothing for them. Without this count, "0 observations written" on a
  // fully-covered slate is indistinguishable from a refresh that found no
  // weather at all.
  fantasyProsFallbackGames: number;
  gamesWithoutGeography: number;
  failures: WeatherIngestFailure[];
  error?: string;
};

export class WeatherRefreshValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherRefreshValidationError";
  }
}

type WeatherRefreshAudit = {
  actor: string;
  requestId?: string | null;
};

type WeatherRefreshMetadata = {
  fantasyProsFallbackGamePks: number[];
  openMeteoRetrievedGamePks: number[];
};

async function fantasyProsWeatherGamePks(slateDate: string): Promise<Set<number>> {
  const result = await pool.query<{ game_pk: string }>(
    `SELECT DISTINCT game_pk::text AS game_pk
       FROM game_weather_observations
      WHERE slate_date = $1 AND source_id = $2`,
    [slateDate, FANTASYPROS_WEATHER_SOURCE],
  );
  return new Set(result.rows.map((row) => Number(row.game_pk)).filter(Number.isSafeInteger));
}

/**
 * Persists the weather already carried on FantasyPros' projected-lineup slate.
 * This is intentionally separate from the Open-Meteo retry path: FantasyPros
 * establishes the pregame slate context, while Open-Meteo remains a disclosed
 * supplemental source when an operator requests a refresh.
 */
export async function ingestFantasyProsWeatherObservations(
  slateDate: string,
  payload: JsonObject,
): Promise<{ observationsWritten: number; gamesWithWeather: number }> {
  const games = await slateGames(slateDate);
  const byGamePk = new Map(games.map((game) => [game.gamePk, game]));
  let observationsWritten = 0;
  let gamesWithWeather = 0;

  for (const rawGame of asArray(payload.games)) {
    const gamePayload = asObject(rawGame);
    const gamePk = asNumber(gamePayload.game_id);
    if (gamePk === null || !Number.isSafeInteger(gamePk)) continue;
    const game = byGamePk.get(gamePk);
    if (!game) continue;

    const weatherText = typeof gamePayload.weather === "string" ? gamePayload.weather.trim() : "";
    const temperatureF = asNumber(gamePayload.temp);
    const windSpeedMph = asNumber(gamePayload.wind);
    const windDirectionDegrees = asNumber(gamePayload.wind_direction);
    const precipitationProbability = asNumber(gamePayload.chance_rain);
    if (!weatherText && temperatureF === null && windSpeedMph === null && precipitationProbability === null) continue;

    gamesWithWeather += 1;
    const roofType = (game.roofType ?? "UNKNOWN").toUpperCase();
    const written = await writeObservation(
      game,
      slateDate,
      {
        time: null,
        temperatureF: roofType === "DOME" ? null : temperatureF,
        windSpeedMph: roofType === "DOME" ? null : windSpeedMph,
        windDirectionDegrees: roofType === "DOME" ? null : windDirectionDegrees,
        humidityPercent: null,
        precipitationProbability: roofType === "DOME" ? null : precipitationProbability,
      },
      {
        sourceId: FANTASYPROS_WEATHER_SOURCE,
        roofState: roofType === "DOME" ? "CLOSED" : roofType === "RETRACTABLE" ? "OPEN" : "NONE",
        weatherNeutral: roofType === "DOME",
        sourceFreshness: null,
        raw: {
          source: "FantasyPros projected lineup weather",
          weather: weatherText || null,
          weatherIcon: typeof gamePayload.weather_icon === "string" ? gamePayload.weather_icon : null,
          chanceRain: precipitationProbability,
          degOffset: gamePayload.deg_offset ?? null,
        },
      },
    );
    if (written) observationsWritten += 1;
  }
  return { observationsWritten, gamesWithWeather };
}

/**
 * Performs one slate's forecast retrieval after its ingest run has been
 * created by the public wrapper below.
 *
 * Observations are append-only: every retrieval writes a new row unless the
 * forecast is byte-identical to one already stored for the game, so a
 * post-freeze weather change is a new observation rather than a mutation of the
 * pregame state.
 */
async function performWeatherRefresh(
  slateDate: string,
  games: SlateGame[],
): Promise<{ result: Omit<WeatherRefreshResult, "ingestRunId">; metadata: WeatherRefreshMetadata }> {
  const failures: WeatherIngestFailure[] = [];
  const fantasyProsWeatherGames = await fantasyProsWeatherGamePks(slateDate);
  const missingGeography = games.filter(
    (game) => game.venueId !== null
      && (game.latitude === null || game.longitude === null)
      && !fantasyProsWeatherGames.has(game.gamePk),
  );
  if (missingGeography.length) {
    await ingestVenueGeography(
      [...new Set(missingGeography.map((game) => game.venueId!))],
      failures,
    );
  }
  const hydrated = missingGeography.length ? await slateGames(slateDate) : games;

  let observationsWritten = 0;
  let domedGames = 0;
  let gamesWithoutGeography = 0;
  const fantasyProsFallbackGamePks: number[] = [];
  const openMeteoRetrievedGamePks: number[] = [];

  for (const game of hydrated) {
    const roofType = (game.roofType ?? "UNKNOWN").toUpperCase();
    // A dome is neutral weather. It is recorded as an observation, not skipped,
    // so a domed venue is distinguishable from a venue with missing weather.
    if (roofType === "DOME") {
      const written = await writeObservation(game, slateDate, {
        temperatureF: null, windSpeedMph: null, windDirectionDegrees: null,
        humidityPercent: null, precipitationProbability: null, time: null,
      }, { sourceId: WEATHER_SOURCE, roofState: "CLOSED", weatherNeutral: true, sourceFreshness: null, raw: { roofType } });
      if (written) observationsWritten += 1;
      domedGames += 1;
      continue;
    }
    if (game.latitude === null || game.longitude === null) {
      if (fantasyProsWeatherGames.has(game.gamePk)) {
        // Do not clone this source into an Open-Meteo row: the existing
        // append-only FantasyPros observation remains the pregame fallback and
        // retains its source lineage.
        fantasyProsFallbackGamePks.push(game.gamePk);
        continue;
      }
      gamesWithoutGeography += 1;
      recordFailure(
        failures,
        `geography:${game.gamePk}`,
        new Error(`Venue ${game.venueId ?? "unknown"} has no coordinates; no forecast can be requested.`),
      );
      continue;
    }
    try {
      const url = `${WEATHER_BASE}?latitude=${game.latitude}&longitude=${game.longitude}`
        + "&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,wind_direction_10m"
        + "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC";
      const response = await fetch(url);
      if (!response.ok) {
        recordFailure(failures, `forecast:${game.gamePk}`, new Error(`Forecast endpoint returned HTTP ${response.status}`));
        continue;
      }
      const payload = await response.json() as JsonObject;
      const reading = forecastAtHour(asObject(payload.hourly), game.startTimeUtc);
      if (!reading) {
        recordFailure(failures, `forecast:${game.gamePk}`, new Error("Forecast response carried no hourly series."));
        continue;
      }
      openMeteoRetrievedGamePks.push(game.gamePk);
      const written = await writeObservation(game, slateDate, reading, {
        sourceId: WEATHER_SOURCE,
        roofState: roofType === "RETRACTABLE" ? "OPEN" : "NONE",
        weatherNeutral: false,
        // The upstream forecast's own generation time, never now().
        sourceFreshness: typeof payload.generationtime_ms === "number" || payload.generationtime_ms === undefined
          ? (reading.time ? `${reading.time}Z` : null)
          : null,
        raw: { roofType, requestedFor: game.startTimeUtc },
      });
      if (written) observationsWritten += 1;
    } catch (error) {
      recordFailure(failures, `forecast:${game.gamePk}`, error);
    }
  }

  const fatal = failures.some((failure) => failure.fatal);
  // An existing preferred FantasyPros observation is usable pregame weather,
  // even though this Open-Meteo refresh correctly does not write a duplicate.
  const emptyDespiteSlate = hydrated.length > 0
    && observationsWritten === 0
    && fantasyProsFallbackGamePks.length === 0;
  const status: WeatherRefreshResult["status"] = fatal || emptyDespiteSlate
    ? "FAILED"
    : failures.length
      ? "PARTIAL"
      : "SUCCESS";
  const error = status === "SUCCESS"
    ? undefined
    : fatal
      ? `Weather ingest failed: ${failures.filter((f) => f.fatal).map((f) => `${f.scope}: ${f.detail}`).join("; ")}`
      : emptyDespiteSlate
        ? `Weather ingest wrote zero observations across ${hydrated.length} scheduled game(s).`
        : `Weather ingest completed with ${failures.length} failure(s).`;
  if (error) logger.error({ slateDate, status, failures }, "weather refresh did not fully succeed");

  return {
    result: {
      status,
      slateDate,
      gamesFound: hydrated.length,
      observationsWritten,
      domedGames,
      fantasyProsFallbackGames: fantasyProsFallbackGamePks.length,
      gamesWithoutGeography,
      failures,
      ...(error ? { error } : {}),
    },
    metadata: { fantasyProsFallbackGamePks, openMeteoRetrievedGamePks },
  };
}

async function startWeatherRun(slateDate: string) {
  const result = await pool.query<{ ingest_run_id: string }>(
    `WITH weather_source AS (
       INSERT INTO source_registry (source_id, name, source_type, base_url, expected_freshness_minutes, notes)
       VALUES ($1, 'Open-Meteo Forecast', '${WEATHER_SOURCE_TYPE}', $2, 180,
               'Per-game forecast. Forecast data changes; observations are append-only.')
       ON CONFLICT (source_id) DO UPDATE SET
         name = EXCLUDED.name, base_url = EXCLUDED.base_url,
         expected_freshness_minutes = EXCLUDED.expected_freshness_minutes
       RETURNING source_id
     )
     INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     SELECT source_id, 'weather_refresh', 'RUNNING', $3 FROM weather_source
     RETURNING ingest_run_id`,
    [WEATHER_SOURCE, WEATHER_BASE, slateDate],
  );
  return result.rows[0].ingest_run_id;
}

async function finishWeatherRun(
  ingestRunId: string,
  result: Omit<WeatherRefreshResult, "ingestRunId">,
  audit?: WeatherRefreshAudit,
  metadata: WeatherRefreshMetadata = { fantasyProsFallbackGamePks: [], openMeteoRetrievedGamePks: [] },
) {
  const values = [
    ingestRunId,
    result.status,
    result.gamesFound,
    result.observationsWritten,
    result.failures.length,
    result.status === "SUCCESS" ? 200 : result.status === "PARTIAL" ? 206 : 500,
    result.error ?? null,
    JSON.stringify({
      domedGames: result.domedGames,
      gamesWithoutGeography: result.gamesWithoutGeography,
      fantasyProsFallbackGamePks: metadata.fantasyProsFallbackGamePks,
      openMeteoRetrievedGamePks: metadata.openMeteoRetrievedGamePks,
      failures: result.failures,
    }),
  ];
  const completion = `UPDATE ingest_runs
        SET finished_at = now(),
            status = $2,
            row_count = $3,
            normalized_row_count = $4,
            rejected_row_count = $5,
            http_status = $6,
            duration_ms = EXTRACT(EPOCH FROM (now() - started_at))::int * 1000,
            error_message = $7,
            metadata = $8::jsonb
      WHERE ingest_run_id = $1`;
  if (!audit) {
    await pool.query(completion, values);
    return;
  }
  await pool.query(
    `WITH completed AS (
       ${completion}
       RETURNING ingest_run_id
     )
     INSERT INTO audit_events (actor, request_id, action, resource_type, resource_id, metadata)
     SELECT $9, $10, 'weather.refresh', 'slate', $11, $12::jsonb
       FROM completed`,
    [
      ...values,
      audit.actor,
      audit.requestId ?? null,
      result.slateDate,
      JSON.stringify({
        status: result.status,
        ingestRunId,
        gamesFound: result.gamesFound,
        observationsWritten: result.observationsWritten,
        domedGames: result.domedGames,
        gamesWithoutGeography: result.gamesWithoutGeography,
        fantasyProsFallbackGamePks: metadata.fantasyProsFallbackGamePks,
        openMeteoRetrievedGamePks: metadata.openMeteoRetrievedGamePks,
        failures: result.failures,
        error: result.error ?? null,
      }),
    ],
  );
}

function failedWeatherResult(slateDate: string, detail: string): Omit<WeatherRefreshResult, "ingestRunId"> {
  return {
    status: "FAILED",
    slateDate,
    gamesFound: 0,
    observationsWritten: 0,
    domedGames: 0,
    fantasyProsFallbackGames: 0,
    gamesWithoutGeography: 0,
    failures: [{ scope: "weather_refresh", detail, fatal: true }],
    error: `Weather refresh failed: ${detail}`,
  };
}

async function finalizeWeatherRun(
  ingestRunId: string,
  result: Omit<WeatherRefreshResult, "ingestRunId">,
  audit?: WeatherRefreshAudit,
  metadata?: WeatherRefreshMetadata,
) {
  try {
    await finishWeatherRun(ingestRunId, result, audit, metadata);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error({ ingestRunId, detail }, "weather result or audit persistence failed; retrying failed recovery outcome");
    const recovered = failedWeatherResult(result.slateDate, `Outcome persistence failed: ${detail}`);
    try {
      // The retry preserves the transaction that writes both the final result
      // and the append-only operator outcome audit event.
      await finishWeatherRun(ingestRunId, recovered, audit, metadata);
      return recovered;
    } catch (recoveryError) {
      logger.error(
        { ingestRunId, detail: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) },
        "weather outcome and audit retry failed; forcing a durable failed run",
      );
      try {
        await finishWeatherRun(ingestRunId, recovered, undefined, metadata);
      } catch (durabilityError) {
        logger.error(
          { ingestRunId, detail: durabilityError instanceof Error ? durabilityError.message : String(durabilityError) },
          "weather failed-run recovery could not be persisted",
        );
      }
    }
    return recovered;
  }
}

/**
 * Ingests one slate's forecasts and records every outcome as a durable,
 * selected-date ingest run. Weather remains optional enrichment, but its retry
 * outcome must be visible without running an unrelated pipeline.
 */
export async function refreshWeather(
  slateDate: string,
  audit?: WeatherRefreshAudit,
): Promise<WeatherRefreshResult> {
  const games = await slateGames(slateDate);
  if (!games.length) {
    throw new WeatherRefreshValidationError(
      `No scheduled games are registered for ${slateDate}; select an Eastern MLB slate date with scheduled games.`,
    );
  }
  let ingestRunId: string | null = null;
  try {
    ingestRunId = await startWeatherRun(slateDate);
    const refresh = await performWeatherRefresh(slateDate, games);
    return { ...(await finalizeWeatherRun(ingestRunId, refresh.result, audit, refresh.metadata)), ingestRunId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error({ slateDate, detail }, "weather refresh failed unexpectedly");
    const result = failedWeatherResult(slateDate, detail);
    if (ingestRunId) return { ...(await finalizeWeatherRun(ingestRunId, result, audit)), ingestRunId };
    return { ...result, ingestRunId };
  }
}

async function writeObservation(
  game: SlateGame,
  slateDate: string,
  reading: {
    time: string | null;
    temperatureF: N;
    windSpeedMph: N;
    windDirectionDegrees: N;
    humidityPercent: N;
    precipitationProbability: N;
  },
  options: { sourceId: string; roofState: string; weatherNeutral: boolean; sourceFreshness: string | null; raw: JsonObject },
): Promise<boolean> {
  const wind = options.weatherNeutral
    ? { outComponentMph: null as N, component: "UNKNOWN" as WindComponent, relativeDegrees: null as N }
    : resolveWind(reading.windSpeedMph, reading.windDirectionDegrees, game.orientationDegrees);
  const checksum = createHash("sha256").update(JSON.stringify({
    gamePk: game.gamePk,
    forecastFor: reading.time,
    temperatureF: reading.temperatureF,
    windSpeedMph: reading.windSpeedMph,
    windDirectionDegrees: reading.windDirectionDegrees,
    roofState: options.roofState,
  })).digest("hex");

  const result = await pool.query(
    `INSERT INTO game_weather_observations
       (game_pk, venue_id, slate_date, forecast_for_utc, temperature_f, wind_speed_mph,
        wind_direction_degrees, wind_out_component_mph, wind_component,
        precipitation_probability, humidity_percent, roof_state, weather_neutral,
        source_id, source_freshness, observation_checksum, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (game_pk, source_id, observation_checksum) DO NOTHING`,
    [
      game.gamePk, game.venueId, slateDate,
      reading.time ? `${reading.time}Z` : game.startTimeUtc,
      reading.temperatureF, reading.windSpeedMph, reading.windDirectionDegrees,
      wind.outComponentMph, wind.component,
      reading.precipitationProbability, reading.humidityPercent,
      options.roofState, options.weatherNeutral,
      options.sourceId, options.sourceFreshness, checksum,
      JSON.stringify({ ...options.raw, windRelativeDegrees: wind.relativeDegrees }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Accessor ──────────────────────────────────────────────────────────────────

/** The most recently retrieved observation for one game. */
export async function getGameWeather(gamePk: number): Promise<GameWeather | null> {
  const result = await pool.query<{
    game_pk: string; venue_id: number | null; temperature_f: string | null;
    wind_speed_mph: string | null; wind_direction_degrees: number | null;
    wind_out_component_mph: string | null; wind_component: string | null;
    roof_state: string | null; weather_neutral: boolean; source_id: string;
    source_freshness: string | null; retrieved_at: string; forecast_for_utc: string | null;
  }>(
    `SELECT game_pk::text AS game_pk, venue_id, temperature_f::text, wind_speed_mph::text,
            wind_direction_degrees, wind_out_component_mph::text, wind_component,
            roof_state, weather_neutral, source_id, source_freshness::text, retrieved_at::text,
            forecast_for_utc::text
       FROM game_weather_observations
      WHERE game_pk = $1
      ORDER BY CASE source_id WHEN '${FANTASYPROS_WEATHER_SOURCE}' THEN 0 ELSE 1 END,
               retrieved_at DESC
      LIMIT 1`,
    [gamePk],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    gamePk: Number(row.game_pk),
    venueId: row.venue_id,
    temperatureF: row.temperature_f === null ? null : Number(row.temperature_f),
    windSpeedMph: row.wind_speed_mph === null ? null : Number(row.wind_speed_mph),
    windDirectionDegrees: row.wind_direction_degrees,
    windOutComponentMph: row.wind_out_component_mph === null ? null : Number(row.wind_out_component_mph),
    windComponent: (row.wind_component ?? "UNKNOWN") as WindComponent,
    roofState: row.roof_state ?? "UNKNOWN",
    weatherNeutral: row.weather_neutral,
    environment: row.weather_neutral ? "CLOSED_ROOF" : "OPEN_AIR",
    sourceId: row.source_id,
    sourceFreshness: row.source_freshness,
    retrievedAt: row.retrieved_at,
    forecastForUtc: row.forecast_for_utc,
  };
}

/** Every observation for one game, oldest first. A post-freeze change is visible as a change. */
export async function getGameWeatherHistory(gamePk: number) {
  const result = await pool.query<{
    retrieved_at: string; temperature_f: string | null; wind_speed_mph: string | null;
    wind_out_component_mph: string | null; wind_component: string | null; roof_state: string | null;
  }>(
    `SELECT retrieved_at::text, temperature_f::text, wind_speed_mph::text,
            wind_out_component_mph::text, wind_component, roof_state
       FROM game_weather_observations
      WHERE game_pk = $1
      ORDER BY retrieved_at ASC`,
    [gamePk],
  );
  return result.rows.map((row) => ({
    retrievedAt: row.retrieved_at,
    temperatureF: row.temperature_f === null ? null : Number(row.temperature_f),
    windSpeedMph: row.wind_speed_mph === null ? null : Number(row.wind_speed_mph),
    windOutComponentMph: row.wind_out_component_mph === null ? null : Number(row.wind_out_component_mph),
    windComponent: row.wind_component ?? "UNKNOWN",
    roofState: row.roof_state ?? "UNKNOWN",
  }));
}

/**
 * Weather for every game on a slate, keyed by gamePk. One query, not one per
 * game. Uses the same source precedence as getGameWeather — the FantasyPros
 * pregame observation first when one exists, then the newest supplemental
 * observation — so slate scoring and single-game display cannot diverge in
 * provenance after an Open-Meteo retry.
 */
export async function getSlateWeather(slateDate: string): Promise<Map<number, GameWeather>> {
  const result = await pool.query<{
    game_pk: string; venue_id: number | null; temperature_f: string | null;
    wind_speed_mph: string | null; wind_direction_degrees: number | null;
    wind_out_component_mph: string | null; wind_component: string | null;
    roof_state: string | null; weather_neutral: boolean; source_id: string;
    source_freshness: string | null; retrieved_at: string; forecast_for_utc: string | null;
  }>(
    `SELECT DISTINCT ON (game_pk)
            game_pk::text AS game_pk, venue_id, temperature_f::text, wind_speed_mph::text,
            wind_direction_degrees, wind_out_component_mph::text, wind_component,
            roof_state, weather_neutral, source_id, source_freshness::text, retrieved_at::text,
            forecast_for_utc::text
       FROM game_weather_observations
      WHERE slate_date = $1
      ORDER BY game_pk,
               CASE source_id WHEN '${FANTASYPROS_WEATHER_SOURCE}' THEN 0 ELSE 1 END,
               retrieved_at DESC`,
    [slateDate],
  );
  const weather = new Map<number, GameWeather>();
  for (const row of result.rows) {
    weather.set(Number(row.game_pk), {
      gamePk: Number(row.game_pk),
      venueId: row.venue_id,
      temperatureF: row.temperature_f === null ? null : Number(row.temperature_f),
      windSpeedMph: row.wind_speed_mph === null ? null : Number(row.wind_speed_mph),
      windDirectionDegrees: row.wind_direction_degrees,
      windOutComponentMph: row.wind_out_component_mph === null ? null : Number(row.wind_out_component_mph),
      windComponent: (row.wind_component ?? "UNKNOWN") as WindComponent,
      roofState: row.roof_state ?? "UNKNOWN",
      weatherNeutral: row.weather_neutral,
      environment: row.weather_neutral ? "CLOSED_ROOF" : "OPEN_AIR",
      sourceId: row.source_id,
      sourceFreshness: row.source_freshness,
      retrievedAt: row.retrieved_at,
      forecastForUtc: row.forecast_for_utc,
    });
  }
  return weather;
}
