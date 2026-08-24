import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("BvP foundation is canonical-ID event history with immutable effective-date snapshots", () => {
  const schema = read("lib/db/src/schema/foundation.ts");
  const service = read("artifacts/api-server/src/services/batter-pitcher-research.ts");
  for (const table of ["batter_pitcher_events", "batter_pitcher_snapshots", "batter_pitch_type_snapshots", "batter_pitch_type_features"]) {
    assert.ok(schema.includes(table), `missing BvP foundation table ${table}`);
  }
  assert.ok(schema.includes('batterId: integer("batter_id").notNull().references(() => players.playerId)'));
  assert.ok(schema.includes('pitcherId: integer("pitcher_id").notNull().references(() => players.playerId)'));
  assert.ok(service.includes("requires two resolved canonical MLB player IDs; name-only joins are prohibited"));
  assert.ok(service.includes("effective_to <= $3"), "BvP reads must remain point-in-time bounded");
  assert.ok(service.includes("ON CONFLICT (batter_id,pitcher_id,effective_to,content_checksum) DO NOTHING"), "corrected source content must create a new immutable snapshot");
  assert.ok(!service.includes('hfSea: `${end.slice(0, 4)}|`'), "career BvP must not silently truncate history to one season");
  assert.ok(service.includes("bvpAgeDaysAtAsOf(snapshot.age_days, snapshot.effective_to, effectiveDate)"), "a later as-of read must recompute BvP age");
  assert.ok(service.includes("ORDER BY source_event_key, retrieved_at DESC, event_id DESC"), "rollups must select the latest immutable source-event revision");
  assert.ok(service.includes("ON CONFLICT (source_id, source_event_key, content_checksum) DO NOTHING"), "corrected source events must append a revision");
  const immutable = read("lib/db/scripts/apply-immutability.mjs");
  for (const trigger of ["batter_pitcher_events_immutable", "batter_pitcher_snapshots_immutable", "batter_pitch_type_snapshots_immutable", "batter_pitch_type_features_immutable"]) {
    assert.ok(immutable.includes(trigger), `missing DB-level append-only trigger ${trigger}`);
  }
});

test("BvP sample bands and ranking guardrails keep named history subordinate", () => {
  const service = read("artifacts/api-server/src/services/batter-pitcher-research.ts");
  for (const band of ['"ANECDOTE"', '"WEAK_CONTEXT"', '"SECONDARY_CONTEXT"', '"MEANINGFUL_SUPPORT"']) {
    assert.ok(service.includes(band), `missing sample band ${band}`);
  }
  assert.ok(service.includes("const MIN_CONTEXT_PA = 25"));
  assert.ok(service.includes("const MAX_RANK_ADJUSTMENT = 0.25"));
  assert.ok(service.includes("smallSample ? 0"), "sub-25 PA named history must have no ranking effect");
  assert.ok(service.includes("Math.max(-MAX_RANK_ADJUSTMENT, Math.min(MAX_RANK_ADJUSTMENT"), "BvP impact must be bounded in either direction");
  assert.ok(service.includes("Math.exp(-ageDays / 730)"), "old named history must decay instead of receiving full weight");
});

test("BvP slate refresh uses FantasyPros pregame lineups even when a newer official lineup exists", () => {
  const service = read("artifacts/api-server/src/services/batter-pitcher-research.ts");
  const selector = service.match(/WITH latest_lineup AS \([\s\S]*?\n\s*\), latest_starter/)?.[0] ?? "";
  assert.ok(selector.includes("ls.source_id = 'FANTASYPROS'"));
  assert.ok(selector.includes("ls.state IN ('CONFIRMED', 'PROJECTED')"));
  assert.ok(selector.includes("CASE WHEN ls.state = 'CONFIRMED' THEN 1 ELSE 2 END"));
  assert.ok(!selector.includes("POSTED"), "official posted lineups must not enter BvP pregame pairs even if newer");
  assert.ok(!selector.includes("MLB_OFFICIAL"), "BvP pregame lineup selection must not use MLB source rows");
});

test("market engines and Round Robin expose BvP only as bounded research context", () => {
  for (const [file, market] of [
    ["tb-engine.ts", "TB"], ["xbh-engine.ts", "XBH"], ["walk-engine.ts", "WALK"], ["hr-engine.ts", "HR"],
  ]) {
    const engine = read(`artifacts/api-server/src/services/${file}`);
    assert.ok(engine.includes(`getBatterPitcherEvidence(player.playerId, starter.playerId, slateDate, "${market}")`));
    assert.ok(engine.includes("baseEvidenceScore + (bvp?.rankAdjustment ?? 0)"));
    assert.ok(engine.includes("baseEvidenceScore"), "BvP must not change persisted research state");
    assert.ok(!engine.includes("player.battingOrder !== null, evidenceScore"), "adjusted BvP score must not cross a persisted state threshold");
  }
  const roundRobin = read("artifacts/mlb-analyst/src/pages/round-robin-page.tsx");
  assert.ok(roundRobin.includes("BvP ·"));
  assert.ok(roundRobin.includes("arsenal compared"));
  const route = read("artifacts/api-server/src/routes/analyst.ts");
  assert.ok(route.includes('router.get("/analyst/batter-pitcher"'));
  assert.ok(route.includes("RefreshAnalystBatterPitcherResponse"));
  assert.ok(route.includes("starter_matchup_evidence?.starterPlayerId"), "market BvP must use the starter persisted with candidate evidence");
  assert.ok(!route.includes("JOIN lineup_snapshots ls ON ls.game_pk = s.game_pk"), "market BvP must not re-derive a later starter from mutable slate observations");
});