/**
 * Re-hydrate players.bats and players.throws from the MLB people endpoint.
 *
 * Audit S1, part four. The game-feed and projections player upserts used to
 * write String(code ?? '') into both columns and update them unconditionally,
 * so any payload that did not carry batSide or pitchHand replaced a known
 * handedness with an empty string. Both upserts now guard on a non-empty value
 * and write NULL rather than '', and M6 in pre-push-migrations.mjs retires the
 * empty strings already stored. Neither of those recovers the handedness that
 * was destroyed. This does.
 *
 * Why it matters: an empty string is not null. resolveBatterSide returns null
 * for a switch hitter, isPlatoonDisfavored returns false, and every split
 * metric quietly resolves to the unsplit season line with nothing reporting it.
 * Phase 4's park and weather terms then sit on top of a platoon layer that may
 * not be running at all.
 *
 * Safe to run repeatedly. It only ever fills a NULL, and never overwrites a
 * handedness that is already recorded.
 *
 * Usage:
 *   node lib/db/scripts/backfill-handedness.mjs [--dry-run] [--limit N]
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set.');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitFlag = args.indexOf('--limit');
const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : null;
if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) {
  throw new Error('--limit takes a positive integer.');
}

// The people endpoint accepts a comma-separated personIds list. 100 keeps the
// URL well inside any practical length limit and the whole active player
// universe inside a handful of requests.
const BATCH_SIZE = 100;
const PEOPLE_URL = 'https://statsapi.mlb.com/api/v1/people';

/** L, R, S, or null. Anything else is not a handedness. */
function handednessCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const code = String(value).trim().toUpperCase();
  return code === 'L' || code === 'R' || code === 'S' ? code : null;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function report(label) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE throws IS NULL OR btrim(throws) = '')::int AS missing_throws,
            count(*) FILTER (WHERE bats   IS NULL OR btrim(bats)   = '')::int AS missing_bats
       FROM players`,
  );
  const r = rows[0];
  const pct = (n) => (r.total ? ((n / r.total) * 100).toFixed(1) : '0.0');
  console.log(
    `${label}: ${r.total} players, ` +
    `throws unknown ${r.missing_throws} (${pct(r.missing_throws)}%), ` +
    `bats unknown ${r.missing_bats} (${pct(r.missing_bats)}%)`,
  );
  return r;
}

try {
  const before = await report('before');

  const { rows: targets } = await pool.query(
    `SELECT player_id FROM players
      WHERE throws IS NULL OR btrim(throws) = ''
         OR bats   IS NULL OR btrim(bats)   = ''
      ORDER BY player_id
      ${limit ? 'LIMIT ' + limit : ''}`,
  );

  if (targets.length === 0) {
    console.log('Nothing to backfill: every player carries a handedness.');
  } else {
    console.log(`${targets.length} player(s) to re-hydrate${dryRun ? ' (dry run, nothing will be written)' : ''}.`);
  }

  let filledThrows = 0;
  let filledBats = 0;
  let unresolved = 0;
  let batches = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE).map((row) => row.player_id);
    batches++;
    const url = `${PEOPLE_URL}?personIds=${batch.join(',')}`;

    let people = [];
    try {
      const response = await fetch(url);
      if (!response.ok) {
        // A failed batch is partial, not fatal. Report it and keep going: a
        // half-filled backfill is strictly better than none, and the script is
        // safe to re-run for whatever it missed.
        console.error(`  ✖ batch ${batches}: HTTP ${response.status}, skipped ${batch.length} player(s)`);
        continue;
      }
      const payload = await response.json();
      people = Array.isArray(payload?.people) ? payload.people : [];
    } catch (err) {
      console.error(`  ✖ batch ${batches}: ${err.message}, skipped ${batch.length} player(s)`);
      continue;
    }

    for (const person of people) {
      const playerId = Number(person?.id);
      if (!Number.isSafeInteger(playerId) || playerId <= 0) continue;
      const throwsCode = handednessCode(person?.pitchHand?.code);
      const batsCode = handednessCode(person?.batSide?.code);
      if (!throwsCode && !batsCode) {
        // The feed itself does not know. That is a real answer, and NULL
        // already records it correctly.
        unresolved++;
        continue;
      }
      if (!dryRun) {
        // COALESCE on the stored side, so a value that is already recorded is
        // never replaced. This fills gaps; it does not restate the feed.
        const result = await pool.query(
          `UPDATE players
              SET throws = COALESCE(NULLIF(btrim(throws), ''), $2),
                  bats   = COALESCE(NULLIF(btrim(bats),   ''), $3),
                  updated_at = now()
            WHERE player_id = $1
              AND ((throws IS NULL OR btrim(throws) = '') AND $2::text IS NOT NULL
                OR (bats   IS NULL OR btrim(bats)   = '') AND $3::text IS NOT NULL)`,
          [playerId, throwsCode, batsCode],
        );
        if (result.rowCount === 0) continue;
      }
      if (throwsCode) filledThrows++;
      if (batsCode) filledBats++;
    }
  }

  console.log(
    `\n${batches} batch(es). ` +
    `throws filled ${filledThrows}, bats filled ${filledBats}, ` +
    `feed had no handedness for ${unresolved}.`,
  );

  const after = await report('after');

  if (!dryRun) {
    console.log(
      `\nthrows unknown ${before.missing_throws} -> ${after.missing_throws}, ` +
      `bats unknown ${before.missing_bats} -> ${after.missing_bats}.`,
    );
    console.log('Paste these two lines into the PR: they are the S1 population rate.');
  }
} finally {
  await pool.end();
}
