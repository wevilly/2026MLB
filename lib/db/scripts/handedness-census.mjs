/**
 * The empty-string versus NULL split in players.bats and players.throws.
 *
 * Run this BEFORE the schema push. M6 in pre-push-migrations.mjs normalises the
 * stored empty strings to NULL, and that is irreversible.
 *
 * Why the split and not just the total: the data-health counters count "null or
 * empty" together, so the combined number survives normalisation. What does not
 * survive is the distinction between them, and that distinction is the only
 * evidence of how much handedness the S1 bug destroyed as opposed to how much
 * was never collected in the first place.
 *
 *   throws_empty  handedness that WAS known and was overwritten with '' by the
 *                 unconditional upsert. Damage.
 *   throws_null   handedness never supplied by any feed. Absence.
 *
 * After M6 both look identical. This is the same distinction audit S11 raises
 * for the feature store: a metric recorded as NULL and a metric never collected
 * are different facts, and a store that cannot tell them apart has lost one.
 *
 * ONLY THE FIRST CAPTURE CARRIES INFORMATION. M6 runs as part of the push, and
 * after it every subsequent run reports empty 0 by construction, for both
 * columns, on any database. A file showing zeros is therefore not evidence that
 * nothing was damaged; it is evidence that the census ran too late. The first
 * file written is the measurement, and it is why this appends rather than
 * overwrites and never rewrites an existing capture.
 *
 * The measurement is one-shot and unrecoverable, and the hook that runs it does
 * so best effort so a merge cannot fail over a census, which together means the
 * numbers must not live only in a merge log. Each run appends a JSON line to
 * reports/handedness-census.jsonl, which is committed, and prints the same
 * record for the PR.
 *
 * Read-only against the database: it writes to disk, never to Postgres.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Anchored to the repository root via this file's own location, not the working
// directory. post-merge.sh runs from the root and `pnpm --filter @workspace/db`
// runs from lib/db, and a one-shot measurement must not land in two places
// depending on which invoked it.
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const CENSUS_PATH = process.env.HANDEDNESS_CENSUS_PATH
  ? resolve(process.env.HANDEDNESS_CENSUS_PATH)
  : resolve(REPO_ROOT, 'reports/handedness-census.jsonl');

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE throws IS NULL) AS throws_null,
       count(*) FILTER (WHERE throws = '')   AS throws_empty,
       count(*) FILTER (WHERE bats  IS NULL) AS bats_null,
       count(*) FILTER (WHERE bats  = '')    AS bats_empty,
       count(*)                              AS total_players
     FROM players`,
  );
  const r = rows[0];
  const n = (value) => Number(value ?? 0);
  const already = n(r.throws_empty) === 0 && n(r.bats_empty) === 0;

  console.log('handedness census, before normalisation:');
  console.log(`  total_players ${n(r.total_players)}`);
  console.log(`  throws  null ${n(r.throws_null)}  empty ${n(r.throws_empty)}`);
  console.log(`  bats    null ${n(r.bats_null)}  empty ${n(r.bats_empty)}`);
  console.log('');

  // Persisted before the record is printed, so a later failure cannot lose the
  // one capture that carries information.
  const priorCaptures = existsSync(CENSUS_PATH)
    ? readFileSync(CENSUS_PATH, 'utf8').split('\n').filter((line) => line.trim()).length
    : 0;
  const record = {
    capturedAt: new Date().toISOString(),
    isFirstCapture: priorCaptures === 0,
    splitStillIntact: !already,
    totalPlayers: n(r.total_players),
    throwsNull: n(r.throws_null),
    throwsEmpty: n(r.throws_empty),
    batsNull: n(r.bats_null),
    batsEmpty: n(r.bats_empty),
  };
  try {
    mkdirSync(dirname(CENSUS_PATH), { recursive: true });
    appendFileSync(CENSUS_PATH, `${JSON.stringify(record)}\n`);
    console.log(`  written to ${CENSUS_PATH} (capture ${priorCaptures + 1})`);
  } catch (err) {
    console.error(`  COULD NOT PERSIST THE CENSUS: ${err.message}`);
    console.error('  Copy the CENSUS line below by hand. It cannot be measured again.');
  }
  console.log('');
  console.log('CENSUS ' + JSON.stringify(record));

  if (already) {
    console.log('');
    console.log('No empty strings remain, so this capture carries no information about the');
    console.log('damage. Either M6 has already run, in which case the split is gone and');
    console.log('these nulls are damage and absence combined, or the bug never reached');
    console.log('this database. Only the first capture, taken before the push, can tell');
    console.log('those two apart.');
  } else {
    console.log('');
    console.log(`${n(r.throws_empty)} throws and ${n(r.bats_empty)} bats were overwritten with an empty`);
    console.log('string by the upsert. That is the damage figure. It is now on disk: M6 is');
    console.log('about to make it indistinguishable from handedness never collected.');
  }
} finally {
  await pool.end();
}
