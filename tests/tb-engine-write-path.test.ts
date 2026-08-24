/**
 * Task 2.6 acceptance.
 *
 * runTBEngine wrote candidates and evidence blocks in a bare loop on the shared
 * pool, then reconciled, with none of it in a transaction. A failure partway
 * through left a partially populated board next to an ingest run marked FAILED,
 * and the next reader saw a board that looked real and was not.
 *
 * The write path is exercised here against a recording executor, so the
 * statement count and the failure behaviour are asserted without a database.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "../artifacts/api-server/node_modules/esbuild/lib/main.js";

const STUB = "export const pool = { query() { throw new Error('no database in this test'); } };\nexport const db = {};\n";

const engine = (async () => {
  const result = await build({
    entryPoints: ["artifacts/api-server/src/services/tb-engine.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "tb-engine-stubs",
      setup(pluginBuild: any) {
        pluginBuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "tb-stub" }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "tb-stub" }, () => ({ contents: STUB, loader: "js" }));
      },
    }],
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
})();

/** Records every statement and can be told to fail on the nth one. */
function recordingExecutor(options: { failOnStatement?: number } = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  return {
    statements,
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (options.failOnStatement === statements.length) {
        throw new Error("injected failure");
      }
      // Echo back a candidate id per row so the caller can map evidence blocks.
      const rows = /RETURNING candidate_id/.test(sql)
        ? Array.from({ length: values.length / 17 }, (_, index) => ({
          candidate_id: `candidate-${index}`,
          player_id: values[index * 17 + 2],
          game_pk: String(values[index * 17 + 1]),
        }))
        : [{ count: "0" }];
      return { rows };
    },
  };
}

function candidate(playerId: number) {
  return {
    playerId,
    playerName: `Player ${playerId}`,
    gamePk: 770000 + (playerId % 10),
    slateDate: "2026-08-24",
    battingOrder: (playerId % 9) + 1,
    lineupState: "CONFIRMED",
    hitterBats: "R",
    starterPlayerId: 500000,
    starterThrows: "L",
    starterState: "CONFIRMED",
    hitterFeatures: new Map<string, number | null>([["xslg", 0.44], ["iso", 0.19], ["pa", 500]]),
    pitcherFeatures: new Map<string, number | null>([["xslg_allowed", 0.40], ["bf", 600]]),
    parkFeatures: new Map<string, number | null>([["hr_factor", 104]]),
    bullpen: {
      status: "CURRENT", reason: null, computedAt: "2026-08-24T15:00:00.000Z",
      rolePath: [], armIds: [], availableArms: 0,
      availableHighLeverage: 0, avgXSLGAllowed: null, metricArmCount: 0, metricCoverage: 0,
    },
    mechanism: "POWER_ROUTE",
    secondaryMechanism: null,
    researchState: "POSITIVE",
    counterEvidence: [],
    evidenceScore: 5,
    researchRank: 1,
    missingData: [],
  };
}

describe("Task 2.6 the write path is batched", () => {
  test("180 candidates cost a handful of statements, not one per candidate", async () => {
    const { writeCandidates, buildEvidenceBlocks, writeEvidenceBlocks } = await engine;
    const candidates = Array.from({ length: 180 }, (_, index) => candidate(600000 + index));
    const executor = recordingExecutor();

    const ids = await writeCandidates(executor, candidates, "run-1");
    const candidateStatements = executor.statements.length;
    assert.ok(candidateStatements <= 2, `expected at most 2 statements, got ${candidateStatements}`);
    assert.equal(ids.size > 0, true);

    const rows = candidates.flatMap((c, index) =>
      buildEvidenceBlocks(c).map((block: unknown) => ({ candidateId: `candidate-${index}`, block })));
    assert.ok(rows.length > 180, "each candidate produces several evidence blocks");
    await writeEvidenceBlocks(executor, rows);
    const evidenceStatements = executor.statements.length - candidateStatements;
    assert.ok(
      evidenceStatements <= Math.ceil(rows.length / 300),
      `expected chunked inserts, got ${evidenceStatements} for ${rows.length} rows`,
    );

    // The previous implementation issued one candidate insert plus one insert
    // per evidence block: over a thousand sequential round trips for this slate.
    const previousStatementCount = candidates.length + rows.length;
    assert.ok(previousStatementCount > 1000);
    assert.ok(executor.statements.length < previousStatementCount / 100);
  });

  test("a duplicate evidence block key cannot abort the statement", async () => {
    const { writeEvidenceBlocks } = await engine;
    const block = {
      blockType: "OPPORTUNITY", metricKey: "batting_order", metricLabel: "Batting order slot",
      value: 2, unit: "slot", sampleSize: null, direction: "FAVORABLE", strength: "STRONG",
      narrative: "x", rawEvidence: {},
    };
    const executor = recordingExecutor();
    const written = await writeEvidenceBlocks(executor, [
      { candidateId: "c1", block },
      { candidateId: "c1", block },
    ]);
    assert.equal(written, 1, "a multi-row ON CONFLICT cannot affect the same row twice");
  });

  test("a failure partway through propagates rather than being swallowed", async () => {
    const { writeCandidates } = await engine;
    const candidates = Array.from({ length: 400 }, (_, index) => candidate(700000 + index));
    const executor = recordingExecutor({ failOnStatement: 2 });
    await assert.rejects(() => writeCandidates(executor, candidates, "run-2"), /injected failure/);
  });
});

describe("Task 2.6 the slate is written atomically", () => {
  const source = readFileSync("artifacts/api-server/src/services/tb-engine.ts", "utf8");

  test("the writes and the reconcile run inside one transaction", () => {
    const transactional = source.slice(source.indexOf("const client = await pool.connect();"));
    const begin = transactional.indexOf('client.query("BEGIN")');
    const writes = transactional.indexOf("writeCandidates(client");
    const blocks = transactional.indexOf("writeEvidenceBlocks(client");
    const reconcile = transactional.indexOf("reconcileSlateCandidates(client");
    const commit = transactional.indexOf('client.query("COMMIT")');
    assert.ok(begin >= 0 && writes > begin && blocks > writes && reconcile > blocks && commit > reconcile,
      "BEGIN, writes, evidence blocks, reconcile, COMMIT in that order");
    assert.ok(transactional.includes('client.query("ROLLBACK")'), "a failure must roll back");
    assert.ok(transactional.includes("client.release()"), "the client must be released");
  });

  test("no candidate or evidence write runs on the shared pool", () => {
    for (const call of ["writeCandidates(pool", "writeEvidenceBlocks(pool"]) {
      assert.ok(!source.includes(call), `${call} would write outside the transaction`);
    }
  });

  test("every market engine writes its slate inside a transaction", () => {
    for (const engine of ["tb-engine", "walk-engine", "xbh-engine", "hr-engine"]) {
      const engineSource = readFileSync(`artifacts/api-server/src/services/${engine}.ts`, "utf8");
      const transactional = engineSource.slice(engineSource.indexOf("const client = await pool.connect();"));
      assert.ok(transactional.includes('client.query("BEGIN")'), `${engine} must open a transaction`);
      assert.ok(transactional.includes('client.query("COMMIT")'), `${engine} must commit`);
      assert.ok(transactional.includes('client.query("ROLLBACK")'), `${engine} must roll back on failure`);
      assert.ok(transactional.includes("reconcileSlateCandidates(client"), `${engine} must reconcile inside the transaction`);
      assert.ok(transactional.includes("client.release()"), `${engine} must release the client`);
    }
    // hrrbi-engine writes its whole slate in one set-based statement and has no
    // reconcile step, so it is atomic without an explicit transaction.
    const hrrbi = readFileSync("artifacts/api-server/src/services/hrrbi-engine.ts", "utf8");
    assert.ok(!hrrbi.includes("for (const c of candidates)"), "hrrbi-engine has no per-candidate write loop");
  });

  test("the batter-pitcher lookup is cached by batter and starter", () => {
    assert.ok(source.includes("bvpCache"), "the per-candidate lookup must be cached");
    const loop = source.slice(source.indexOf("const bvpKey ="), source.indexOf("const evidenceScore ="));
    assert.ok(loop.includes("if (!bvpCache.has(bvpKey))"), "the cache must be consulted before the query");
  });
});
