import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const requireDb = createRequire(new URL("../lib/db/package.json", import.meta.url));
const pg = requireDb("pg");

test("corrected BvP source events append a revision and cannot mutate history", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL unavailable");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const source = await client.query("SELECT source_id FROM source_registry LIMIT 1");
    const players = await client.query("SELECT player_id FROM players LIMIT 2");
    if (!source.rows[0] || players.rows.length < 2) return t.skip("seed identity/source rows unavailable");
    const suffix = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const values = [source.rows[0].source_id, suffix, players.rows[0].player_id, players.rows[1].player_id];
    await client.query("BEGIN");
    await client.query("SET LOCAL app.bypass_immutability = 'true'");
    for (const [checksum, event, retrievedAt] of [
      ["v1", "single", "2026-01-01T00:00:00Z"],
      ["v2", "home_run", "2026-01-01T00:00:01Z"],
    ]) {
      await client.query(
        `INSERT INTO batter_pitcher_events
          (source_id, source_event_key, batter_id, pitcher_id, game_date, is_terminal_plate_appearance, event_type, raw, content_checksum, retrieved_at)
         VALUES ($1,$2,$3,$4,'2026-01-01',true,$5,'{}'::jsonb,$6,$7)`,
        [...values, event, `${suffix}-${checksum}`, retrievedAt],
      );
    }
    const current = await client.query(
      `SELECT DISTINCT ON (source_event_key) event_type
       FROM batter_pitcher_events WHERE source_id = $1 AND source_event_key = $2
       ORDER BY source_event_key, retrieved_at DESC, event_id DESC`,
      values.slice(0, 2),
    );
    assert.equal(current.rows[0]?.event_type, "home_run");
    await client.query("SET LOCAL app.bypass_immutability = 'false'");
    await assert.rejects(client.query("UPDATE batter_pitcher_events SET event_type = 'single' WHERE source_id = $1 AND source_event_key = $2", values.slice(0, 2)));
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
});