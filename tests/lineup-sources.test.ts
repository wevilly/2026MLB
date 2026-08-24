/**
 * Task 2.7 acceptance.
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

describe("Task 2.7 lineup source precedence", () => {
  test("a submitted MLB card outranks a FantasyPros projection", async () => {
    const { resolveLineups } = await lineups;
    const resolved = resolveLineups([
      entry("FANTASYPROS", 1, 10, 100, 1, "PROJECTED"),
      entry("FANTASYPROS", 1, 10, 101, 2, "PROJECTED"),
      entry("MLB_OFFICIAL", 1, 10, 100, 1, "POSTED"),
      entry("MLB_OFFICIAL", 1, 10, 101, 2, "POSTED"),
    ]);
    assert.deepEqual(resolved.players.map((p: { sourceId: string }) => p.sourceId), ["MLB_OFFICIAL", "MLB_OFFICIAL"]);
    assert.equal(resolved.selectedSourceByTeam.get("1:10").lineupState, "POSTED");
    assert.deepEqual(resolved.conflicts, []);
  });

  test("a game the primary source is missing still produces players from the secondary", async () => {
    const { resolveLineups } = await lineups;
    const resolved = resolveLineups([
      // Game 1 has the submitted card. Game 2 only has the projection.
      entry("MLB_OFFICIAL", 1, 10, 100, 1, "POSTED"),
      entry("FANTASYPROS", 2, 20, 200, 1, "PROJECTED"),
      entry("FANTASYPROS", 2, 20, 201, 2, "PROJECTED"),
    ]);
    const gameTwo = resolved.players.filter((p: { gamePk: number }) => p.gamePk === 2);
    assert.equal(gameTwo.length, 2, "the missing primary source must not eliminate the game");
    assert.equal(resolved.selectedSourceByTeam.get("2:20").sourceId, "FANTASYPROS");
  });

  test("a disagreement is recorded on the affected player and not silently resolved", async () => {
    const { resolveLineups, conflictsFor } = await lineups;
    const resolved = resolveLineups([
      entry("MLB_OFFICIAL", 1, 10, 100, 1, "POSTED"),
      entry("MLB_OFFICIAL", 1, 10, 102, 2, "POSTED"),
      entry("FANTASYPROS", 1, 10, 100, 1, "PROJECTED"),
      entry("FANTASYPROS", 1, 10, 101, 2, "PROJECTED"),
    ]);
    assert.equal(resolved.conflicts.length, 2, "both disputed players must be recorded");
    const disputed = resolved.conflicts.map((c: { playerId: number }) => c.playerId).sort();
    assert.deepEqual(disputed, [101, 102]);

    const onlyInProjection = conflictsFor(resolved, 1, 101)[0];
    assert.deepEqual(onlyInProjection.presentIn, ["FANTASYPROS"]);
    assert.deepEqual(onlyInProjection.absentFrom, ["MLB_OFFICIAL"]);
    assert.match(onlyInProjection.detail, /Lineup source conflict/);

    // The undisputed player carries no conflict.
    assert.deepEqual(conflictsFor(resolved, 1, 100), []);
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
    const { lineupSourceFilter, LINEUP_SOURCE_PRECEDENCE } = await lineups;
    const filter = lineupSourceFilter();
    assert.equal(filter.sourceIds.length, filter.states.length);
    assert.ok(filter.sourceIds.includes("MLB_OFFICIAL"));
    assert.ok(filter.sourceIds.includes("FANTASYPROS"));
    assert.ok(filter.states.includes("POSTED"));
    for (const rule of LINEUP_SOURCE_PRECEDENCE) {
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

  test("every engine records lineup conflicts as a blocking evidence gap", () => {
    for (const file of files.slice(0, 4)) {
      const source = readFileSync(file, "utf8");
      assert.ok(source.includes("querySlateLineupPlayers"), `${file} must use the shared reader`);
      assert.ok(source.includes("conflictsFor(resolvedLineups"), `${file} must annotate conflicted candidates`);
      assert.ok(source.includes("missingData.push(conflict.detail)"), `${file} must block on the conflict`);
    }
  });
});

describe("Task 2.7 POSTED has a producer", () => {
  test("data-foundation writes POSTED snapshots and the precedence list reads them", async () => {
    const { LINEUP_SOURCE_PRECEDENCE } = await lineups;
    const producer = readFileSync("artifacts/api-server/src/services/data-foundation.ts", "utf8");
    assert.ok(/VALUES \(\$1, \$2, 'POSTED'/.test(producer), "data-foundation must write POSTED");
    const mlb = LINEUP_SOURCE_PRECEDENCE.find((rule: { sourceId: string }) => rule.sourceId === "MLB_OFFICIAL");
    assert.ok(mlb.states.includes("POSTED"), "the precedence list must read POSTED");
  });

  test("the comparison ranks and describes POSTED rather than ignoring it", () => {
    const source = readFileSync("artifacts/api-server/src/services/round-robin-comparison.ts", "utf8");
    assert.ok(/lineupState === "POSTED" \? 3/.test(source), "POSTED must outrank CONFIRMED for freshness");
    assert.ok(source.includes("MLB posted lineup cards"), "POSTED must have its own evidence wording");
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
