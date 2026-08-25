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
  assert.match(weather, /async function fantasyProsWeatherGamePks/);
  assert.match(weather, /source_id = \$2/);
  assert.match(weather, /fantasyProsFallbackGamePks\.push\(game\.gamePk\)/);
  assert.match(weather, /openMeteoRetrievedGamePks\.push\(game\.gamePk\)/);
  assert.match(weather, /fantasyProsFallbackGamePks: metadata\.fantasyProsFallbackGamePks/);
  assert.match(ui, /FantasyPros weather is captured with projected lineups/);
});

test("only current projected-lineup identity failures block readiness", async () => {
  const source = await readFile("artifacts/api-server/src/routes/analyst/shared.ts", "utf8");
  const coverage = source.slice(source.indexOf("export async function identityCoverage"), source.indexOf("export async function analystDataHealth"));
  const health = source.slice(source.indexOf("export async function analystDataHealth"));

  assert.match(coverage, /current_projected_lineup_identity_failures AS/);
  assert.match(coverage, /latest_projected_lineups l/);
  assert.match(coverage, /pe\.eligible_lineup_projection AND NOT pe\.requires_identity_review/);
  assert.match(coverage, /count\(\*\)::int FROM current_projected_lineup_identity_failures/);
  assert.match(coverage, /broad FantasyPros projection-component[\s\S]*not a readiness blocker/);
  assert.doesNotMatch(health, /coverage\.unresolvedActivePlayers \|\| coverage\.blockingProjectedLineupIssues/);
  assert.match(health, /coverage\.blockingProjectedLineupIssues\s*\?\s*\[\`\$\{coverage\.blockingProjectedLineupIssues\} current projected-lineup identity/);
});