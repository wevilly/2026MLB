/**
 * Phase 4 acceptance.
 *
 * Park factors were collected, displayed and deliberately excluded from
 * ranking: buildParkEvidence carried the note "Park factors are context only,
 * not used to gate or boost rank directly" and computeEvidenceScore read no
 * park feature at all, so Coors Field and Oracle Park ranked identically for an
 * otherwise identical hitter and matchup.
 *
 * Weather did not exist anywhere in the engine. The word did not appear in the
 * audited files.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { bundleService } from "./helpers/bundle.ts";

const tb = bundleService("artifacts/api-server/src/services/tb-engine.ts");
const weather = bundleService("artifacts/api-server/src/services/weather-foundation.ts");

/** Two venues that differ only in their park factors. */
const COORS = new Map<string, number | null>([
  ["hits_factor", 112], ["doubles_factor", 118], ["hr_factor", 121],
]);
const ORACLE = new Map<string, number | null>([
  ["hits_factor", 96], ["doubles_factor", 94], ["hr_factor", 82],
]);

describe("Task 4.1 the venue changes the evidence score", () => {
  test("two candidates identical except for venue score differently, in the expected direction", async () => {
    const { computeParkContext } = await tb;
    const hitter = computeParkContext(COORS, "R");
    const pitcher = computeParkContext(ORACLE, "R");
    assert.ok(hitter.adjustment > 0, `Coors adjustment ${hitter.adjustment} must be positive`);
    assert.ok(pitcher.adjustment < 0, `Oracle adjustment ${pitcher.adjustment} must be negative`);
    assert.ok(hitter.adjustment - pitcher.adjustment > 1, "the two venues must be materially apart");
  });

  test("the composite is not the HR factor", async () => {
    const { computeParkContext, TB_PARK_FACTOR_WEIGHTS } = await tb;
    // A park whose doubles factor diverges sharply from its HR factor. An
    // HR-only factor would call this suppressive; a total-bases composite does
    // not, which is the whole reason for composing it.
    const divergent = new Map<string, number | null>([
      ["hits_factor", 108], ["doubles_factor", 122], ["hr_factor", 88],
    ]);
    const context = computeParkContext(divergent, "L");
    assert.notEqual(context.composite, 88);
    assert.ok(context.composite > 88, "the doubles factor must pull the composite above the HR factor");
    const expected = (108 * TB_PARK_FACTOR_WEIGHTS.hits
      + 122 * TB_PARK_FACTOR_WEIGHTS.doubles
      + 88 * TB_PARK_FACTOR_WEIGHTS.homeRuns)
      / (TB_PARK_FACTOR_WEIGHTS.hits + TB_PARK_FACTOR_WEIGHTS.doubles + TB_PARK_FACTOR_WEIGHTS.homeRuns);
    assert.ok(Math.abs(context.composite - expected) < 1e-6);
  });

  test("the park adjustment is bounded and cannot exceed the pitcher matchup term", async () => {
    const { computeParkContext, PARK_MAX_ADJUSTMENT } = await tb;
    const PITCHER_MATCHUP_MAX = 3;
    assert.ok(PARK_MAX_ADJUSTMENT < PITCHER_MATCHUP_MAX, "the cap must sit below the pitcher term");
    for (const extreme of [1, 40, 180, 500, 0]) {
      const context = computeParkContext(
        new Map<string, number | null>([["hits_factor", extreme], ["doubles_factor", extreme], ["hr_factor", extreme]]),
        "R",
      );
      assert.ok(
        Math.abs(context.adjustment) <= PARK_MAX_ADJUSTMENT,
        `factor ${extreme} produced ${context.adjustment}, beyond the cap`,
      );
      assert.ok(Math.abs(context.adjustment) < PITCHER_MATCHUP_MAX);
    }
  });

  test("an extreme park is visible as a structural override, not a two-point nudge", async () => {
    const { computeParkContext } = await tb;
    assert.equal(computeParkContext(COORS, "R").environment, "EXTREME_HITTER_PARK");
    assert.equal(computeParkContext(ORACLE, "R").environment, "SUPPRESSIVE_PARK");
    assert.equal(computeParkContext(new Map([["hr_factor", 100]]), "R").environment, "NEUTRAL");
    assert.equal(computeParkContext(new Map(), "R").environment, "UNKNOWN");
  });

  test("the batter-side split is used when present", async () => {
    const { computeParkContext } = await tb;
    const split = new Map<string, number | null>([
      ["hr_factor", 100], ["hr_factor:L", 130],
      ["hits_factor", 100], ["doubles_factor", 100],
    ]);
    const left = computeParkContext(split, "L");
    const right = computeParkContext(split, "R");
    assert.equal(left.usedBatterSideSplit, true);
    assert.equal(right.usedBatterSideSplit, false);
    assert.ok(left.composite > right.composite, "the left-handed split must be used for a left-handed batter");
  });

  test("the context-only note is gone", () => {
    const source = readFileSync("artifacts/api-server/src/services/tb-engine.ts", "utf8");
    // Comment lines are excluded: the defect is described in a doc comment,
    // which is the opposite of leaving the claim standing in the payload.
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    assert.ok(
      !/Park factors are context only/.test(code),
      "leaving the context-only note in place would be worse than the previous state",
    );
    const score = source.slice(source.indexOf("function computeEvidenceScore"), source.indexOf("function assignResearchState"));
    assert.ok(score.includes("computeParkContext(park, side).adjustment"), "the score must read the park");
  });
});

describe("Task 4.3 opportunity is a number, not four steps", () => {
  test("the score changes monotonically with lineup slot", async () => {
    const { opportunityScore } = await tb;
    const scores = Array.from({ length: 9 }, (_, index) => opportunityScore(index + 1));
    for (let index = 1; index < scores.length; index += 1) {
      assert.ok(scores[index] < scores[index - 1], `slot ${index + 1} must score below slot ${index}`);
    }
    // The old function produced four distinct values across nine slots.
    assert.equal(new Set(scores).size, 9);
  });

  test("the endpoints match the previous scale, so only the resolution changed", async () => {
    const { opportunityScore } = await tb;
    assert.ok(Math.abs(opportunityScore(1) - 3) < 1e-6);
    assert.ok(Math.abs(opportunityScore(9) + 1) < 1e-6);
    assert.equal(opportunityScore(null), 0);
  });

  test("the expected plate appearance figure is exposed and labelled a heuristic", async () => {
    const { expectedPlateAppearances } = await tb;
    assert.equal(typeof expectedPlateAppearances(1), "number");
    assert.ok(expectedPlateAppearances(1) > expectedPlateAppearances(9));
    assert.equal(expectedPlateAppearances(null), null);
    assert.equal(expectedPlateAppearances(10), null);

    const source = readFileSync("artifacts/api-server/src/services/tb-engine.ts", "utf8");
    const evidence = source.slice(source.indexOf("function buildOpportunityEvidence"));
    assert.ok(evidence.includes("expectedPlateAppearances: expectedPA"), "the number must reach the payload");
    assert.ok(evidence.includes('expectedPlateAppearancesBasis: "HEURISTIC"'), "it must be labelled a heuristic");
    assert.ok(/A HEURISTIC, not a fitted quantity/.test(source), "the code must say so too");
  });
});

describe("Task 4.2 wind direction is the load-bearing field", () => {
  test("a wind blowing out and a wind blowing in have opposite signs", async () => {
    const { resolveWind } = await weather;
    // Park bearing 0 means centre field is due north. A wind blowing out to
    // centre therefore comes from the south, 180 degrees.
    const out = resolveWind(15, 180, 0);
    const into = resolveWind(15, 0, 0);
    assert.equal(out.component, "OUT");
    assert.equal(into.component, "IN");
    assert.ok(Math.abs(out.outComponentMph - 15) < 1e-6);
    assert.ok(Math.abs(into.outComponentMph + 15) < 1e-6);
    assert.equal(Math.sign(out.outComponentMph), -Math.sign(into.outComponentMph));
  });

  test("a crosswind is neither out nor in", async () => {
    const { resolveWind } = await weather;
    assert.equal(resolveWind(15, 90, 0).component, "CROSS");
    assert.equal(resolveWind(15, 270, 0).component, "CROSS");
  });

  test("speed without a usable direction is UNKNOWN, never a guessed sign", async () => {
    const { resolveWind } = await weather;
    assert.equal(resolveWind(15, null, 0).component, "UNKNOWN");
    assert.equal(resolveWind(15, 180, null).component, "UNKNOWN");
    assert.equal(resolveWind(15, null, 0).outComponentMph, null);
    assert.equal(resolveWind(1, 180, 0).component, "CALM");
  });

  test("two games identical except for wind direction score differently", async () => {
    const { weatherAdjustment } = await weather;
    const base = {
      gamePk: 1, venueId: 1, temperatureF: 72, windSpeedMph: 10,
      windDirectionDegrees: 180, windComponent: "OUT" as const,
      roofState: "NONE", weatherNeutral: false, environment: "OPEN_AIR" as const,
      sourceFreshness: null, retrievedAt: null, forecastForUtc: null,
    };
    const blowingOut = weatherAdjustment("TB", { ...base, windOutComponentMph: 10 });
    const blowingIn = weatherAdjustment("TB", { ...base, windOutComponentMph: -10, windComponent: "IN" });
    assert.ok(blowingOut.adjustment > 0);
    assert.ok(blowingIn.adjustment < 0);
    assert.ok(blowingOut.adjustment > blowingIn.adjustment);
  });
});

describe("Task 4.2 a dome is neutral, not missing", () => {
  const domed = {
    gamePk: 1, venueId: 1, temperatureF: null, windSpeedMph: null,
    windDirectionDegrees: null, windOutComponentMph: null,
    windComponent: "UNKNOWN" as const, roofState: "CLOSED",
    weatherNeutral: true, environment: "CLOSED_ROOF" as const,
    sourceFreshness: null, retrievedAt: null, forecastForUtc: null,
  };

  test("a closed roof is a zero adjustment with a stated reason", async () => {
    const { weatherAdjustment } = await weather;
    const result = weatherAdjustment("TB", domed);
    assert.equal(result.adjustment, 0);
    assert.deepEqual(result.flags, []);
    assert.equal(result.environment, "CLOSED_ROOF");
    assert.match(result.detail, /neutral, not missing/);
  });

  test("missing weather is distinguishable from a dome", async () => {
    const { weatherAdjustment } = await weather;
    const missing = weatherAdjustment("TB", null);
    assert.equal(missing.adjustment, 0);
    assert.equal(missing.environment, "UNKNOWN");
    assert.notEqual(missing.environment, weatherAdjustment("TB", domed).environment);
  });

  test("the ingest records a domed game rather than skipping it", () => {
    const source = readFileSync("artifacts/api-server/src/services/weather-foundation.ts", "utf8");
    assert.ok(source.includes('if (roofType === "DOME")'), "a dome must be handled explicitly");
    assert.ok(source.includes("weatherNeutral: true"), "a dome must be recorded as neutral");
  });

  test("the weather provider is registered with the database weather source type", () => {
    const source = readFileSync("artifacts/api-server/src/services/weather-foundation.ts", "utf8");
    assert.ok(source.includes('const WEATHER_SOURCE_TYPE = "WEATHER"'), "the source type must match the source_registry enum");
    assert.ok(source.includes("'${WEATHER_SOURCE_TYPE}'"), "weather registration must use the declared weather source type");
    assert.ok(!source.includes("'DERIVED'"), "DERIVED is not a valid source_registry source type");
  });
});

describe("Task 4.2 coefficients differ by market and extremes are flags", () => {
  const cold = {
    gamePk: 1, venueId: 1, temperatureF: 38, windSpeedMph: 18,
    windDirectionDegrees: 0, windOutComponentMph: -18,
    windComponent: "IN" as const, roofState: "NONE",
    weatherNeutral: false, environment: "OPEN_AIR" as const,
    sourceFreshness: null, retrievedAt: null, forecastForUtc: null,
  };

  test("the walk market's coefficients are not the total bases market's", async () => {
    const { MARKET_WEATHER_COEFFICIENTS } = await weather;
    assert.notDeepEqual(MARKET_WEATHER_COEFFICIENTS.WALK, MARKET_WEATHER_COEFFICIENTS.TB);
    assert.ok(
      MARKET_WEATHER_COEFFICIENTS.WALK.windOutPerMph < MARKET_WEATHER_COEFFICIENTS.TB.windOutPerMph,
      "walks are largely indifferent to wind",
    );
    assert.ok(
      MARKET_WEATHER_COEFFICIENTS.HR.windOutPerMph > MARKET_WEATHER_COEFFICIENTS.TB.windOutPerMph,
      "home runs are the most wind sensitive market",
    );
  });

  test("wind and cold suppression is not applied uniformly across markets", async () => {
    const { weatherAdjustment } = await weather;
    const tbEffect = Math.abs(weatherAdjustment("TB", cold).adjustment);
    const walkEffect = Math.abs(weatherAdjustment("WALK", cold).adjustment);
    assert.ok(tbEffect > walkEffect * 3, `TB ${tbEffect} must dominate WALK ${walkEffect}`);
  });

  test("the extremes fire as flags, and the linear term is clamped there", async () => {
    const { weatherAdjustment, MARKET_WEATHER_COEFFICIENTS } = await weather;
    const result = weatherAdjustment("TB", cold);
    assert.ok(result.flags.includes("EXTREME_COLD"));
    assert.ok(result.flags.includes("STRONG_WIND_IN"));
    assert.ok(Math.abs(result.adjustment) <= MARKET_WEATHER_COEFFICIENTS.TB.maxAdjustment);
    // Doubling the extremity does not double the linear term.
    const worse = weatherAdjustment("TB", { ...cold, temperatureF: 10, windOutComponentMph: -40 });
    assert.equal(worse.adjustment, result.adjustment);
  });

  test("every market's cap sits below the pitcher matchup term", async () => {
    const { MARKET_WEATHER_COEFFICIENTS } = await weather;
    for (const [market, coefficients] of Object.entries(MARKET_WEATHER_COEFFICIENTS)) {
      assert.ok(coefficients.maxAdjustment < 3, `${market} cap ${coefficients.maxAdjustment} is not bounded`);
    }
  });
});

describe("Task 4.2 the service follows the task 3.5 rules from day one", () => {
  const source = readFileSync("artifacts/api-server/src/services/weather-foundation.ts", "utf8");

  test("no error is swallowed", () => {
    assert.ok(!/\}\s*catch\s*\{/.test(source), "every catch must bind and record its error");
    assert.ok(source.includes("recordFailure("), "failures must be counted");
    assert.ok(source.includes('status: WeatherRefreshResult["status"] = fatal || emptyDespiteSlate'),
      "an empty result on a real slate must not be SUCCESS");
  });

  test("source freshness is the upstream forecast time, never now()", () => {
    const write = source.slice(source.indexOf("async function writeObservation"));
    assert.ok(!/new Date\(\)/.test(write), "the observation must not stamp itself with the current time");
    assert.ok(source.includes("sourceFreshness"), "the upstream time must be persisted");
  });

  test("observations are append-only", () => {
    assert.ok(source.includes("ON CONFLICT (game_pk, source_id, observation_checksum) DO NOTHING"),
      "an unchanged forecast must not append a duplicate");
    assert.ok(!/UPDATE game_weather_observations/.test(source), "an observation is never updated in place");
    const immutability = readFileSync("lib/db/scripts/apply-immutability.mjs", "utf8");
    assert.ok(immutability.includes("prevent_game_weather_mutation"), "the database must enforce it too");
  });

  test("the pipeline refreshes weather before the engines read it", () => {
    const orchestration = readFileSync("artifacts/api-server/src/services/orchestration.ts", "utf8");
    assert.ok(orchestration.includes('"weather_refresh"'), "the step must exist");
    assert.ok(
      orchestration.indexOf('"weather_refresh", () => refreshWeather') < orchestration.indexOf('"tb_engine", () => runTBEngine'),
      "weather must land before the engines",
    );
  });

  test("all four engines read the weather", () => {
    for (const engine of ["tb-engine", "walk-engine", "xbh-engine", "hr-engine"]) {
      const engineSource = readFileSync(`artifacts/api-server/src/services/${engine}.ts`, "utf8");
      assert.ok(engineSource.includes("getSlateWeather"), `${engine} must load the slate's weather`);
      assert.ok(engineSource.includes("weatherAdjustment("), `${engine} must score a weather term`);
    }
  });
});

describe("Remediation B-03 the Today response exposes stored weather instead of a constant", () => {
  const route = readFileSync("artifacts/api-server/src/routes/analyst/research.ts", "utf8");

  test("no game card field is hard-coded to NOT FOUND for weather or roof", () => {
    assert.ok(!route.includes('roof: "NOT FOUND"'), "roof must come from the stored observation or venue");
    assert.ok(!route.includes('weather: "NOT FOUND"'), "weather must come from the stored observation");
  });

  test("the Today and Game Lab routes read the slate's preferred observations", () => {
    assert.ok(route.includes("getSlateWeather(date)"), "the routes must query stored observations");
    assert.ok(route.includes("formatWeatherSummary("), "the routes must format the stored observation");
    assert.ok(route.includes("formatRoofLabel("), "the routes must derive the roof label");
    assert.ok(route.includes("slateWeather.get(Number(game.game_pk))"),
      "game_pk is a bigint string from pg and must be coerced before the map lookup");
  });

  test("a game without any stored observation renders a truthful unavailable state", async () => {
    const { formatWeatherSummary } = await weather;
    assert.equal(formatWeatherSummary(null), "No stored weather observation");
  });

  test("a stored FantasyPros observation renders temperature, wind, and source", async () => {
    const { formatWeatherSummary } = await weather;
    const summary = formatWeatherSummary({
      gamePk: 1, venueId: 1, temperatureF: 78, windSpeedMph: 8,
      windDirectionDegrees: 180, windOutComponentMph: 8, windComponent: "OUT",
      roofState: "NONE", weatherNeutral: false, environment: "OPEN_AIR",
      sourceId: "FANTASYPROS", sourceFreshness: null, retrievedAt: null, forecastForUtc: null,
    });
    assert.match(summary, /78°F/);
    assert.match(summary, /wind out 8 mph/);
    assert.match(summary, /FantasyPros/);
  });

  test("a dome renders neutral/closed, never missing", async () => {
    const { formatWeatherSummary, formatRoofLabel } = await weather;
    const domed = {
      gamePk: 1, venueId: 1, temperatureF: null, windSpeedMph: null,
      windDirectionDegrees: null, windOutComponentMph: null, windComponent: "UNKNOWN",
      roofState: "CLOSED", weatherNeutral: true, environment: "CLOSED_ROOF",
      sourceId: "OPEN_METEO", sourceFreshness: null, retrievedAt: null, forecastForUtc: null,
    };
    assert.match(formatWeatherSummary(domed), /neutral/);
    assert.ok(!formatWeatherSummary(domed).includes("NOT FOUND"));
    assert.equal(formatRoofLabel(domed, "DOME"), "Roof closed");
    assert.equal(formatRoofLabel(null, "DOME"), "Dome");
    assert.equal(formatRoofLabel(null, null), "Roof unknown");
  });
});

describe("Remediation B-09 slate and single-game weather share one source precedence", () => {
  test("getSlateWeather prefers the FantasyPros pregame observation before recency", async () => {
    const { getSlateWeather } = await weather;
    let capturedSql = "";
    (globalThis as Record<string, unknown>).__workspaceTestPoolQuery = (sql: string) => {
      capturedSql = sql;
      return Promise.resolve({ rows: [] });
    };
    try {
      await getSlateWeather("2026-08-25");
    } finally {
      delete (globalThis as Record<string, unknown>).__workspaceTestPoolQuery;
    }
    assert.ok(capturedSql.includes("DISTINCT ON (game_pk)"), "one preferred observation per game");
    assert.match(
      capturedSql,
      /CASE source_id WHEN 'FANTASYPROS' THEN 0 ELSE 1 END/,
      "the slate accessor must apply the same FantasyPros-first precedence as getGameWeather",
    );
  });

  test("both accessors expose the observation's source for provenance display", () => {
    const source = readFileSync("artifacts/api-server/src/services/weather-foundation.ts", "utf8");
    const accessors = source.slice(source.indexOf("export async function getGameWeather"));
    assert.equal((accessors.match(/sourceId: row\.source_id/g) ?? []).length, 2,
      "getGameWeather and getSlateWeather must both return the stored source_id");
  });
});
