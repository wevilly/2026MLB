import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const readText = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function allFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(filePath) : [filePath];
  });
}

test("live fixture manifests cover each permitted source response", () => {
  for (const source of ["fantasypros", "mlb_stats_api"]) {
    const manifest = readJson(`tests/fixtures/${source}/manifest.json`);
    assert.equal(manifest.sanitized, true);
    assert.ok(manifest.fixtures.length >= 5);
    for (const fixture of manifest.fixtures) {
      assert.equal(fixture.method, "GET");
      assert.equal(fixture.httpStatus, 200);
      assert.match(fixture.responseChecksum, /^[a-f0-9]{64}$/);
      assert.ok(fs.existsSync(path.join(root, "tests/fixtures", source, fixture.file)));
    }
  }
});

test("FantasyPros fixtures retain independent hitter components and lineup state", () => {
  const hitter = readJson("tests/fixtures/fantasypros/hitter-daily-projections.json");
  const projected = readJson("tests/fixtures/fantasypros/projected-lineups.json");
  const current = readJson("tests/fixtures/fantasypros/current-lineups.json");
  for (const component of ["2b", "3b", "hrs", "bb"]) assert.ok(component in hitter.player[0]);
  assert.ok(Object.keys(projected.games[0].hitters.ATL).length > 0);
  assert.deepEqual(current.games[0].hitters, {});
});

test("MLB fixtures retain official identity, lineup order, and settlement facts", () => {
  const schedule = readJson("tests/fixtures/mlb_stats_api/schedule-with-probables.json");
  const feed = readJson("tests/fixtures/mlb_stats_api/game-live-feed-posted-lineups.json");
  const completed = readJson("tests/fixtures/mlb_stats_api/completed-game-box-score.json");
  assert.equal(schedule.schedule.gamePk, 823746);
  assert.equal(schedule.schedule.away.probablePitcher.fullName, "Chris Sale");
  assert.equal(feed.gameData.status.statusCode, "F");
  assert.equal(feed.liveData.boxscore.teams.away.battingOrder.length, 9);
  assert.equal(completed.status, "Final");
  assert.equal(completed.batting.find((player) => player.fullName === "Jordan Walker").totalBases, 4);
});

test("four-market schema remains explicit and pre-model XBH remains unmodeled", () => {
  const schema = readText("lib/db/src/schema/foundation.ts");
  const routes = readText("artifacts/api-server/src/routes/analyst.ts");
  for (const market of ["TOTAL_BASES_2_PLUS", "EXTRA_BASE_HIT", "BATTER_WALK", "HOME_RUN"]) {
    assert.ok(schema.includes(`"${market}"`));
  }
  assert.ok(routes.includes("Components only · no derivation"));
  assert.ok(!routes.includes("XBH probability"));
});

test("FantasyPros secrets and authorization headers are absent from client and fixtures", () => {
  const safeDirectories = [
    "artifacts/mlb-analyst/src",
    "lib/api-client-react/src",
    "tests/fixtures",
  ];
  for (const directory of safeDirectories) {
    for (const filePath of allFiles(path.join(root, directory))) {
      const contents = fs.readFileSync(filePath, "utf8");
      assert.ok(!contents.includes("FANTASYPROS_API_KEY"), `secret identifier found in ${filePath}`);
      assert.ok(!/x-api-key/i.test(contents), `authorization header found in ${filePath}`);
    }
  }
});