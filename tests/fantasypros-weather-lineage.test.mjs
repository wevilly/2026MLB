import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FantasyPros lineup weather is stored as the preferred, auditable weather source", async () => {
  const [ingest, weather, ui] = await Promise.all([
    readFile("artifacts/api-server/src/services/data-foundation.ts", "utf8"),
    readFile("artifacts/api-server/src/services/weather-foundation.ts", "utf8"),
    readFile("artifacts/mlb-analyst/src/App.tsx", "utf8"),
  ]);

  assert.match(ingest, /ingestFantasyProsWeatherObservations\(effectiveDate, lineups\.payload\)/);
  assert.match(weather, /FANTASYPROS_WEATHER_SOURCE = "FANTASYPROS"/);
  assert.match(weather, /gamePayload\.weather/);
  assert.match(weather, /gamePayload\.temp/);
  assert.match(weather, /gamePayload\.wind_direction/);
  assert.match(weather, /CASE source_id WHEN '\$\{FANTASYPROS_WEATHER_SOURCE\}' THEN 0 ELSE 1 END/);
  assert.match(ui, /FantasyPros weather is captured with projected lineups/);
});