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
 * Emits a copy-pasteable line for the PR. Read-only: it writes nothing.
 */

import pg from 'pg';

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
  console.log(
    'CENSUS ' + JSON.stringify({
      totalPlayers: n(r.total_players),
      throwsNull: n(r.throws_null),
      throwsEmpty: n(r.throws_empty),
      batsNull: n(r.bats_null),
      batsEmpty: n(r.bats_empty),
    }),
  );

  if (already) {
    console.log('');
    console.log('No empty strings remain. Either M6 has already run, in which case the');
    console.log('split is gone and these nulls are damage and absence combined, or the');
    console.log('bug never reached this database.');
  } else {
    console.log('');
    console.log(`${n(r.throws_empty)} throws and ${n(r.bats_empty)} bats were overwritten with an empty`);
    console.log('string by the upsert. That is the damage figure. Record it: M6 is about to');
    console.log('make it indistinguishable from handedness that was never collected.');
  }
} finally {
  await pool.end();
}
