import { pool } from "@workspace/db";

/**
 * Pregame lineup selection and official-lineup audit separation.
 *
 * Every consumer used to filter source_id = 'FANTASYPROS' inside its own SQL.
 * There was no second source and no cross-check, so if the FantasyPros feed was
 * missing or wrong for a game, the engines produced no candidates for that game
 * at all, silently.
 *
 * MLB also writes POSTED lineup snapshots from the game feed. Those official
 * cards are valuable historical and settlement evidence, but usually arrive
 * shortly before first pitch. They must not replace the projected slate that
 * drives pregame research or make an earlier research run wait on a late card.
 *
 * The pregame reader deliberately accepts only the projected-lineup authority.
 * Official cards can be compared in dedicated audit views after they arrive,
 * without becoming a competing candidate input or a false missing-evidence
 * condition for the pregame board.
 *
 * The selection and conflict rules are pure and separately testable; the one
 * query that reads the snapshots lives here too, so all four market engines
 * share it instead of each carrying its own copy with the source name inlined.
 */

export type LineupSourceRule = {
  sourceId: string;
  /** Snapshot states this source is trusted to supply, most authoritative first. */
  states: readonly string[];
  /** Why this source sits where it does. */
  rationale: string;
};

/**
 * The only input to a pregame research run.
 *
 * The projected endpoint is available materially earlier than a club's final
 * card and is the product's declared pregame lineup authority. Do not add
 * MLB_OFFICIAL POSTED here: it is an audit/settlement source, not a replacement
 * for the research input selected before first pitch.
 */
export const PREGAME_LINEUP_SOURCE_PRECEDENCE: readonly LineupSourceRule[] = [
  {
    sourceId: "FANTASYPROS",
    states: ["PROJECTED"],
    rationale: "The projected FantasyPros lineup is the declared input for pregame research.",
  },
];

/**
 * @deprecated Prefer PREGAME_LINEUP_SOURCE_PRECEDENCE to make the policy
 * explicit at new call sites. Retained while supporting route modules use the
 * shared default reader.
 */
export const LINEUP_SOURCE_PRECEDENCE = PREGAME_LINEUP_SOURCE_PRECEDENCE;

/** Official cards remain available for audit and settlement, never pregame selection. */
export const OFFICIAL_LINEUP_AUDIT_SOURCE: readonly LineupSourceRule[] = [{
  sourceId: "MLB_OFFICIAL",
  states: ["POSTED"],
  rationale: "The club-submitted lineup card, retained as late official confirmation and historical lineage.",
}];

/** State ordering for explicitly requested comparison views. */
export const LINEUP_STATE_RANK: Record<string, number> = {
  POSTED: 1,
  CONFIRMED: 2,
  UPDATED: 3,
  PROJECTED: 4,
  UNKNOWN: 9,
};

export type LineupSourceFilter = { sourceIds: string[]; states: string[] };

/**
 * Flattens the precedence list into the two parallel arrays a query joins
 * against, so the accepted (source, state) pairs are parameters rather than a
 * literal inside the SQL.
 */
export function lineupSourceFilter(
  sources: readonly LineupSourceRule[] = PREGAME_LINEUP_SOURCE_PRECEDENCE,
): LineupSourceFilter {
  const sourceIds: string[] = [];
  const states: string[] = [];
  for (const rule of sources) {
    for (const state of rule.states) {
      sourceIds.push(rule.sourceId);
      states.push(state);
    }
  }
  return { sourceIds, states };
}

export function lineupSourceRank(
  sourceId: string,
  sources: readonly LineupSourceRule[] = PREGAME_LINEUP_SOURCE_PRECEDENCE,
): number {
  const index = sources.findIndex((rule) => rule.sourceId === sourceId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export type LineupEntryRow = {
  sourceId: string;
  gamePk: number;
  teamId: number;
  lineupState: string;
  playerId: number;
  playerName: string;
  battingOrder: number;
};

export type ResolvedLineupPlayer = LineupEntryRow;

export type LineupConflict = {
  gamePk: number;
  teamId: number;
  playerId: number;
  playerName: string;
  presentIn: string[];
  absentFrom: string[];
  detail: string;
};

export type ResolvedLineups = {
  players: ResolvedLineupPlayer[];
  conflicts: LineupConflict[];
  /** Which source supplied each (gamePk, teamId), keyed "gamePk:teamId". */
  selectedSourceByTeam: Map<string, { sourceId: string; lineupState: string }>;
  /** Conflicts keyed by "gamePk:playerId", for annotating candidates. */
  conflictsByPlayer: Map<string, LineupConflict[]>;
};

const teamKey = (gamePk: number, teamId: number) => `${gamePk}:${teamId}`;
const playerKey = (gamePk: number, playerId: number) => `${gamePk}:${playerId}`;

/**
 * Chooses one approved lineup per (game, team) and reports disagreements only
 * among the approved sources supplied by the caller.
 *
 * A conflict is not resolved by precedence. The winning source still supplies
 * the roster, because something has to, but every disputed player is returned
 * so the caller can mark those candidates with a blocking evidence gap. Silently
 * preferring one feed over another is how a wrong lineup reaches the board
 * looking exactly like a right one.
 */
export function resolveLineups(
  rows: LineupEntryRow[],
  sources: readonly LineupSourceRule[] = PREGAME_LINEUP_SOURCE_PRECEDENCE,
): ResolvedLineups {
  const acceptedRows = rows.filter((row) => sources.some((source) =>
    source.sourceId === row.sourceId && source.states.includes(row.lineupState),
  ));
  const bySourceAndTeam = new Map<string, Map<string, LineupEntryRow[]>>();
  for (const row of acceptedRows) {
    const team = teamKey(row.gamePk, row.teamId);
    if (!bySourceAndTeam.has(team)) bySourceAndTeam.set(team, new Map());
    const bySource = bySourceAndTeam.get(team)!;
    if (!bySource.has(row.sourceId)) bySource.set(row.sourceId, []);
    bySource.get(row.sourceId)!.push(row);
  }

  const players: ResolvedLineupPlayer[] = [];
  const conflicts: LineupConflict[] = [];
  const selectedSourceByTeam = new Map<string, { sourceId: string; lineupState: string }>();

  for (const [team, bySource] of bySourceAndTeam) {
    const ranked = [...bySource.keys()].sort(
      (a, b) => lineupSourceRank(a, sources) - lineupSourceRank(b, sources),
    );
    const winningSource = ranked[0];
    const winningRows = bySource.get(winningSource)!;
    players.push(...winningRows);
    selectedSourceByTeam.set(team, {
      sourceId: winningSource,
      lineupState: winningRows[0]?.lineupState ?? "UNKNOWN",
    });

    if (ranked.length < 2) continue;

    // Every player named by any source, compared against every source that
    // supplied a lineup for this team.
    const namesByPlayer = new Map<number, string>();
    const membership = new Map<number, Set<string>>();
    for (const sourceId of ranked) {
      for (const row of bySource.get(sourceId)!) {
        namesByPlayer.set(row.playerId, row.playerName);
        if (!membership.has(row.playerId)) membership.set(row.playerId, new Set());
        membership.get(row.playerId)!.add(sourceId);
      }
    }
    const gamePk = winningRows[0].gamePk;
    const teamId = winningRows[0].teamId;
    for (const [playerId, presentIn] of membership) {
      if (presentIn.size === ranked.length) continue;
      const absentFrom = ranked.filter((sourceId) => !presentIn.has(sourceId));
      const playerName = namesByPlayer.get(playerId) ?? String(playerId);
      conflicts.push({
        gamePk,
        teamId,
        playerId,
        playerName,
        presentIn: [...presentIn].sort(),
        absentFrom,
        detail: `Lineup source conflict: ${playerName} appears in ${[...presentIn].sort().join(", ")} `
          + `but not in ${absentFrom.join(", ")} for game ${gamePk}.`,
      });
    }
  }

  const conflictsByPlayer = new Map<string, LineupConflict[]>();
  for (const conflict of conflicts) {
    const key = playerKey(conflict.gamePk, conflict.playerId);
    if (!conflictsByPlayer.has(key)) conflictsByPlayer.set(key, []);
    conflictsByPlayer.get(key)!.push(conflict);
  }

  return { players, conflicts, selectedSourceByTeam, conflictsByPlayer };
}

/** Lookup helper so callers do not rebuild the key format. */
export function conflictsFor(
  resolved: ResolvedLineups,
  gamePk: number,
  playerId: number,
): LineupConflict[] {
  return resolved.conflictsByPlayer.get(playerKey(gamePk, playerId)) ?? [];
}


export type SlateLineupPlayer = {
  playerId: number;
  playerName: string;
  bats: string | null;
  battingOrder: number;
  gamePk: number;
  teamId: number;
  lineupState: string;
  oppTeamId: number;
  venueId: number | null;
};

/**
 * Reads the slate's configured pregame lineups, picks the MORNING BASIS
 * snapshot for each team — the day's first accepted projected lineup, not the
 * newest — and reports disagreements only inside that policy.
 *
 * The 8 AM projected lineup is the operating basis for the entire day: later
 * lineup churn never changes which batters and pitchers the slate is about,
 * and a basis player who ends up not playing is resolved as DID NOT PLAY at
 * nightly settlement rather than swapped out pregame.
 *
 * Shared by all four per-candidate market engines. Each one previously carried
 * its own copy of this query with source_id = 'FANTASYPROS' written into it.
 */
export async function querySlateLineupPlayers(
  gamePks: number[],
  sources: readonly LineupSourceRule[] = PREGAME_LINEUP_SOURCE_PRECEDENCE,
): Promise<{ players: SlateLineupPlayer[]; resolved: ResolvedLineups }> {
  if (gamePks.length === 0) {
    return { players: [], resolved: resolveLineups([], sources) };
  }
  const filter = lineupSourceFilter(sources);
  const result = await pool.query<{
    player_id: number; full_name: string; bats: string | null; batting_order: number;
    game_pk: string; team_id: number; lineup_state: string; source_id: string;
    opp_team_id: number; venue_id: number | null;
  }>(
    `WITH accepted AS (
       SELECT * FROM unnest($2::text[], $3::text[]) AS s(source_id, state)
     ),
     best_lineup AS (
       SELECT DISTINCT ON (ls.game_pk, ls.team_id, ls.source_id)
         ls.lineup_snapshot_id, ls.game_pk, ls.team_id, ls.source_id, ls.state AS lineup_state
       FROM lineup_snapshots ls
       JOIN games sg ON sg.game_pk = ls.game_pk
       JOIN accepted a ON a.source_id = ls.source_id AND a.state = ls.state::text
       WHERE ls.game_pk = ANY($1)
       ORDER BY ls.game_pk, ls.team_id, ls.source_id,
         CASE ls.state::text
           WHEN 'POSTED' THEN 1
           WHEN 'CONFIRMED' THEN 2
           WHEN 'UPDATED' THEN 3
           WHEN 'PROJECTED' THEN 4
           ELSE 9
         END,
         -- Morning lineup basis: the day's FIRST accepted snapshot per team is
         -- the slate's operating lineup, deliberately NOT the newest. The 8 AM
         -- projected lineup is the basis for the whole day; later churn never
         -- changes who the slate is about, and a player who ends up not
         -- playing is resolved as DNP at nightly settlement. Snapshots
         -- captured on the slate date itself outrank any earlier speculative
         -- capture.
         CASE WHEN (ls.observed_at AT TIME ZONE 'America/New_York')::date = sg.game_date THEN 0 ELSE 1 END,
         ls.observed_at ASC
     )
     SELECT le.player_id, p.full_name, p.bats, le.batting_order,
            bl.game_pk::text AS game_pk, bl.team_id, bl.lineup_state, bl.source_id,
            CASE WHEN bl.team_id = g.away_team_id THEN g.home_team_id ELSE g.away_team_id END AS opp_team_id,
            g.venue_id
     FROM best_lineup bl
     JOIN lineup_entries le ON le.lineup_snapshot_id = bl.lineup_snapshot_id
     JOIN players p ON p.player_id = le.player_id
     JOIN games g ON g.game_pk = bl.game_pk
     WHERE le.player_id IS NOT NULL
     ORDER BY bl.game_pk, bl.team_id, bl.source_id, le.batting_order`,
    [gamePks, filter.sourceIds, filter.states],
  );

  const context = new Map<string, { bats: string | null; oppTeamId: number; venueId: number | null }>();
  const entries: LineupEntryRow[] = result.rows.map((r) => {
    const gamePk = Number(r.game_pk);
    context.set(`${gamePk}:${r.player_id}`, {
      bats: r.bats,
      oppTeamId: r.opp_team_id,
      venueId: r.venue_id,
    });
    return {
      sourceId: r.source_id,
      gamePk,
      teamId: r.team_id,
      lineupState: r.lineup_state,
      playerId: r.player_id,
      playerName: r.full_name,
      battingOrder: r.batting_order,
    };
  });

  const resolved = resolveLineups(entries, sources);
  const players: SlateLineupPlayer[] = resolved.players.map((row) => {
    const extra = context.get(`${row.gamePk}:${row.playerId}`)!;
    return {
      playerId: row.playerId,
      playerName: row.playerName,
      bats: extra.bats,
      battingOrder: row.battingOrder,
      gamePk: row.gamePk,
      teamId: row.teamId,
      lineupState: row.lineupState,
      oppTeamId: extra.oppTeamId,
      venueId: extra.venueId,
    };
  });
  return { players, resolved };
}
