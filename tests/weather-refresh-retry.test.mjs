import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function sources() {
  const [route, weather, shared, app, ui, spec] = await Promise.all([
    readFile("artifacts/api-server/src/routes/analyst/refresh.ts", "utf8"),
    readFile("artifacts/api-server/src/services/weather-foundation.ts", "utf8"),
    readFile("artifacts/api-server/src/routes/analyst/shared.ts", "utf8"),
    readFile("artifacts/api-server/src/app.ts", "utf8"),
    readFile("artifacts/mlb-analyst/src/App.tsx", "utf8"),
    readFile("lib/api-spec/openapi.yaml", "utf8"),
  ]);
  return { route, weather, shared, app, ui, spec };
}

test("weather retry is an approved, isolated, audited selected-date action", async () => {
  const { route, weather, shared, app, ui, spec } = await sources();
  const handler = route.slice(
    route.indexOf('router.post("/analyst/refresh/weather"'),
    route.indexOf("\nexport default router;"),
  );

  assert.match(route, /router\.post\("\/analyst\/refresh\/weather"/);
  assert.match(handler, /const date = requestedDate\(req\.query\.date\)/);
  assert.match(handler, /await refreshWeather\(date, \{ actor: "OPERATOR", requestId: String\(req\.id\) \}\)/);
  assert.match(handler, /await recordAuditEvent\(/);
  assert.match(handler, /action: "weather\.refresh"/);
  assert.match(handler, /resourceId: date/);
  assert.match(handler, /invalidateWeatherSlateCaches\(date\)/);
  assert.match(handler, /result\.status === "FAILED" \? 500 : 201/);
  assert.doesNotMatch(handler, /launchOrchestrationRun|runTBEngine|runXBHEngine|runWALKEngine|runHREngine|trainMarketModel|validateModelVersion|promoteModelVersion/);

  assert.match(weather, /INSERT INTO ingest_runs[\s\S]*'weather_refresh'/);
  assert.match(weather, /async function finishWeatherRun/);
  assert.match(weather, /WITH completed AS/);
  assert.match(weather, /INSERT INTO audit_events/);
  assert.match(weather, /WeatherRefreshValidationError/);
  assert.match(weather, /No scheduled games are registered/);
  assert.match(weather, /weather result or audit persistence failed/);
  assert.match(weather, /status: "FAILED"/);
  assert.match(weather, /Weather refresh failed:/);
  assert.match(shared, /source_id = 'OPEN_METEO' AND job_name = 'weather_refresh' AND effective_date = \$1/);
  assert.match(shared, /weatherRefresh:/);

  assert.match(app, /const isWeatherRetry = req\.path === "\/api\/analyst\/refresh\/weather"/);
  assert.match(app, /if \(!isWeatherRetry && res\.statusCode >= 200/);
  assert.match(app, /const isRoutineOperation = \/\^\\\/api\\\/analyst\\\/\(\?:orchestration\|refresh/);
  assert.match(app, /const weatherRetryRequiresApproval = req\.path === "\/api\/analyst\/refresh\/weather"/);
  assert.match(app, /weatherRetryRequiresApproval \|\| isProduction/);

  assert.match(spec, /\/analyst\/refresh\/weather:[\s\S]*Retry optional Open-Meteo weather enrichment for one Eastern MLB slate date/);
  assert.match(spec, /WeatherRefreshResult:/);
  assert.match(spec, /weatherRefresh:/);

  assert.match(ui, /data-testid="button-retry-weather"/);
  assert.match(ui, /Retry Open-Meteo forecasts for this Eastern slate date only/);
  assert.match(ui, /No model, engine, or unrelated ingest work was run/);
  assert.match(ui, /Latest weather refresh/);
});