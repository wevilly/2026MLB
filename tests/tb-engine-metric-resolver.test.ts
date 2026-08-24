/**
 * Task 2.5 acceptance.
 *
 * The iso metric had two resolution paths in one engine: classifyMechanism read
 * the platoon split with an unsplit fallback, computeEvidenceScore read the
 * unsplit season value with no fallback. The same player in the same pass could
 * therefore be classified POWER_ROUTE on his split iso and scored on his
 * unsplit iso.
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

describe("Task 2.5 one resolver per metric family", () => {
  test("a split value wins over the season value", async () => {
    const { resolveHitterMetric } = await engine;
    const map = new Map<string, number | null>([["iso", 0.140], ["iso:R", 0.235]]);
    assert.equal(resolveHitterMetric(map, "iso", "R"), 0.235);
  });

  test("the season value is the fallback when no split exists", async () => {
    const { resolveHitterMetric } = await engine;
    const map = new Map<string, number | null>([["iso", 0.140]]);
    assert.equal(resolveHitterMetric(map, "iso", "R"), 0.140);
    assert.equal(resolveHitterMetric(map, "iso", null), 0.140);
  });

  test("a split iso above the power threshold and an unsplit iso below it resolve consistently", async () => {
    const { resolveHitterMetric } = await engine;
    // POWER_ISO in tb-engine is the threshold both call sites test against.
    const map = new Map<string, number | null>([["iso", 0.120], ["iso:L", 0.240]]);
    const classification = resolveHitterMetric(map, "iso", "L");
    const scoring = resolveHitterMetric(map, "iso", "L");
    assert.equal(classification, scoring);
    assert.equal(classification, 0.240);
  });

  test("quality metrics resolve by split like every other rate", async () => {
    const { resolveHitterMetric } = await engine;
    const map = new Map<string, number | null>([
      ["barrel_percent", 8.1], ["barrel_percent:L", 12.4],
      ["hard_hit_percent", 41.0], ["hard_hit_percent:L", 48.2],
    ]);
    assert.equal(resolveHitterMetric(map, "barrel_percent", "L"), 12.4);
    assert.equal(resolveHitterMetric(map, "hard_hit_percent", "L"), 48.2);
  });

  test("sample denominators are read unsplit, with the reason recorded", async () => {
    const { resolveHitterMetric, UNSPLIT_HITTER_METRICS, resolvePitcherMetric, UNSPLIT_PITCHER_METRICS } = await engine;
    const hitter = new Map<string, number | null>([["pa", 540], ["pa:R", 390]]);
    assert.equal(resolveHitterMetric(hitter, "pa", "R"), 540);
    assert.ok(UNSPLIT_HITTER_METRICS.get("pa").length > 0, "an unsplit metric must state why");

    const pitcher = new Map<string, number | null>([["bf", 700], ["bf:L", 310]]);
    assert.equal(resolvePitcherMetric(pitcher, "bf", "L"), 700);
    assert.ok(UNSPLIT_PITCHER_METRICS.get("bf").length > 0);
  });

  test("splitOnly reads never fall back to the season line", async () => {
    const { resolveHitterMetric } = await engine;
    const map = new Map<string, number | null>([["xslg", 0.410]]);
    assert.equal(resolveHitterMetric(map, "xslg", "R", { splitOnly: true }), null);
    assert.equal(resolveHitterMetric(map, "xslg", null, { splitOnly: true }), null);
  });

  test("no hitter or pitcher metric is read directly outside the resolvers", () => {
    const source = readFileSync("artifacts/api-server/src/services/tb-engine.ts", "utf8");
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    for (const pattern of [
      /n\(hitter,/,
      /n\(pitcher,/,
      /n\(hitterFeatures,/,
      /n\(pitcherFeatures,/,
      /n\(c\.hitterFeatures,/,
      /n\(c\.pitcherFeatures,/,
    ]) {
      const matches = body.match(new RegExp(pattern, "g")) ?? [];
      assert.deepEqual(matches, [], `direct read ${pattern} must go through a resolver`);
    }
    assert.ok(!/hk\("|pk\("/.test(body.replace(/const hk =[\s\S]*?metricKey;/, "").replace(/const pk =[\s\S]*?metricKey;/, "")),
      "split keys must only be built inside the resolvers");
  });
});
