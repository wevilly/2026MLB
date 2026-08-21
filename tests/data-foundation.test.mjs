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

test("current-player eligibility policy declares authoritative states and quarantine flags", () => {
  const schema = readText("lib/db/src/schema/foundation.ts");
  const service = readText("artifacts/api-server/src/services/data-foundation.ts");
  const routes = readText("artifacts/api-server/src/routes/analyst.ts");
  for (const state of ["MLB_ACTIVE", "MLB_40_MAN", "MLB_IL", "MLB_OPTIONED", "MINOR_LEAGUE", "FREE_AGENT", "HISTORICAL", "RETIRED", "UNKNOWN"]) {
    assert.ok(schema.includes(`"${state}"`), `missing eligibility state ${state}`);
  }
  for (const field of ["eligible_today_research", "eligible_lineup_projection", "eligible_pitcher_research", "requires_identity_review", "quarantined_from_current_research"]) {
    assert.ok(schema.includes(field), `missing eligibility field ${field}`);
  }
  assert.ok(service.includes("no_current_official_roster_observation"));
  assert.ok(service.includes("missing_authoritative_identity_bridge"));
  assert.ok(service.includes("MLB_TEAMS_URL"), "official roster coverage must not depend only on slate teams");
  assert.ok(service.includes("officialPersonFallback"), "bridged players absent from a roster require official person-state verification");
  assert.ok(service.includes('const status: EligibilityStatus = active ? "UNKNOWN" : "RETIRED"'), "people metadata must not infer major- or minor-league roster membership");
  assert.ok(service.includes('["UNKNOWN", "MINOR_LEAGUE", "FREE_AGENT"].includes(official.status)'), "non-roster fallback classifications must be revalidated on every refresh");
  assert.ok(routes.includes("pe.eligible_today_research AND NOT pe.requires_identity_review"));
});

test("official starters and posted lineups establish canonical current-player coverage", () => {
  const service = readText("artifacts/api-server/src/services/data-foundation.ts");
  const routes = readText("artifacts/api-server/src/routes/analyst.ts");
  assert.ok(service.includes('evidence: { officialStarter: true'));
  assert.ok(service.includes('status: "MLB_ACTIVE"'));
  assert.ok(service.includes('persistOfficialTeamRoster'));
  assert.ok(service.includes('if (rosterType !== "game_feed")'), "game feeds must not downgrade roster-authoritative eligibility");
  assert.ok(routes.includes("official_starters_mapped"));
  assert.ok(routes.includes("official_lineup_players_mapped"));
});

test("projected lineup identity gaps block eligibility rather than silently entering a lineup", () => {
  const service = readText("artifacts/api-server/src/services/data-foundation.ts");
  assert.ok(service.includes("PROJECTED_LINEUP_IDENTITY_BLOCKING"));
  assert.ok(service.includes("identity_or_current_roster_not_confirmed"));
  assert.ok(service.includes("!identity.rowCount || !identity.rows[0].eligible_lineup_projection"));
});

test("aliases, team disagreements, and snapshot equality remain auditable", () => {
  const schema = readText("lib/db/src/schema/foundation.ts");
  const service = readText("artifacts/api-server/src/services/data-foundation.ts");
  assert.ok(schema.includes("player_external_id_aliases"));
  assert.ok(service.includes("DUPLICATE_SOURCE_ID"));
  assert.ok(service.includes("TEAM_ASSIGNMENT_CONFLICT"));
  assert.ok(schema.includes("content_checksum"));
  assert.ok(schema.includes("unchanged_from_prior"));
  assert.ok(service.includes("normalisedChecksum"));
  assert.ok(service.includes("priorSnapshot.rows[0]?.content_checksum === contentChecksum"));
  assert.ok(service.includes('replace(/[\\u0300-\\u036f]/g, "")'), "accent-safe normalization must remain available for candidate evidence");
  assert.ok(service.includes("mlbam_id"), "identity confirmation must retain an authoritative ID bridge");
});

test("projection reads are scoped to the current effective date", () => {
  const routes = readText("artifacts/api-server/src/routes/analyst.ts");
  assert.ok(routes.includes('const date = requestedDate(req.query.date);'));
  assert.ok(routes.includes("WHERE effective_date = $1"), "Projection Center must not fall back to a historical snapshot");
});