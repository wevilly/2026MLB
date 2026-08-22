import pg from "pg";
import { validateRestoreSummary } from "./restore-verification.mjs";

const connectionString = process.env.RESTORE_DATABASE_URL;
if (!connectionString) {
  throw new Error("Set RESTORE_DATABASE_URL to an isolated, non-production restored database.");
}
if (connectionString === process.env.DATABASE_URL) {
  throw new Error("RESTORE_DATABASE_URL must not point at the active DATABASE_URL.");
}

const { Pool } = pg;
const pool = new Pool({ connectionString, max: 1 });
try {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM orchestration_runs) AS "orchestrationRuns",
       (SELECT count(*)::int FROM pregame_feature_snapshots) AS "pregameFeatureSnapshots",
       (SELECT count(*)::int FROM historical_outcomes) AS "historicalOutcomes",
       (SELECT count(*)::int FROM market_postmortems) AS "marketPostmortems",
       (SELECT count(*)::int FROM audit_events) AS "auditEvents",
       (SELECT count(*)::int
        FROM pregame_feature_snapshots snapshot
        JOIN historical_outcomes outcome
          ON outcome.player_id = snapshot.player_id
         AND outcome.game_pk = snapshot.game_pk
         AND outcome.market = snapshot.market) AS "snapshotsWithOutcome",
       (SELECT count(*)::int
        FROM market_postmortems postmortem
        JOIN pregame_feature_snapshots snapshot ON snapshot.snapshot_id = postmortem.snapshot_id
        JOIN historical_outcomes outcome ON outcome.outcome_id = postmortem.outcome_id) AS "linkedPostmortems"`,
  );
  console.log(JSON.stringify(validateRestoreSummary(result.rows[0]), null, 2));
} finally {
  await pool.end();
}