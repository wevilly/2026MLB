import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const ts = require("typescript");

async function loadCacheModule(configuredLimit) {
  const source = await readFile("artifacts/api-server/src/services/cache.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const previous = process.env.API_CACHE_MAX_ENTRIES;
  if (configuredLimit === undefined) delete process.env.API_CACHE_MAX_ENTRIES;
  else process.env.API_CACHE_MAX_ENTRIES = configuredLimit;
  new Function("exports", "module", compiled)(module.exports, module);
  if (previous === undefined) delete process.env.API_CACHE_MAX_ENTRIES;
  else process.env.API_CACHE_MAX_ENTRIES = previous;
  return module.exports;
}

test("Phase 10 cache falls back safely for malformed limits and coalesces concurrent reads", async () => {
  const cache = await loadCacheModule("not-a-number");
  assert.equal(cache.cacheStatus().maxEntries, 500);
  let loads = 0;
  const values = await Promise.all(Array.from({ length: 12 }, () => cache.readThroughCache("one-key", 1_000, async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "shared";
  })));
  assert.equal(loads, 1);
  assert.deepEqual(values, Array(12).fill("shared"));
});

test("Phase 10 restore verification rejects incomplete records and broken lineage", async () => {
  const { validateRestoreSummary } = await import("../lib/db/scripts/restore-verification.mjs");
  assert.throws(() => validateRestoreSummary({
    orchestrationRuns: 1, pregameFeatureSnapshots: 0, historicalOutcomes: 1, marketPostmortems: 1, auditEvents: 1,
    snapshotsWithOutcome: 1, linkedPostmortems: 1,
  }), /required records are empty/);
  assert.throws(() => validateRestoreSummary({
    orchestrationRuns: 1, pregameFeatureSnapshots: 1, historicalOutcomes: 1, marketPostmortems: 2, auditEvents: 1,
    snapshotsWithOutcome: 1, linkedPostmortems: 1,
  }), /not fully linked/);
  assert.doesNotThrow(() => validateRestoreSummary({
    orchestrationRuns: 1, pregameFeatureSnapshots: 2, historicalOutcomes: 2, marketPostmortems: 1, auditEvents: 3,
    snapshotsWithOutcome: 2, linkedPostmortems: 1,
  }));
});