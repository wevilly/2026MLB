/**
 * Every test file is run by at least one package script.
 *
 * Four test files existed in tests/ and appeared in neither test:unit nor
 * test:all: readiness-contract, batter-pitcher-research,
 * batter-pitcher-event-revision and task-50-operations-recovery. Two of them
 * had been failing silently for some time, because Task 5.2 split
 * routes/analyst.ts into domain modules and both were still reading the path
 * that is now only a mount barrel.
 *
 * A test that never runs is worse than no test, because it reads as coverage.
 * This is the guard that stops a new one being added and forgotten.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

test("no test file is left out of every package script", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const scripts = Object.values(pkg.scripts).join(" ");
  const testFiles = readdirSync(new URL("../tests/", import.meta.url))
    .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.mjs"));

  assert.ok(testFiles.length > 0, "expected to find test files to check");

  const orphans = testFiles.filter((name) => !scripts.includes(`tests/${name}`));
  assert.deepEqual(
    orphans, [],
    `these test files are run by no package script, so they read as coverage without being coverage: ${orphans.join(", ")}`,
  );
});
