import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("historical intelligence keeps source observations, context, and derived profiles distinct", () => {
  const schema = read("lib/db/src/schema/foundation.ts");

  for (const table of [
    "historicalIntelligenceRuns",
    "historicalSourceCoverage",
    "historicalGameContexts",
    "historicalPlayerObservations",
    "playerIntelligenceFeatures",
  ]) {
    assert.match(schema, new RegExp(`export const ${table} = pgTable`));
  }

  assert.match(schema, /rawPayloadId: uuid\("raw_payload_id"\)/);
  assert.match(schema, /sourcePlayerId: text\("source_player_id"\)\.notNull\(\)/);
  assert.match(schema, /numerator: numeric\("numerator"\)/);
  assert.match(schema, /denominator: numeric\("denominator"\)/);
  assert.match(schema, /sampleSize: integer\("sample_size"\)\.notNull\(\)/);
  assert.match(schema, /transformationVersion: text\("transformation_version"\)\.notNull\(\)/);
  assert.match(schema, /sourceInputChecksum: text\("source_input_checksum"\)\.notNull\(\)/);
});

test("historical materialization is bounded, canonical-ID-only, and outside daily orchestration", () => {
  const [service, orchestration] = [
    read("artifacts/api-server/src/services/historical-intelligence.ts"),
    read("artifacts/api-server/src/services/orchestration.ts"),
  ];

  assert.match(service, /configured 2024-2026 seed horizon/);
  assert.match(service, /batter_pitcher_events/);
  assert.match(service, /source_player_id/);
  assert.match(service, /is_terminal_plate_appearance/);
  assert.match(service, /descriptiveSplitCaveat/);
  assert.match(service, /DISTINCT ON \(o\.source_id, o\.source_event_key, o\.source_player_id\)/);
  assert.match(service, /source_input_checksum/);
  assert.match(service, /decodeCursor/);
  assert.match(service, /Additional retained event keys remain/);
  assert.match(service, /await materializeContexts\(batch, client\)/);
  assert.match(service, /e\.retrieved_at/);
  assert.match(service, /count\(DISTINCT concat_ws\('\|', o\.source_id, o\.source_event_key, o\.source_player_id\)\)/);
  assert.match(service, /contextObservedAt/);
  assert.match(service, /COALESCE\(context_id::text, 'NO_CONTEXT'\)/);
  assert.match(service, /participant_role/);
  assert.match(service, /statcast_historical_intelligence_seed/);
  assert.match(service, /historical_source_coverage/);
  assert.match(service, /season_ranges/);
  assert.match(service, /const matchesTarget = target\.role === "HITTER"/);
  assert.match(service, /batters_faced/);
  assert.match(service, /runHistoricalIntelligenceBackfillStep/);
  assert.match(service, /startHistoricalIntelligenceBackfillWorker/);
  assert.match(service, /coverage\.status = 'SUCCESS'/);
  assert.match(service, /allRequiredRangesComplete/);
  assert.match(service, /row\.event_count === 0/);
  assert.match(service, /coverage\.status = 'PARTIAL'/);
  assert.match(service, /NOT EXISTS \(\s*SELECT 1 FROM historical_source_coverage success/);
  assert.match(service, /to > "2026-11-30" \? "2026-11-30" : to/);
  assert.match(service, /pg_try_advisory_lock/);
  assert.match(service, /pg_advisory_unlock/);
  assert.match(service, /input\.target/);
  assert.match(service, /b\.batter_id = \$6/);
  const app = read("artifacts/api-server/src/app.ts");
  // The live Statcast historical backfill is retired under the API-backed
  // daily source contract (the refresh route returns a retirement notice), so
  // the server must NOT start the background worker any more. The worker code
  // is retained above as legacy audit machinery, never scheduled.
  assert.doesNotMatch(app, /startHistoricalIntelligenceBackfillWorker\(\)/);
  const refreshRoutes = read("artifacts/api-server/src/routes/analyst/refresh.ts");
  assert.match(refreshRoutes, /Historical live Statcast refresh is retired/);
  const analystUi = read("artifacts/mlb-analyst/src/App.tsx");
  assert.doesNotMatch(analystUi, /button-materialize-history/);
  const foundation = read("artifacts/api-server/src/services/research-foundation.ts");
  assert.match(foundation, /Persistent historical intelligence · descriptive/);
  assert.match(foundation, /participantRole/);
  assert.doesNotMatch(orchestration, /materializeHistoricalIntelligence/);
});

test("the public contract and database policy expose explicit coverage without allowing rewrites", () => {
  const [contract, policy, docs] = [
    read("lib/api-spec/openapi.yaml"),
    read("lib/db/scripts/apply-immutability.mjs"),
    read("docs/player-intelligence-source-contracts.md"),
  ];

  assert.match(contract, /\/analyst\/refresh\/historical-intelligence:/);
  assert.match(contract, /\/analyst\/historical-intelligence\/coverage:/);
  assert.match(contract, /name: cursor/);
  assert.match(contract, /enum: \[READY, PARTIAL, NOT_FOUND, BLOCKED\]/);
  assert.match(policy, /historical_game_contexts_append_only/);
  assert.match(policy, /historical_player_observations_append_only/);
  assert.match(policy, /player_intelligence_features_append_only/);
  assert.match(docs, /Ballpark Pal/);
  assert.match(docs, /daily orchestration critical path/);
});