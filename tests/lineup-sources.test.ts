/**
 * Projected lineup pregame policy.
 *
 * getSlateLineupPlayers filtered source_id = 'FANTASYPROS' inside its own SQL,
 * in four engines and again in the Round Robin route. There was no second
 * source and no conflict detection, so a missing or wrong FantasyPros feed for
 * one game produced no candidates for that game at all, silently.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { bundleService } from "./helpers/bundle.ts";


const lineups = bundleService("artifacts/api-server/src/services/lineup-sources.ts");

function entry(sourceId: string, gamePk: number, teamId: number, playerId: number, order: number, state: string) {
  return {
    sourceId, gamePk, teamId, playerId, battingOrder: order,
    lineupState: state, playerName: `Player ${playerId}`,
  };
}

describe("pregame lineup source policy", () => {
  test("a later submitted MLB card cannot replace the FantasyPros projected research input", async () => {
    const { resolveLineups } = await lineups;
    const resolved = resolveLineups([
      entry("FANTASYPROS", 1, 10, 100, 1, "PROJECTED"),
      entry("FANTASYPROS", 1, 10, 101, 2, "PROJECTED"),
      entry("MLB_OFFICIAL", 1, 10, 100, 1, "POSTED"),
      entry("MLB_OFFICIAL", 1, 10, 101, 2, "POSTED"),
    ]);
    assert.deepEqual(resolved.players.map((p: { sourceId: string }) => p.sourceId), ["FANTASYPROS", "FANTASYPROS"]);
    assert.equal(resolved.selectedSourceByTeam.get("1:10").lineupState, "PROJECTED");
    assert.deepEqual(resolved.conflicts, []);
  });

  test("a projected-only game remains usable before a posted MLB card arrives", async () => {
    const { resolveLineups } = await lineups;
    const resolved = resolveLineups([
      entry("FANTASYPROS", 2, 20, 200, 1, "PROJECTED"),
      entry("FANTASYPROS", 2, 20, 201, 2, "PROJECTED"),
    ]);
    const gameTwo = resolved.players.filter((p: { gamePk: number }) => p.gamePk === 2);
    assert.equal(gameTwo.length, 2, "a missing posted card must not eliminate the projected game");
    assert.equal(resolved.selectedSourceByTeam.get("2:20").sourceId, "FANTASYPROS");
  });

  test("posted-versus-projected changes stay out of the pregame conflict gate", async () => {
    const { resolveLineups, conflictsFor } = await lineups;
    const resolved = resolveLineups([
      entry("MLB_OFFICIAL", 1, 10, 100, 1, "POSTED"),
      entry("MLB_OFFICIAL", 1, 10, 102, 2, "POSTED"),
      entry("FANTASYPROS", 1, 10, 100, 1, "PROJECTED"),
      entry("FANTASYPROS", 1, 10, 101, 2, "PROJECTED"),
    ]);
    assert.deepEqual(resolved.conflicts, []);
    assert.deepEqual(conflictsFor(resolved, 1, 101), []);
    assert.deepEqual(resolved.players.map((player: { playerId: number }) => player.playerId), [100, 101]);
  });

  test("a single source produces no conflicts", async () => {
    const { resolveLineups } = await lineups;
    const resolved = resolveLineups([
      entry("FANTASYPROS", 1, 10, 100, 1, "PROJECTED"),
      entry("FANTASYPROS", 1, 10, 101, 2, "PROJECTED"),
    ]);
    assert.deepEqual(resolved.conflicts, []);
    assert.equal(resolved.players.length, 2);
  });

  test("the accepted source and state pairs are query parameters, not literals", async () => {
    const { lineupSourceFilter, PREGAME_LINEUP_SOURCE_PRECEDENCE } = await lineups;
    const filter = lineupSourceFilter();
    assert.equal(filter.sourceIds.length, filter.states.length);
    assert.ok(filter.sourceIds.includes("FANTASYPROS"));
    assert.deepEqual(filter.sourceIds, ["FANTASYPROS"]);
    assert.deepEqual(filter.states, ["PROJECTED"]);
    for (const rule of PREGAME_LINEUP_SOURCE_PRECEDENCE) {
      assert.ok(rule.rationale.length > 0, "each source must state why it sits where it does");
    }
  });
});

describe("Task 2.7 no consumer hardcodes the lineup source", () => {
  const files = [
    "artifacts/api-server/src/services/tb-engine.ts",
    "artifacts/api-server/src/services/walk-engine.ts",
    "artifacts/api-server/src/services/xbh-engine.ts",
    "artifacts/api-server/src/services/hr-engine.ts",
    // Task 5.2 moved the Round Robin route into its own domain module.
    "artifacts/api-server/src/routes/analyst/research.ts",
  ];

  test("no engine pins the lineup source inside its SQL", () => {
    for (const file of files.slice(0, 4)) {
      const source = readFileSync(file, "utf8");
      assert.ok(
        !/source_id = 'FANTASYPROS'/.test(source),
        `${file} still pins the lineup source inside its SQL`,
      );
    }
  });

  test("the Round Robin lineup selection is parameterised", () => {
    const source = readFileSync("artifacts/api-server/src/routes/analyst/research.ts", "utf8");
    const shared = readFileSync("artifacts/api-server/src/routes/analyst/shared.ts", "utf8");
    const cte = source.slice(source.indexOf("latest_lineup AS ("), source.indexOf("SELECT mrc.candidate_id"));
    assert.ok(!/source_id = 'FANTASYPROS'/.test(cte), "the selection CTE must not pin a source");
    assert.ok(cte.includes("JOIN accepted a"), "the selection CTE must join the accepted source and state pairs");
    assert.ok(
      source.includes("ROUND_ROBIN_LINEUP_FILTER") && shared.includes("ROUND_ROBIN_LINEUP_FILTER"),
      "the pairs must come from the shared precedence list",
    );
    // The readiness counters elsewhere in this file deliberately count each
    // source separately; they select nothing and are not part of this defect.
  });

  test("every engine reads the shared projected-lineup resolver", () => {
    for (const file of files.slice(0, 4)) {
      const source = readFileSync(file, "utf8");
      assert.ok(source.includes("querySlateLineupPlayers"), `${file} must use the shared reader`);
      assert.ok(source.includes("conflictsFor(resolvedLineups"), `${file} must retain the resolver's audit annotations`);
    }
    const batterPitcher = readFileSync("artifacts/api-server/src/services/batter-pitcher-research.ts", "utf8");
    assert.ok(batterPitcher.includes("PREGAME_LINEUP_SOURCE_PRECEDENCE"), "BvP slate refresh must use the shared pregame policy");
    assert.ok(batterPitcher.includes("JOIN accepted a ON a.source_id = ls.source_id"), "BvP refresh must scope its pair universe to the accepted projected lineup");
    const featureStore = readFileSync("artifacts/api-server/src/services/feature-store.ts", "utf8");
    assert.ok(featureStore.includes("PREGAME_LINEUP_SOURCE_PRECEDENCE"), "feature snapshots must use the shared pregame policy");
    assert.ok(featureStore.includes("JOIN accepted a ON a.source_id = ls.source_id"), "feature snapshots must scope batter teams to the projected lineup");
  });
});

describe("posted cards remain auditable without becoming research input", () => {
  test("data-foundation writes POSTED snapshots while the pregame policy excludes them", async () => {
    const { PREGAME_LINEUP_SOURCE_PRECEDENCE, OFFICIAL_LINEUP_AUDIT_SOURCE } = await lineups;
    const producer = readFileSync("artifacts/api-server/src/services/data-foundation.ts", "utf8");
    assert.ok(/VALUES \(\$1, \$2, 'POSTED'/.test(producer), "data-foundation must write POSTED");
    assert.ok(!PREGAME_LINEUP_SOURCE_PRECEDENCE.some((rule: { sourceId: string }) => rule.sourceId === "MLB_OFFICIAL"));
    assert.equal(OFFICIAL_LINEUP_AUDIT_SOURCE[0].sourceId, "MLB_OFFICIAL");
    assert.ok(OFFICIAL_LINEUP_AUDIT_SOURCE[0].states.includes("POSTED"));
  });

  test("Round Robin uses the shared projected policy and calls out its input", () => {
    const source = readFileSync("artifacts/api-server/src/services/round-robin-comparison.ts", "utf8");
    const shared = readFileSync("artifacts/api-server/src/routes/analyst/shared.ts", "utf8");
    assert.ok(shared.includes("PREGAME_LINEUP_SOURCE_PRECEDENCE"));
    assert.ok(source.includes("FantasyPros projected lineups (pregame research input)"));
  });
});

describe("Task 2.7 name collisions are raised, not resolved", () => {
  test("a name carried by more than one club refuses to resolve to the first row", () => {
    const source = readFileSync("artifacts/api-server/src/services/research-foundation.ts", "utf8");
    const guard = source.slice(source.indexOf("// Name collision protection."), source.indexOf("const selectedId ="));
    assert.ok(guard.includes("AMBIGUOUS PLAYER NAME"), "the collision must be raised with a named status");
    assert.ok(guard.includes("collidingClubs.size > 1"), "the guard must key on more than one club");
    assert.ok(guard.includes("playerId == null"), "an explicit player id must still resolve");
    assert.ok(/profile: null/.test(guard), "an ambiguous name must not return a profile");
  });
});
