/**
 * Provider player identity reconciliation.
 *
 * Provider player IDs cannot be assumed to be canonical MLBAM IDs: on the
 * 2026-08-25 slate, 270 projected FantasyPros hitters and 270 Ballpark Pal
 * hitter snapshots overlapped on only 235 canonical IDs, and the 35 unmatched
 * rows were silently dropped by a bare `player_id exists` check.
 *
 * The ladder below never guesses: a stored alias wins, then the direct MLBAM
 * ID, then an exact normalized-name match scoped to the players already tied
 * to the specific game via projected lineups or starters (which is what makes
 * a same-name collision elsewhere in the league irrelevant). Anything
 * ambiguous is quarantined into identity_review_queue — already surfaced as
 * IDENTITY REVIEW issues in Data Health — with the evidence to resolve it.
 */
import { pool } from "@workspace/db";

const normalize = (value: string) => value
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .trim().toLowerCase()
  .replace(/[^a-z ]/g, "").replace(/\s+/g, " ");

export type IdentityResolution =
  | { outcome: "RESOLVED"; playerId: number; method: string }
  | { outcome: "QUARANTINED"; reason: string };

export async function resolveProviderPlayer(
  sourceId: string,
  externalPlayerId: number,
  playerName: string | null,
  gamePk: number,
  effectiveDate: string,
): Promise<IdentityResolution> {
  // 1. A previously confirmed alias wins outright.
  const alias = await pool.query<{ player_id: number }>(
    `SELECT player_id FROM player_external_id_aliases
      WHERE source_id = $1 AND external_player_id = $2`,
    [sourceId, String(externalPlayerId)],
  );
  if (alias.rowCount) {
    return { outcome: "RESOLVED", playerId: alias.rows[0].player_id, method: "STORED_ALIAS" };
  }

  // 2. The provider ID may genuinely be the MLBAM ID (most are).
  const direct = await pool.query(`SELECT 1 FROM players WHERE player_id = $1`, [externalPlayerId]);
  if (direct.rowCount) {
    return { outcome: "RESOLVED", playerId: externalPlayerId, method: "DIRECT_MLBAM_ID" };
  }

  // 3. Exact normalized-name match, only against players already tied to this
  //    game via projected lineups or starters; accept only a unique hit.
  if (!playerName) {
    return quarantine(sourceId, externalPlayerId, "", gamePk, effectiveDate, "no_provider_name", 0);
  }
  const candidates = await pool.query<{ player_id: number; full_name: string }>(
    `SELECT DISTINCT p.player_id, p.full_name
       FROM players p
      WHERE p.player_id IN (
        SELECT le.player_id FROM lineup_entries le
          JOIN lineup_snapshots ls ON ls.lineup_snapshot_id = le.lineup_snapshot_id
         WHERE ls.game_pk = $1 AND le.player_id IS NOT NULL
        UNION
        SELECT s.player_id FROM starters s
         WHERE s.game_pk = $1 AND s.player_id IS NOT NULL
      )`,
    [gamePk],
  );
  const wanted = normalize(playerName);
  const matches = candidates.rows.filter((row) => normalize(row.full_name) === wanted);
  if (matches.length === 1) {
    const playerId = matches[0].player_id;
    await pool.query(
      `INSERT INTO player_external_id_aliases
         (player_id, source_id, external_player_id, link_type, evidence)
       VALUES ($1, $2, $3, 'ALIAS', $4)
       ON CONFLICT (source_id, external_player_id) DO NOTHING`,
      [playerId, sourceId, String(externalPlayerId), {
        method: "UNIQUE_NAME_AND_GAME_MATCH",
        providerName: playerName,
        matchedName: matches[0].full_name,
        gamePk,
        effectiveDate,
      }],
    );
    return { outcome: "RESOLVED", playerId, method: "UNIQUE_NAME_AND_GAME_MATCH" };
  }

  // 4. Zero or multiple candidates: quarantine for human review.
  return quarantine(
    sourceId, externalPlayerId, playerName, gamePk, effectiveDate,
    matches.length ? "ambiguous_name_match" : "no_lineup_scoped_name_match", matches.length,
  );
}

async function quarantine(
  sourceId: string,
  externalPlayerId: number,
  rawName: string,
  gamePk: number,
  effectiveDate: string,
  reason: string,
  candidateCount: number,
): Promise<IdentityResolution> {
  // One OPEN row per source + external ID; re-running an ingest must not
  // flood the review queue with duplicates.
  await pool.query(
    `INSERT INTO identity_review_queue
       (source_id, external_player_id, raw_name, normalized_name, evidence)
     SELECT $1, $2, $3, $4, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM identity_review_queue
         WHERE source_id = $1 AND external_player_id = $2 AND state = 'OPEN')`,
    [sourceId, String(externalPlayerId), rawName || "(name not provided)",
      normalize(rawName), { gamePk, effectiveDate, reason, candidateCount }],
  );
  return { outcome: "QUARANTINED", reason };
}
