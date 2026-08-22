/**
 * Phase 7A – Bettor Intelligence Ingestion and Lineage
 *
 * Bettor picks are preserved as source-attributed evidence. They are neither
 * popularity votes nor market-price analytics, and copied posts cannot inflate
 * an independent-source count.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const API = "http://127.0.0.1:8080";
const DATE = "2026-12-07";
const LONG_TEXT_DATE = "2026-12-08";
const FIXTURE = { playerOne: 9999701, playerTwo: 9999702 };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let sourceOne;
let sourceTwo;

async function createSource(payload) {
  const response = await fetch(`${API}/api/analyst/bettor/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function ingest(payload) {
  return fetch(`${API}/api/analyst/bettor/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function cleanup() {
  await pool.query(`DELETE FROM pick_duplication_lineage
                    WHERE pick_id IN (SELECT pick_id FROM bettor_picks WHERE player_id IN ($1, $2))
                       OR prior_pick_id IN (SELECT pick_id FROM bettor_picks WHERE player_id IN ($1, $2))`, [FIXTURE.playerOne, FIXTURE.playerTwo]);
  await pool.query("DELETE FROM bettor_picks WHERE player_id IN ($1, $2)", [FIXTURE.playerOne, FIXTURE.playerTwo]);
  await pool.query(`DELETE FROM bettor_sources
                    WHERE platform = 'Phase 7A Acceptance'`);
  await pool.query("DELETE FROM players WHERE player_id IN ($1, $2)", [FIXTURE.playerOne, FIXTURE.playerTwo]);
}

describe("Phase 7A – Bettor Intelligence Ingestion and Lineage", () => {
  before(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO players (player_id, full_name, active) VALUES
       ($1, 'Phase 7A Batter One', true), ($2, 'Phase 7A Batter Two', true)`,
      [FIXTURE.playerOne, FIXTURE.playerTwo],
    );
    sourceOne = await createSource({
      platform: "Phase 7A Acceptance",
      accountHandle: "@capper-alpha",
      personIdentityKey: "phase7-known-person",
      personLevelCrossPlatform: true,
    });
    sourceTwo = await createSource({
      platform: "Phase 7A Acceptance",
      accountHandle: "@capper-beta",
      personIdentityKey: "phase7-known-person",
      personLevelCrossPlatform: true,
    });
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test("records account and person-level source identity without treating them as votes", async () => {
    const response = await fetch(`${API}/api/analyst/bettor/sources`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const fixtureSources = body.sources.filter((source) => source.platform === "Phase 7A Acceptance");
    assert.equal(fixtureSources.length, 2);
    assert.ok(fixtureSources.every((source) => source.personIdentityKey === "phase7-known-person"));
    assert.ok(fixtureSources.every((source) => source.personLevelCrossPlatform === true));
    const sourceKeys = Object.keys(fixtureSources[0]).map((key) => key.toLowerCase());
    for (const prohibited of ["odds", "price", "ev", "clv", "vote", "popularity"]) {
      assert.equal(sourceKeys.includes(prohibited), false);
    }
  });

  test("flags identical cross-account picks without independent reasoning as likely copies", async () => {
    const postedAt = "2026-12-07T14:00:00.000Z";
    const original = await ingest({
      sourceId: sourceOne.sourceId,
      slateDate: DATE,
      playerId: FIXTURE.playerOne,
      market: "HR",
      pickDirection: "YES",
      mechanismTags: ["PULL_AIR"],
      reasoning: "",
      postedAt,
    });
    assert.equal(original.status, 201);

    const copied = await ingest({
      sourceId: sourceTwo.sourceId,
      slateDate: DATE,
      playerId: FIXTURE.playerOne,
      market: "HR",
      pickDirection: "YES",
      mechanismTags: ["PULL_AIR"],
      reasoning: "",
      postedAt: "2026-12-07T14:05:00.000Z",
    });
    assert.equal(copied.status, 201);
    const copiedBody = await copied.json();
    assert.equal(copiedBody.pick.duplicationFlag, "IS_LIKELY_COPY");
    assert.equal(copiedBody.pick.isLikelyCopy, true);
    assert.equal(copiedBody.pick.duplicationLineage.length, 1);
    assert.ok(copiedBody.pick.duplicationLineage[0].confidence >= 0.8);
    assert.equal(copiedBody.pick.originalTextRetainedFlag, false);

    const response = await fetch(`${API}/api/analyst/bettor/picks?date=${DATE}&market=HR`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 2);
    assert.equal(body.picks.filter((pick) => pick.duplicationFlag === "IS_LIKELY_COPY").length, 1);
  });

  test("rejects a novel mechanism and bounds long source text to a marked paraphrase", async () => {
    const rejected = await ingest({
      sourceId: sourceOne.sourceId,
      slateDate: LONG_TEXT_DATE,
      playerId: FIXTURE.playerTwo,
      market: "TB",
      pickDirection: "YES",
      mechanismTags: ["NOVEL_FREE_FORM_THEORY"],
      reasoning: "Novel category should never be accepted.",
      postedAt: "2026-12-08T13:00:00.000Z",
    });
    assert.equal(rejected.status, 400);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO bettor_picks
           (slate_date, player_id, market, pick_direction, mechanism_tags, reasoning_paraphrase, posted_at, source_id)
         VALUES ($1, $2, 'TOTAL_BASES_2_PLUS', 'YES', ARRAY['NOVEL_FREE_FORM_THEORY']::bettor_mechanism[], 'bad', now(), $3)`,
        [LONG_TEXT_DATE, FIXTURE.playerTwo, sourceOne.sourceId],
      ),
      /invalid input value for enum bettor_mechanism/i,
    );

    const longReasoning = `${"Contact volume supports this player. ".repeat(35)}Additional unsupported source prose.`;
    const accepted = await ingest({
      sourceId: sourceOne.sourceId,
      slateDate: LONG_TEXT_DATE,
      playerId: FIXTURE.playerTwo,
      market: "TB",
      pickDirection: "YES",
      mechanismTags: ["CONTACT_VOLUME"],
      reasoning: longReasoning,
      postedAt: "2026-12-08T13:05:00.000Z",
    });
    assert.equal(accepted.status, 201);
    const body = await accepted.json();
    assert.equal(body.pick.originalTextRetainedFlag, false);
    assert.ok(body.pick.reasoningParaphrase.length <= 500);
    assert.match(body.pick.reasoningParaphrase, /omitted.*retention limit/i);
    assert.equal(body.pick.reasoningParaphrase.includes(longReasoning.slice(0, 100)), false);
    assert.equal(Object.hasOwn(body.pick, "originalText"), false);
  });

  test("database guard prevents AI writers from creating source, pick, or lineage rows", async () => {
    const blockedByAi = async (query, params = []) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL app.writer_context = 'AI'");
        await client.query(query, params);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const picks = await pool.query("SELECT pick_id FROM bettor_picks WHERE player_id = $1 ORDER BY posted_at", [FIXTURE.playerOne]);
    await assert.rejects(
      () => blockedByAi(
        `INSERT INTO bettor_sources (platform, account_handle)
         VALUES ('Phase 7A Acceptance', '@ai-blocked')`,
      ),
      /AI writers cannot write bettor ingestion or lineage tables/i,
    );
    await assert.rejects(
      () => blockedByAi(
        `INSERT INTO bettor_picks
           (slate_date, player_id, market, pick_direction, mechanism_tags, reasoning_paraphrase, posted_at, source_id)
         VALUES ('2026-12-30', $1, 'HOME_RUN', 'YES', ARRAY['PULL_AIR']::bettor_mechanism[], 'blocked', now(), $2)`,
        [FIXTURE.playerOne, sourceOne.sourceId],
      ),
      /AI writers cannot write bettor ingestion or lineage tables/i,
    );
    await assert.rejects(
      () => blockedByAi(
        `INSERT INTO pick_duplication_lineage (pick_id, prior_pick_id, confidence, method)
         VALUES ($1, $2, 1, 'blocked')`,
        [picks.rows[1].pick_id, picks.rows[0].pick_id],
      ),
      /AI writers cannot write bettor ingestion or lineage tables/i,
    );
  });

  test("rejects impossible slate dates and duplicate mechanism tags", async () => {
    const impossibleDate = await ingest({
      sourceId: sourceTwo.sourceId,
      slateDate: "2026-02-30",
      playerId: FIXTURE.playerTwo,
      market: "WALK",
      pickDirection: "YES",
      mechanismTags: ["PATIENCE_VS_COMMAND"],
      reasoning: "The date must remain exactly as posted.",
      postedAt: "2026-02-28T12:00:00.000Z",
    });
    assert.equal(impossibleDate.status, 400);

    const duplicateTags = await ingest({
      sourceId: sourceTwo.sourceId,
      slateDate: "2026-12-09",
      playerId: FIXTURE.playerTwo,
      market: "WALK",
      pickDirection: "YES",
      mechanismTags: ["PATIENCE_VS_COMMAND", "PATIENCE_VS_COMMAND"],
      reasoning: "Duplicate tags must not create duplicate mechanisms.",
      postedAt: "2026-12-09T12:00:00.000Z",
    });
    assert.equal(duplicateTags.status, 400);
  });
 
  test("requires a date when listing picks", async () => {
    const response = await fetch(`${API}/api/analyst/bettor/picks`);
    assert.equal(response.status, 400);
  });
});