/**
 * Phase 2B – Bullpen Foundation Service
 *
 * Ingests reliever appearance data from MLB Stats API, computes heuristic
 * availability states, and builds per-team leverage maps.
 *
 * Availability heuristic rules (manager override always wins):
 *   OUT        → 3+ consecutive days used (≥1 pitch each)
 *   DOUBTFUL   → 2 consecutive days used, OR ≥35 pitches yesterday,
 *                 OR multi-inning appearance yesterday (IP ≥ 2.0)
 *   LIKELY_AVAILABLE → pitched 2–3 days ago but not yesterday (1–2 days rest)
 *   AVAILABLE  → not used in last 3 days, or used only ≥4 days ago
 *   UNKNOWN    → no appearance data for the window
 *   STALE      → freshness window exceeded (observation > 24 h old)
 *
 * Append-only invariant: relief_appearance_log and role_change_log rows are
 * never updated or deleted after being written.
 */

import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * A failure that was caught and counted rather than thrown.
 *
 * Three bare catch blocks in this file used to discard the error entirely:
 * ingestActiveRosters returned a partial count, fetchGamesForDate returned an
 * empty array, persistGameAppearances returned zeros. refreshBullpen then
 * called finishRun with SUCCESS, so a complete MLB Stats API outage produced an
 * ingest run marked SUCCESS with zero rows and the pipeline continued as though
 * the data had arrived.
 */
export type IngestFailure = { scope: string; detail: string; fatal: boolean };

function recordFailure(failures: IngestFailure[], scope: string, error: unknown, fatal = false) {
  const detail = error instanceof Error ? error.message : String(error);
  failures.push({ scope, detail, fatal });
  logger.error({ scope, detail, fatal }, "bullpen ingest failure");
  return detail;
}

const BULLPEN_SOURCE = "BULLPEN";
const MLB_BASE = "https://statsapi.mlb.com/api/v1";
export const BULLPEN_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asInteger(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/** Parse MLB innings-pitched string/number: 1.2 = 1⅔ innings (MLB thirds notation). */
function parseIp(value: unknown): number {
  const n = asNumber(value);
  if (n === null) return 0;
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 10); // 0, 1, or 2
  return whole + frac / 3;
}

function dateOffset(baseDate: string, days: number): string {
  const d = new Date(`${baseDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isCurrentBullpenTimestamp(value: string | null, now = Date.now()): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= BULLPEN_FRESHNESS_WINDOW_MS;
}

async function ensureBullpenSource(): Promise<void> {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, base_url, expected_freshness_minutes, notes)
     VALUES ($1, 'MLB Bullpen', 'OFFICIAL', 'https://statsapi.mlb.com', 60,
             'Reliever appearance logs derived from MLB Stats API game feeds. Availability states are heuristic.')
     ON CONFLICT (source_id) DO UPDATE SET
       name = EXCLUDED.name, base_url = EXCLUDED.base_url,
       expected_freshness_minutes = EXCLUDED.expected_freshness_minutes`,
    [BULLPEN_SOURCE],
  );
}

async function startRun(jobName: string, effectiveDate: string): Promise<string> {
  const result = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ($1, $2, 'RUNNING', $3) RETURNING ingest_run_id`,
    [BULLPEN_SOURCE, jobName, effectiveDate],
  );
  return result.rows[0].ingest_run_id;
}

async function finishRun(
  ingestRunId: string,
  status: "SUCCESS" | "PARTIAL" | "FAILED",
  counts: { rows: number; normalized: number; rejected: number; error?: string },
  started: number,
  errorMessage?: string,
): Promise<void> {
  await pool.query(
    `UPDATE ingest_runs SET finished_at = now(), status = $2, row_count = $3,
       normalized_row_count = $4, rejected_row_count = $5, duration_ms = $6, error_message = $7
     WHERE ingest_run_id = $1`,
    [ingestRunId, status, counts.rows, counts.normalized, counts.rejected,
     Date.now() - started, errorMessage ?? counts.error ?? null],
  );
}

/**
 * Ingest the active pitcher roster for all MLB teams in the given season.
 *
 * This runs BEFORE game-feed ingestion so that arms who have not appeared in
 * the last 3 days still have reliever_profiles rows and appear in the bullpen
 * room with an explicit UNKNOWN state rather than being silently absent.
 *
 * Roster sources:
 *   1. MLB Teams API  → all active franchises for the season
 *   2. MLB Roster API → active 26-man roster per team, hydrated with pitchHand
 *
 * Role is set to UNKNOWN from roster data only if no game-feed role exists yet.
 * The game-feed pipeline always wins for role assignment; roster ingestion
 * ensures roster coverage without overwriting derived role data.
 *
 * Returns count of reliever profiles touched (inserted or refreshed).
 */
async function ingestActiveRosters(
  season: number,
  failures: IngestFailure[],
): Promise<number> {
  let count = 0;
  try {
    const teamsRes = await fetch(`${MLB_BASE}/teams?sportId=1&season=${season}&gameType=R`);
    if (!teamsRes.ok) {
      // The teams endpoint failing is fatal: without it there is no roster
      // coverage at all and every downstream count is meaningless.
      recordFailure(failures, "teams", new Error(`MLB teams endpoint returned HTTP ${teamsRes.status}`), true);
      return 0;
    }
    const teamsPayload = await teamsRes.json() as JsonObject;

    for (const team of asArray(teamsPayload.teams)) {
      const teamId = asNumber(team.id);
      if (!teamId) continue;

      // Ensure team exists (minimal upsert — Phase 2A already does full ingestion)
      const abbr = String(team.abbreviation ?? "");
      const name = String(team.name ?? team.teamName ?? "");
      if (abbr && name) {
        await pool.query(
          `INSERT INTO teams (team_id, abbreviation, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (team_id) DO UPDATE SET
             abbreviation = COALESCE(EXCLUDED.abbreviation, teams.abbreviation),
             name         = COALESCE(EXCLUDED.name, teams.name)`,
          [teamId, abbr, name],
        );
      }

      try {
        // Fetch active 26-man roster with pitchHand hydration
        const rosterRes = await fetch(
          `${MLB_BASE}/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person`,
        );
        if (!rosterRes.ok) continue;
        const rosterPayload = await rosterRes.json() as JsonObject;

        for (const entry of asArray(rosterPayload.roster)) {
          const position = asObject(entry.position);
          // Only pitchers: position code "1" or type "Pitcher"
          if (
            String(position.code ?? "") !== "1" &&
            String(position.type ?? "").toLowerCase() !== "pitcher"
          ) continue;

          const person = asObject(entry.person);
          const playerId = asNumber(person.id);
          if (!playerId) continue;

          const fullName = String(person.fullName ?? person.name ?? `Player ${playerId}`);
          // pitchHand requires hydrate=person; falls back to empty string if unavailable
          const pitchHand = asObject(person.pitchHand);
          const throwsCode = String(pitchHand.code ?? "").trim();

          await pool.query(
            `INSERT INTO players (player_id, full_name, primary_position)
             VALUES ($1, $2, 'P')
             ON CONFLICT (player_id) DO UPDATE SET
               full_name = EXCLUDED.full_name, updated_at = now()`,
            [playerId, fullName],
          );

          // Insert with UNKNOWN role; never reset a game-feed role back to UNKNOWN
          await pool.query(
            `INSERT INTO reliever_profiles
               (player_id, team_id, throws, role, active_roster, season, role_source)
             VALUES ($1, $2, $3, 'UNKNOWN', true, $4, 'ROSTER')
             ON CONFLICT (player_id, team_id, season) DO UPDATE SET
               active_roster = true,
               throws        = CASE
                 WHEN EXCLUDED.throws IS NOT NULL AND EXCLUDED.throws <> ''
                 THEN EXCLUDED.throws
                 ELSE reliever_profiles.throws
               END,
               updated_at = now()`,
            [playerId, teamId, throwsCode || null, season],
          );
          count++;
        }
      } catch (error) {
        // One team's roster failing is partial, not fatal: continue, but count it.
        recordFailure(failures, `roster:${teamId}`, error);
      }
    }
  } catch (error) {
    recordFailure(failures, "teams", error, true);
  }
  return count;
}

/**
 * Fetch all regular-season games on a given date.
 * Returns array of { gamePk, awayTeamId, homeTeamId, status }.
 */
async function fetchGamesForDate(
  date: string,
  failures: IngestFailure[],
): Promise<Array<{ gamePk: number; awayTeamId: number; homeTeamId: number; status: string }>> {
  try {
    const url = `${MLB_BASE}/schedule?sportId=1&date=${date}&gameType=R,F,D,L,W`;
    const res = await fetch(url);
    if (!res.ok) {
      recordFailure(failures, `schedule:${date}`, new Error(`MLB schedule endpoint returned HTTP ${res.status}`));
      return [];
    }
    const payload = await res.json() as JsonObject;
    const games: Array<{ gamePk: number; awayTeamId: number; homeTeamId: number; status: string }> = [];
    for (const date_ of asArray(payload.dates)) {
      for (const game of asArray(date_.games)) {
        const gamePk = asNumber(game.gamePk);
        const awayId = asNumber(asObject(asObject(game.teams).away).team ? asObject(asObject(asObject(game.teams).away).team).id : null);
        const homeId = asNumber(asObject(asObject(game.teams).home).team ? asObject(asObject(asObject(game.teams).home).team).id : null);
        const status = String(asObject(game.status).detailedState ?? "");
        if (gamePk && awayId && homeId) {
          games.push({ gamePk, awayTeamId: awayId, homeTeamId: homeId, status });
        }
      }
    }
    return games;
  } catch (error) {
    recordFailure(failures, `schedule:${date}`, error);
    return [];
  }
}

/**
 * Derive a reliever's role from a single-game appearance's pitching stats.
 *
 * Priority order (first match wins):
 *   CLOSER          — game save credited
 *   SETUP           — hold credited
 *   LONG_MAN        — 3.0+ innings pitched in the appearance
 *   LEFTY_SPECIALIST — left-handed, ≤3 batters faced
 *   OPENER          — first reliever in pitching order, ≤2.0 IP
 *   MIDDLE          — everything else
 *
 * Returns UNKNOWN only when stats are absent or contradictory.
 */
function deriveRole(stats: {
  saves: number;
  holds: number;
  ip: number;
  battersFaced: number | null;
  throws: string;
  isFirstReliever: boolean;
}): string {
  if (stats.saves > 0) return "CLOSER";
  if (stats.holds > 0) return "SETUP";
  if (stats.ip >= 3.0) return "LONG_MAN";
  if (stats.throws === "L" && stats.battersFaced !== null && stats.battersFaced <= 3) {
    return "LEFTY_SPECIALIST";
  }
  if (stats.isFirstReliever && stats.ip <= 2.0) return "OPENER";
  return "MIDDLE";
}

/** Classify a role transition type for role_change_log.change_type. */
function deriveChangeType(previousRole: string, newRole: string): string {
  const priority: Record<string, number> = {
    CLOSER: 1, PRIMARY_SETUP: 2, SETUP: 3, MIDDLE: 4,
    LEFTY_SPECIALIST: 5, SWING: 6, LONG_MAN: 7, OPENER: 8, UNKNOWN: 9,
  };
  if (newRole === "OPENER") return "OPENER";
  const prev = priority[previousRole] ?? 9;
  const next = priority[newRole] ?? 9;
  if (next < prev) return "PROMOTION";
  if (next > prev) return "DEMOTION";
  return "SWING";
}

/**
 * Upsert a reliever profile and record a role-change event if the derived
 * role differs from what is currently stored.
 *
 * Invariant: role_change_log is append-only — entries are never updated or deleted.
 */
async function upsertRelieverProfileWithRoleTracking(
  playerId: number,
  teamId: number,
  throws: string,
  season: number,
  derivedRole: string,
  gameDate: string,
): Promise<void> {
  const existing = await pool.query<{ role: string }>(
    `SELECT role FROM reliever_profiles
     WHERE player_id = $1 AND team_id = $2 AND season = $3`,
    [playerId, teamId, season],
  );

  if (existing.rows.length === 0) {
    // First appearance for this arm — insert profile with derived role
    await pool.query(
      `INSERT INTO reliever_profiles
         (player_id, team_id, throws, role, role_effective_date, role_source, active_roster, season)
       VALUES ($1, $2, $3, $4, $5, 'GAME_FEED', true, $6)
       ON CONFLICT (player_id, team_id, season) DO NOTHING`,
      [playerId, teamId, throws || null, derivedRole, gameDate, season],
    );
    // Append initial role assignment to history (skip UNKNOWN — no information to log)
    if (derivedRole !== "UNKNOWN") {
      await pool.query(
        `INSERT INTO role_change_log
           (player_id, team_id, previous_role, new_role, change_type, effective_date, source, notes)
         VALUES ($1, $2, NULL, $3, 'PROMOTION', $4, 'GAME_FEED',
                 'Initial role assignment derived from game-feed appearance statistics')`,
        [playerId, teamId, derivedRole, gameDate],
      );
    }
  } else {
    const currentRole = existing.rows[0].role;
    const roleChanged = derivedRole !== "UNKNOWN" && derivedRole !== currentRole;

    if (roleChanged) {
      // Append role-change event — never update or delete prior entries
      const changeType = deriveChangeType(currentRole, derivedRole);
      await pool.query(
        `INSERT INTO role_change_log
           (player_id, team_id, previous_role, new_role, change_type, effective_date, source, notes)
         VALUES ($1, $2, $3, $4, $5, $6, 'GAME_FEED', $7)`,
        [
          playerId, teamId, currentRole, derivedRole, changeType, gameDate,
          `Role changed: ${currentRole} → ${derivedRole} (inferred from ${gameDate} appearance)`,
        ],
      );
      // Update profile's current role to reflect the latest assignment
      await pool.query(
        `UPDATE reliever_profiles
         SET role = $4, role_effective_date = $5, role_source = 'GAME_FEED', updated_at = now()
         WHERE player_id = $1 AND team_id = $2 AND season = $3`,
        [playerId, teamId, season, derivedRole, gameDate],
      );
    }

    // Always refresh active_roster and throws (non-historical fields)
    await pool.query(
      `UPDATE reliever_profiles
       SET active_roster = true,
           throws = COALESCE(NULLIF($4, ''), throws),
           updated_at = now()
       WHERE player_id = $1 AND team_id = $2 AND season = $3`,
      [playerId, teamId, season, throws || ""],
    );
  }
}

/**
 * Fetch and persist reliever appearances from a completed game feed.
 *
 * Append-only invariant for relief_appearance_log:
 *   ON CONFLICT (game_pk, player_id) DO NOTHING — historical rows are immutable.
 *   If the same game feed is re-fetched, existing rows are left untouched.
 *
 * Returns count of { normalized (appearances attempted), rejected (parse errors) }.
 */
async function persistGameAppearances(
  gamePk: number,
  gameDate: string,
  awayTeamId: number,
  homeTeamId: number,
  failures: IngestFailure[],
): Promise<{ normalized: number; rejected: number }> {
  let normalized = 0;
  let rejected = 0;
  try {
    const res = await fetch(`${MLB_BASE}.1/game/${gamePk}/feed/live`);
    if (!res.ok) return { normalized, rejected };
    const payload = await res.json() as JsonObject;
    const liveData = asObject(payload.liveData);
    const boxscore = asObject(liveData.boxscore);
    const bsTeams = asObject(boxscore.teams);

    for (const [side, teamId] of [["away", awayTeamId], ["home", homeTeamId]] as const) {
      const bsTeam = asObject(bsTeams[side]);
      const players = asObject(bsTeam.players);
      const opponentTeamId = side === "away" ? homeTeamId : awayTeamId;

      // pitchingOrder[0] = starter; pitchingOrder[1] = first reliever (possible OPENER)
      const pitchingOrder: number[] = asArray(bsTeam.pitchers)
        .map((p) => asNumber(p))
        .filter((id): id is number => id !== null);

      for (const entry of Object.values(players)) {
        const player = asObject(entry);
        const pitching = asObject(asObject(player.stats).pitching);
        const gamesStarted = asNumber(pitching.gamesStarted);
        const pitchesThrown = asNumber(pitching.pitchesThrown);

        // Skip non-pitchers and starters
        if ((pitchesThrown === null || pitchesThrown === 0) && !pitching.inningsPitched) continue;
        if (gamesStarted === 1) continue;

        const personObj = asObject(player.person);
        const playerId = asNumber(personObj.id);
        if (!playerId) continue;

        const ipRaw = pitching.inningsPitched;
        const ipDecimal = parseIp(ipRaw);
        const isMultiInning = ipDecimal >= 2.0;

        // Derive reliever role from this game's appearance stats
        const saves = asNumber(pitching.saves) ?? 0;
        const holds = asNumber(pitching.holds) ?? 0;
        const battersFaced = asNumber(pitching.battersFaced);
        // Throwing hand: person.pitchHand.code → "L", "R", or "S".
        // position.code is the positional ID ("1" for pitcher), NOT handedness.
        const throwsCode = String(asObject(personObj.pitchHand).code ?? "").trim();
        const playerIndex = pitchingOrder.indexOf(playerId);
        // isFirstReliever: non-starter who appears first in pitching order (index 1)
        const isFirstReliever = playerIndex === 1 && (gamesStarted ?? 0) === 0;

        const derivedRole = deriveRole({ saves, holds, ip: ipDecimal, battersFaced, throws: throwsCode, isFirstReliever });

        // Ensure player exists
        await pool.query(
          `INSERT INTO players (player_id, full_name, primary_position)
           VALUES ($1, $2, 'P')
           ON CONFLICT (player_id) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = now()`,
          [playerId, String(personObj.fullName ?? personObj.name ?? `Player ${playerId}`)],
        );

        // Ensure game record exists
        await pool.query(
          `INSERT INTO games (game_pk, game_date, away_team_id, home_team_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (game_pk) DO NOTHING`,
          [gamePk, gameDate, awayTeamId, homeTeamId],
        );

        try {
          // ── APPEND-ONLY: DO NOTHING preserves immutable historical rows ──────────
          await pool.query(
            `INSERT INTO relief_appearance_log
               (game_pk, game_date, team_id, player_id, opponent_team_id,
                innings_pitched, pitch_count, batters_faced, hits_allowed,
                walks_allowed, strikeouts, runs_allowed, is_multi_inning, source_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (game_pk, player_id) DO NOTHING`,
            [
              gamePk, gameDate, teamId, playerId, opponentTeamId,
              ipDecimal > 0 ? ipDecimal.toFixed(4) : null,
              pitchesThrown,
              battersFaced,
              asNumber(pitching.hits),
              asNumber(pitching.baseOnBalls),
              asNumber(pitching.strikeOuts),
              asNumber(pitching.runs),
              isMultiInning,
              BULLPEN_SOURCE,
            ],
          );

          // ── Role pipeline: upsert profile and record any role change ─────────────
          const season = Number(gameDate.slice(0, 4));
          await upsertRelieverProfileWithRoleTracking(
            playerId, teamId, throwsCode, season, derivedRole, gameDate,
          );

          normalized++;
        } catch (error) {
          recordFailure(failures, `appearance:${gamePk}:${playerId}`, error);
          rejected++;
        }
      }
    }
  } catch (error) {
    recordFailure(failures, `gameFeed:${gamePk}`, error);
    rejected++;
  }
  return { normalized, rejected };
}

/**
 * Derive heuristic availability state from the D-1/D-2/D-3 window.
 *
 * "Appeared" and "threw N pitches" are separate facts. A logged appearance with
 * a null pitch_count used to be coerced to 1, which made "appeared, count
 * unknown" indistinguishable from "threw one pitch" everywhere downstream. The
 * appearance flags carry the first fact and the pitch counts carry the second;
 * a null count no longer invents a number.
 *
 * teamWindowObserved separates "this bullpen threw nobody in three days", which
 * is a rested bullpen, from "we have no data about this bullpen at all", which
 * is UNKNOWN. When it is not supplied the old rule applies, so the pure
 * function still answers the historical cases identically.
 */
export function computeHeuristicAvailability(data: {
  d1Pitches: number | null;
  d2Pitches: number | null;
  d3Pitches: number | null;
  multiInningYesterday: boolean;
  d1Appeared?: boolean;
  d2Appeared?: boolean;
  d3Appeared?: boolean;
  /** Whether any observation of this team's bullpen exists in the window. */
  teamWindowObserved?: boolean;
}): "AVAILABLE" | "LIKELY_AVAILABLE" | "DOUBTFUL" | "OUT" | "UNKNOWN" {
  const { d1Pitches, d2Pitches, d3Pitches, multiInningYesterday } = data;

  const observed = data.teamWindowObserved
    ?? (d1Pitches !== null || d2Pitches !== null || d3Pitches !== null);
  // No data at all is not the same fact as no appearances.
  if (!observed) return "UNKNOWN";

  const usedD1 = data.d1Appeared ?? (d1Pitches ?? 0) > 0;
  const usedD2 = data.d2Appeared ?? (d2Pitches ?? 0) > 0;
  const usedD3 = data.d3Appeared ?? (d3Pitches ?? 0) > 0;

  // OUT: 3 consecutive days
  if (usedD1 && usedD2 && usedD3) return "OUT";

  // DOUBTFUL: 2 consecutive days, OR ≥35 pitches yesterday, OR multi-inning yesterday
  if ((usedD1 && usedD2) || (d1Pitches !== null && d1Pitches >= 35) || multiInningYesterday) {
    return "DOUBTFUL";
  }

  // LIKELY_AVAILABLE: pitched 2–3 days ago but not yesterday
  if (!usedD1 && (usedD2 || usedD3)) return "LIKELY_AVAILABLE";

  // AVAILABLE: no appearance in D-1/D-2/D-3
  return "AVAILABLE";
}

/**
 * For each team, compute bullpen_availability_observations for the given slate date.
 * Looks back 3 days of relief_appearance_log data.
 */
async function computeTeamAvailability(teamId: number, slateDate: string): Promise<number> {
  let count = 0;
  const d1 = dateOffset(slateDate, -1);
  const d2 = dateOffset(slateDate, -2);
  const d3 = dateOffset(slateDate, -3);

  // The upstream observation this team's availability is derived from.
  //
  // source_freshness used to be written as new Date().toISOString(), which is
  // computed_at under a second name, and isCurrentBullpenTimestamp then checked
  // that value as if it described the age of the MLB data. The gate always
  // passed regardless of how stale the underlying feed was: a tautology.
  //
  // It is now the feed retrieval time of the most recent relief appearance in
  // the D-1/D-2/D-3 window for this team, which is the evidence every state in
  // that window is derived from, including the absence of appearances. Where
  // the window holds no observation at all, it is null and the state is
  // UNKNOWN rather than AVAILABLE.
  const observation = await pool.query<{ recorded_at: string | null; game_date: string | null }>(
    `SELECT max(recorded_at)::text AS recorded_at, max(game_date)::text AS game_date
       FROM relief_appearance_log
      WHERE team_id = $1 AND game_date IN ($2, $3, $4)`,
    [teamId, d1, d2, d3],
  );
  const sourceFreshness = observation.rows[0]?.recorded_at ?? null;
  const sourceObservationGameDate = observation.rows[0]?.game_date ?? null;
  const teamWindowObserved = sourceFreshness !== null;

  // Get all active relievers for this team this season
  const season = Number(slateDate.slice(0, 4));
  const relievers = await pool.query<{ player_id: number }>(
    `SELECT DISTINCT rp.player_id FROM reliever_profiles rp
     WHERE rp.team_id = $1 AND rp.season = $2 AND rp.active_roster = true`,
    [teamId, season],
  );

  for (const { player_id: playerId } of relievers.rows) {
    // Fetch appearances for D-1, D-2, D-3
    const apps = await pool.query<{
      game_date: string;
      pitch_count: number | null;
      is_multi_inning: boolean;
    }>(
      `SELECT game_date, pitch_count, is_multi_inning
       FROM relief_appearance_log
       WHERE player_id = $1 AND team_id = $2 AND game_date IN ($3, $4, $5)`,
      [playerId, teamId, d1, d2, d3],
    );

    const byDate = new Map(apps.rows.map((row) => [row.game_date, row]));
    const d1Row = byDate.get(d1);
    const d2Row = byDate.get(d2);
    const d3Row = byDate.get(d3);

    // Appearance and pitch count are tracked separately. A logged appearance
    // with a null pitch_count used to be coerced to 1, conflating "appeared,
    // count unknown" with "threw one pitch".
    const d1Appeared = Boolean(d1Row);
    const d2Appeared = Boolean(d2Row);
    const d3Appeared = Boolean(d3Row);
    // Keep values sent to integer columns finite and integral even if a driver
    // returns a numeric field as a string or an invalid value. Null now means
    // the count is genuinely unknown.
    const d1Pitches = asInteger(d1Row?.pitch_count);
    const d2Pitches = asInteger(d2Row?.pitch_count);
    const d3Pitches = asInteger(d3Row?.pitch_count);
    const multiInningYesterday = d1Row?.is_multi_inning ?? false;

    const usedD1 = d1Appeared;
    const usedD2 = d2Appeared;
    const usedD3 = d3Appeared;
    const consecutiveDaysUsed = usedD1 ? (usedD2 ? (usedD3 ? 3 : 2) : 1) : 0;

    // Days since last use
    let daysSinceLastUse: number | null = null;
    if (!usedD1 && !usedD2 && !usedD3) {
      // Calculate the date difference in PostgreSQL. This avoids relying on
      // the runtime's parser for the DATE value and guarantees an integer
      // result for the integer availability column.
      const lastApp = await pool.query<{ days_since_last_use: number | null }>(
        `SELECT ($4::date - game_date)::int AS days_since_last_use
         FROM relief_appearance_log
         WHERE player_id = $1 AND team_id = $2 AND game_date < $3
         ORDER BY game_date DESC LIMIT 1`,
        [playerId, teamId, d1, slateDate],
      );
      if (lastApp.rows[0]) {
        daysSinceLastUse = asInteger(lastApp.rows[0].days_since_last_use);
      }
    } else {
      daysSinceLastUse = usedD1 ? 1 : usedD2 ? 2 : 3;
    }

    const heuristic = computeHeuristicAvailability({
      d1Pitches, d2Pitches, d3Pitches, multiInningYesterday,
      d1Appeared, d2Appeared, d3Appeared, teamWindowObserved,
    });

    // Check for existing manager override
    const existingObs = await pool.query<{
      manager_override: string | null;
      manager_override_note: string | null;
    }>(
      `SELECT manager_override, manager_override_note
       FROM bullpen_availability_observations
       WHERE player_id = $1 AND slate_date = $2`,
      [playerId, slateDate],
    );

    const override = existingObs.rows[0]?.manager_override ?? null;
    const overrideNote = existingObs.rows[0]?.manager_override_note ?? null;
    const finalState = override ?? heuristic;
    const confidence = override ? "MANAGER_OVERRIDE" : (heuristic === "UNKNOWN" ? "UNKNOWN" : "HEURISTIC");

    await pool.query(
      `INSERT INTO bullpen_availability_observations
         (player_id, team_id, slate_date, d1_pitches, d2_pitches, d3_pitches,
          consecutive_days_used, multi_inning_yesterday, days_since_last_use,
          heuristic_availability, manager_override, manager_override_note,
          final_state, confidence, source_freshness,
          d1_appeared, d2_appeared, d3_appeared, source_observation_game_date, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
       ON CONFLICT (player_id, slate_date) DO UPDATE SET
         d1_pitches            = EXCLUDED.d1_pitches,
         d2_pitches            = EXCLUDED.d2_pitches,
         d3_pitches            = EXCLUDED.d3_pitches,
         d1_appeared           = EXCLUDED.d1_appeared,
         d2_appeared           = EXCLUDED.d2_appeared,
         d3_appeared           = EXCLUDED.d3_appeared,
         consecutive_days_used = EXCLUDED.consecutive_days_used,
         multi_inning_yesterday= EXCLUDED.multi_inning_yesterday,
         days_since_last_use   = EXCLUDED.days_since_last_use,
         heuristic_availability= EXCLUDED.heuristic_availability,
         final_state           = EXCLUDED.final_state,
         confidence            = EXCLUDED.confidence,
         source_freshness      = EXCLUDED.source_freshness,
         source_observation_game_date = EXCLUDED.source_observation_game_date,
         computed_at           = now()`,
      [
        playerId, teamId, slateDate, d1Pitches, d2Pitches, d3Pitches,
        consecutiveDaysUsed, multiInningYesterday, daysSinceLastUse,
        heuristic, override, overrideNote, finalState, confidence,
        // The upstream observation time, not now(). computed_at already
        // records when this row was computed.
        sourceFreshness,
        d1Appeared, d2Appeared, d3Appeared, sourceObservationGameDate,
      ],
    );
    count++;
  }
  return count;
}

/**
 * Build leverage map for a team's bullpen on a given slate date.
 * Derives sequence from role assignments and current availability.
 */
async function buildTeamLeverageMap(teamId: number, slateDate: string): Promise<void> {
  const season = Number(slateDate.slice(0, 4));

  // Get available arms with roles and walk rate
  const arms = await pool.query<{
    player_id: number;
    role: string;
    throws: string | null;
    walk_rate_percent: number | null;
    final_state: string | null;
     source_freshness: string | null;
     computed_at: string | null;
  }>(
    `SELECT rp.player_id, rp.role, rp.throws, rp.walk_rate_percent,
             obs.final_state, obs.source_freshness, obs.computed_at::text
     FROM reliever_profiles rp
     LEFT JOIN bullpen_availability_observations obs
       ON obs.player_id = rp.player_id AND obs.slate_date = $1
     WHERE rp.team_id = $2 AND rp.season = $3 AND rp.active_roster = true`,
    [slateDate, teamId, season],
  );

  const available = arms.rows.filter((a) =>
    (a.final_state === "AVAILABLE" || a.final_state === "LIKELY_AVAILABLE")
      && isCurrentBullpenTimestamp(a.source_freshness)
      && isCurrentBullpenTimestamp(a.computed_at),
  );

  // Role priority ordering for high-leverage slots
  const rolePriority: Record<string, number> = {
    CLOSER: 1, PRIMARY_SETUP: 2, SETUP: 3, MIDDLE: 4,
    LEFTY_SPECIALIST: 5, SWING: 6, LONG_MAN: 7, OPENER: 8, UNKNOWN: 9,
  };

  const sorted = [...available].sort(
    (a, b) => (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9),
  );

  // A leverage map is a path, not a team-wide average. Prefer traditional
  // 9th/8th/7th roles, but keep a transparent fallback within the available,
  // fresh room so a role change does not silently reuse the same arm twice.
  const claimed = new Set<number>();
  const takeRole = (...roles: string[]) => {
    const arm = sorted.find((candidate) => !claimed.has(candidate.player_id) && roles.includes(candidate.role));
    if (!arm) return null;
    claimed.add(arm.player_id);
    return arm.player_id;
  };
  const closer = takeRole("CLOSER", "PRIMARY_SETUP", "SETUP");
  const setup8 = takeRole("PRIMARY_SETUP", "SETUP", "MIDDLE");
  const setup7 = takeRole("SETUP", "MIDDLE", "SWING");
  const leftySpecialist = available.find((a) => a.role === "LEFTY_SPECIALIST" && a.throws === "L")?.player_id ?? null;
  const longMan = available.find((a) => a.role === "LONG_MAN")?.player_id ?? null;

  // Highest/lowest walk rate among available arms
  const withWalkRate = available.filter((a) => a.walk_rate_percent !== null);
  withWalkRate.sort((a, b) => (b.walk_rate_percent ?? 0) - (a.walk_rate_percent ?? 0));
  const highestWalk = withWalkRate[0]?.player_id ?? null;
  const lowestWalk = withWalkRate[withWalkRate.length - 1]?.player_id ?? null;

  const hasRoleData = available.some((a) => a.role !== "UNKNOWN");
  const roleUncertainty = !hasRoleData || closer === null || setup8 === null || setup7 === null;

  await pool.query(
    `INSERT INTO bullpen_leverage_maps
       (team_id, slate_date, projected_9th, projected_8th, projected_7th,
        highest_leverage_lefty, long_man, highest_walk_reliever, lowest_walk_reliever,
        role_uncertainty, notes, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (team_id, slate_date) DO UPDATE SET
       projected_9th          = EXCLUDED.projected_9th,
       projected_8th          = EXCLUDED.projected_8th,
       projected_7th          = EXCLUDED.projected_7th,
       highest_leverage_lefty = EXCLUDED.highest_leverage_lefty,
       long_man               = EXCLUDED.long_man,
       highest_walk_reliever  = EXCLUDED.highest_walk_reliever,
       lowest_walk_reliever   = EXCLUDED.lowest_walk_reliever,
       role_uncertainty       = EXCLUDED.role_uncertainty,
       notes                  = EXCLUDED.notes,
       computed_at            = now()`,
    [
      teamId, slateDate, closer, setup8, setup7,
      leftySpecialist, longMan, highestWalk, lowestWalk,
      roleUncertainty,
       roleUncertainty
         ? "Projected 7th/8th/9th leverage path is incomplete or role data is UNKNOWN"
         : null,
    ],
  );
}

/**
 * Returns the exact projected 7th/8th/9th path that a market engine may use.
 * Team-wide availability is intentionally insufficient: an arm metric can only
 * be aggregated when the map, all path observations, and their sources are
 * current. Missing and stale paths remain distinct for downstream audit gates.
 */
export async function getBullpenRolePath(teamId: number, slateDate: string): Promise<BullpenRolePath> {
  const now = Date.now();
  const [armsResult, mapResult] = await Promise.all([
    pool.query<{
      player_id: number;
      role: string;
      final_state: string;
      source_freshness: string | null;
      computed_at: string | null;
    }>(
      `SELECT bao.player_id, rp.role, bao.final_state, bao.source_freshness,
              bao.computed_at::text
       FROM bullpen_availability_observations bao
       LEFT JOIN reliever_profiles rp
         ON rp.player_id = bao.player_id
        AND rp.team_id = bao.team_id
        AND rp.season = EXTRACT(YEAR FROM bao.slate_date)::int
       WHERE bao.team_id = $1 AND bao.slate_date = $2`,
      [teamId, slateDate],
    ),
    pool.query<{
      projected_9th: number | null;
      projected_8th: number | null;
      projected_7th: number | null;
      role_uncertainty: boolean;
      notes: string | null;
      computed_at: string | null;
    }>(
      `SELECT projected_9th, projected_8th, projected_7th, role_uncertainty,
              notes, computed_at::text
       FROM bullpen_leverage_maps
       WHERE team_id = $1 AND slate_date = $2`,
      [teamId, slateDate],
    ),
  ]);

  const observedArms = armsResult.rows;
  const availableArms = observedArms.filter((arm) =>
    (arm.final_state === "AVAILABLE" || arm.final_state === "LIKELY_AVAILABLE")
      && isCurrentBullpenTimestamp(arm.source_freshness, now)
      && isCurrentBullpenTimestamp(arm.computed_at, now),
  ).length;

  const unavailable = (
    status: BullpenRolePathStatus,
    reason: string,
    computedAt: string | null = null,
  ): BullpenRolePath => ({
    status,
    reason,
    availableArms,
    armIds: [],
    rolePath: [],
    computedAt,
  });

  if (observedArms.length === 0) {
    return unavailable("MISSING", "No bullpen availability observations exist for this slate.");
  }

  const map = mapResult.rows[0];
  if (!map) {
    return unavailable("MISSING", "No bullpen leverage map exists for this slate.");
  }
  if (!isCurrentBullpenTimestamp(map.computed_at, now)) {
    return unavailable("STALE", "Bullpen leverage map is stale or its freshness timestamp is unknown.", map.computed_at);
  }
  if (map.role_uncertainty) {
    return unavailable("ROLE_INCOMPLETE", map.notes ?? "Bullpen leverage roles are incomplete.", map.computed_at);
  }

  const slots: Array<{ slot: BullpenRolePathArm["slot"]; playerId: number | null }> = [
    { slot: "7TH", playerId: map.projected_7th },
    { slot: "8TH", playerId: map.projected_8th },
    { slot: "9TH", playerId: map.projected_9th },
  ];
  if (slots.some((slot) => slot.playerId === null)) {
    return unavailable("ROLE_INCOMPLETE", "Projected 7th/8th/9th leverage path is incomplete.", map.computed_at);
  }

  const byPlayerId = new Map(observedArms.map((arm) => [arm.player_id, arm]));
  const rolePath: BullpenRolePathArm[] = [];
  for (const slot of slots) {
    const arm = byPlayerId.get(slot.playerId!);
    if (!arm) {
      return unavailable("ROLE_INCOMPLETE", `Projected ${slot.slot.toLowerCase()} arm has no availability observation.`, map.computed_at);
    }
    if (!isCurrentBullpenTimestamp(arm.source_freshness, now) || !isCurrentBullpenTimestamp(arm.computed_at, now)) {
      return unavailable("STALE", `Projected ${slot.slot.toLowerCase()} arm has stale or unknown bullpen source freshness.`, map.computed_at);
    }
    if (!["AVAILABLE", "LIKELY_AVAILABLE"].includes(arm.final_state)) {
      return unavailable("ROLE_INCOMPLETE", `Projected ${slot.slot.toLowerCase()} arm is not available for the bullpen path.`, map.computed_at);
    }
    if (!arm.role || arm.role === "UNKNOWN") {
      return unavailable("ROLE_INCOMPLETE", `Projected ${slot.slot.toLowerCase()} arm has no resolved bullpen role.`, map.computed_at);
    }
    rolePath.push({ slot: slot.slot, playerId: arm.player_id, role: arm.role });
  }

  return {
    status: "CURRENT",
    reason: null,
    availableArms,
    armIds: rolePath.map((arm) => arm.playerId),
    rolePath,
    computedAt: map.computed_at,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Main ingestion entry point. Refreshes the last 3 days of game data and
 * recomputes availability observations and leverage maps for slateDate.
 */
/**
 * Whether the slate had scheduled games. An ingest that normalized zero
 * appearances on a day that had a real slate is a failure, not a success.
 */
async function scheduledGamesInWindow(slateDate: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM games
      WHERE game_date IN ($1::date - 3, $1::date - 2, $1::date - 1)`,
    [slateDate],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function refreshBullpen(slateDate: string): Promise<{
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  gamesProcessed: number;
  appearancesNormalized: number;
  appearancesRejected: number;
  teamsComputed: number;
  expectedGames: number;
  failures: IngestFailure[];
  error?: string;
}> {
  await ensureBullpenSource();
  const started = Date.now();
  const runId = await startRun("bullpen_ingest", slateDate);

  let gamesProcessed = 0;
  let appearancesNormalized = 0;
  let appearancesRejected = 0;
  let runError: string | undefined;
  const failures: IngestFailure[] = [];

  const season = Number(slateDate.slice(0, 4));

  try {
    // Step 1: Ensure all active MLB pitchers have profiles (roster coverage).
    // This runs before game-feed ingestion so arms that haven't appeared recently
    // still show up in the bullpen room with UNKNOWN state.
    await ingestActiveRosters(season, failures);

    // Step 2: Ingest last 3 days of completed game appearances.
    for (let offset = -3; offset <= -1; offset++) {
      const date = dateOffset(slateDate, offset);
      const games = await fetchGamesForDate(date, failures);
      for (const game of games) {
        if (!game.status.toLowerCase().includes("final")) continue;
        const { normalized, rejected } = await persistGameAppearances(
          game.gamePk, date, game.awayTeamId, game.homeTeamId, failures,
        );
        appearancesNormalized += normalized;
        appearancesRejected += rejected;
        gamesProcessed++;
      }
    }

    // Step 3: Compute availability observations and leverage maps for all teams.
    const teams = await pool.query<{ team_id: number }>(
      `SELECT DISTINCT team_id FROM reliever_profiles WHERE season = $1`,
      [season],
    );

    let teamsComputed = 0;
    for (const { team_id } of teams.rows) {
      await computeTeamAvailability(team_id, slateDate);
      await buildTeamLeverageMap(team_id, slateDate);
      teamsComputed++;
    }

    // Expected-volume check. Zero normalized appearances on a window that had
    // scheduled games is a failure, whatever the sub-fetches reported.
    const expectedGames = await scheduledGamesInWindow(slateDate);
    const fatal = failures.some((failure) => failure.fatal);
    const emptyDespiteSlate = expectedGames > 0 && appearancesNormalized === 0;
    const status: "SUCCESS" | "PARTIAL" | "FAILED" = fatal || emptyDespiteSlate
      ? "FAILED"
      : failures.length
        ? "PARTIAL"
        : "SUCCESS";
    if (status !== "SUCCESS") {
      runError = fatal
        ? `Bullpen ingest failed: ${failures.filter((f) => f.fatal).map((f) => `${f.scope}: ${f.detail}`).join("; ")}`
        : emptyDespiteSlate
          ? `Bullpen ingest normalized zero appearances across ${expectedGames} scheduled game(s).`
          : `Bullpen ingest completed with ${failures.length} sub-fetch failure(s): `
            + failures.slice(0, 5).map((f) => `${f.scope}: ${f.detail}`).join("; ");
      logger.error({ slateDate, status, failures }, "bullpen refresh did not fully succeed");
    }

    await finishRun(runId, status, {
      rows: gamesProcessed,
      normalized: appearancesNormalized,
      rejected: appearancesRejected,
    }, started, runError);

    return {
      status,
      gamesProcessed,
      appearancesNormalized,
      appearancesRejected,
      teamsComputed,
      expectedGames,
      failures,
      ...(runError ? { error: runError } : {}),
    };
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "FAILED", {
      rows: gamesProcessed,
      normalized: appearancesNormalized,
      rejected: appearancesRejected,
      error: runError,
    }, started);
    return {
      status: "FAILED",
      gamesProcessed,
      appearancesNormalized,
      appearancesRejected,
      teamsComputed: 0,
      expectedGames: 0,
      failures,
      error: runError,
    };
  }
}

/**
 * Get the bullpen room data for the API response.
 * Returns all 30 teams (or a single team if filtered).
 */
export async function getBullpenRoom(slateDate: string, teamFilter?: string): Promise<BullpenRoomData> {
  const season = Number(slateDate.slice(0, 4));
  const freshnessThresholdMs = BULLPEN_FRESHNESS_WINDOW_MS;

  // Get all teams with reliever data this season (or filtered team)
  const teamsQuery = await pool.query<{
    team_id: number;
    abbreviation: string;
    name: string;
  }>(
    teamFilter
      ? `SELECT t.team_id, t.abbreviation, t.name FROM teams t
         JOIN reliever_profiles rp ON rp.team_id = t.team_id AND rp.season = $1
         WHERE t.abbreviation = $2 GROUP BY t.team_id, t.abbreviation, t.name ORDER BY t.abbreviation`
      : `SELECT t.team_id, t.abbreviation, t.name FROM teams t
         JOIN reliever_profiles rp ON rp.team_id = t.team_id AND rp.season = $1
         GROUP BY t.team_id, t.abbreviation, t.name ORDER BY t.abbreviation`,
    teamFilter ? [season, teamFilter] : [season],
  );

  const result: BullpenTeamData[] = [];

  for (const team of teamsQuery.rows) {
    // Get arms with availability observations
    const arms = await pool.query<{
      player_id: number;
      full_name: string;
      throws: string | null;
      role: string;
      d1_pitches: number | null;
      d2_pitches: number | null;
      d3_pitches: number | null;
      consecutive_days_used: number;
      multi_inning_yesterday: boolean;
      days_since_last_use: number | null;
      heuristic_availability: string;
      manager_override: string | null;
      manager_override_note: string | null;
      final_state: string;
      confidence: string;
      source_freshness: string | null;
      computed_at: string | null;
    }>(
      `SELECT p.player_id, p.full_name, rp.throws, rp.role,
              obs.d1_pitches, obs.d2_pitches, obs.d3_pitches,
              COALESCE(obs.consecutive_days_used, 0) AS consecutive_days_used,
              COALESCE(obs.multi_inning_yesterday, false) AS multi_inning_yesterday,
              obs.days_since_last_use,
              COALESCE(obs.heuristic_availability, 'UNKNOWN') AS heuristic_availability,
              obs.manager_override, obs.manager_override_note,
              COALESCE(obs.final_state, 'UNKNOWN') AS final_state,
              COALESCE(obs.confidence, 'UNKNOWN') AS confidence,
              obs.source_freshness,
              obs.computed_at::text AS computed_at
       FROM reliever_profiles rp
       JOIN players p ON p.player_id = rp.player_id
       LEFT JOIN bullpen_availability_observations obs
         ON obs.player_id = rp.player_id AND obs.slate_date = $1
       WHERE rp.team_id = $2 AND rp.season = $3 AND rp.active_roster = true
       ORDER BY CASE rp.role
         WHEN 'CLOSER' THEN 1 WHEN 'PRIMARY_SETUP' THEN 2 WHEN 'SETUP' THEN 3
         WHEN 'MIDDLE' THEN 4 WHEN 'LEFTY_SPECIALIST' THEN 5 WHEN 'SWING' THEN 6
         WHEN 'LONG_MAN' THEN 7 WHEN 'OPENER' THEN 8 ELSE 9 END,
         p.full_name`,
      [slateDate, team.team_id, season],
    );

    // Get leverage map
    const lmRow = await pool.query<{
      projected_9th: number | null;
      projected_8th: number | null;
      projected_7th: number | null;
      highest_leverage_lefty: number | null;
      long_man: number | null;
      highest_walk_reliever: number | null;
      lowest_walk_reliever: number | null;
      role_uncertainty: boolean;
      notes: string | null;
      computed_at: string | null;
    }>(
      `SELECT projected_9th, projected_8th, projected_7th, highest_leverage_lefty,
              long_man, highest_walk_reliever, lowest_walk_reliever,
              role_uncertainty, notes, computed_at::text AS computed_at
       FROM bullpen_leverage_maps WHERE team_id = $1 AND slate_date = $2`,
      [team.team_id, slateDate],
    );

    // Get D-1/D-2/D-3 usage grid
    const usageQuery = await pool.query<{
      game_date: string;
      player_id: number;
      full_name: string;
      pitch_count: number | null;
      innings_pitched: string | null;
      is_multi_inning: boolean;
    }>(
      `SELECT ral.game_date, ral.player_id, p.full_name,
              ral.pitch_count, ral.innings_pitched::text, ral.is_multi_inning
       FROM relief_appearance_log ral
       JOIN players p ON p.player_id = ral.player_id
       WHERE ral.team_id = $1
         AND ral.game_date IN ($2, $3, $4)
       ORDER BY ral.game_date DESC, ral.pitch_count DESC NULLS LAST`,
      [team.team_id,
       dateOffset(slateDate, -1), dateOffset(slateDate, -2), dateOffset(slateDate, -3)],
    );

    // Role-change history: batch-load for all arms on this team in one query
    const armPlayerIds = arms.rows.map((a) => a.player_id);
    const roleHistoryQuery = armPlayerIds.length > 0
      ? await pool.query<{
          player_id: number;
          change_id: string;
          previous_role: string | null;
          new_role: string;
          change_type: string;
          effective_date: string;
          source: string;
          notes: string | null;
          recorded_at: string;
        }>(
          `SELECT player_id, change_id::text, previous_role, new_role, change_type,
                  effective_date::text, source, notes, recorded_at::text
           FROM role_change_log
           WHERE player_id = ANY($1) AND team_id = $2
           ORDER BY recorded_at ASC`,
          [armPlayerIds, team.team_id],
        )
      : { rows: [] as { player_id: number; change_id: string; previous_role: string | null; new_role: string; change_type: string; effective_date: string; source: string; notes: string | null; recorded_at: string }[] };

    const roleHistoryByPlayer = new Map<number, RoleHistoryEntry[]>();
    for (const row of roleHistoryQuery.rows) {
      if (!roleHistoryByPlayer.has(row.player_id)) {
        roleHistoryByPlayer.set(row.player_id, []);
      }
      roleHistoryByPlayer.get(row.player_id)!.push({
        changeId: row.change_id,
        previousRole: row.previous_role,
        newRole: row.new_role,
        changeType: row.change_type,
        effectiveDate: row.effective_date,
        source: row.source,
        notes: row.notes,
        recordedAt: row.recorded_at,
      });
    }

    const d1Date = dateOffset(slateDate, -1);
    const d2Date = dateOffset(slateDate, -2);
    const d3Date = dateOffset(slateDate, -3);
    const usageByDate = (date: string) =>
      usageQuery.rows.filter((r) => r.game_date === date).map((r) => ({
        playerId: r.player_id,
        name: r.full_name,
        pitches: r.pitch_count ?? 0,
        ip: r.innings_pitched ?? "0.0",
        multiInning: r.is_multi_inning,
      }));

    // Stale check
    const now = Date.now();
    const computedAts = arms.rows.map((a) => a.computed_at).filter(Boolean) as string[];
    const latestComputed = computedAts.length
      ? Math.max(...computedAts.map((d) => new Date(d).getTime()))
      : 0;
    const staleBadge = latestComputed > 0 && (now - latestComputed) > freshnessThresholdMs;

    // Coverage percentage
    const totalArms = arms.rows.length;
    const armsWithState = arms.rows.filter((a) => a.final_state !== "UNKNOWN").length;
    const coveragePercentage = totalArms > 0 ? (armsWithState / totalArms) * 100 : 0;

    const lm = lmRow.rows[0];
    const leverageMap: BullpenLeverageMap = lm
      ? {
          projected9th: lm.projected_9th,
          projected8th: lm.projected_8th,
          projected7th: lm.projected_7th,
          highestLeverageLefty: lm.highest_leverage_lefty,
          longMan: lm.long_man,
          highestWalkReliever: lm.highest_walk_reliever,
          lowestWalkReliever: lm.lowest_walk_reliever,
          roleUncertainty: lm.role_uncertainty,
          notes: lm.notes,
          computedAt: lm.computed_at,
        }
      : {
          projected9th: null, projected8th: null, projected7th: null,
          highestLeverageLefty: null, longMan: null,
          highestWalkReliever: null, lowestWalkReliever: null,
          roleUncertainty: true,
          notes: "No leverage map computed — run POST /analyst/refresh/bullpen first",
          computedAt: null,
        };

    result.push({
      teamId: team.team_id,
      abbreviation: team.abbreviation,
      name: team.name,
      slateDate,
      leverageMap,
      arms: arms.rows.map((a) => ({
        playerId: a.player_id,
        name: a.full_name,
        throws: a.throws ?? "?",
        role: a.role,
        availability: a.final_state as BullpenArmAvailability,
        confidence: a.confidence as BullpenConfidence,
        d1Pitches: a.d1_pitches,
        d2Pitches: a.d2_pitches,
        d3Pitches: a.d3_pitches,
        consecutiveDays: a.consecutive_days_used,
        multiInningYesterday: a.multi_inning_yesterday,
        daysSinceLastUse: a.days_since_last_use,
        managerOverride: a.manager_override as BullpenArmAvailability | null,
        managerOverrideNote: a.manager_override_note,
        staleBadge: a.computed_at ? (now - new Date(a.computed_at).getTime()) > freshnessThresholdMs : false,
        sourceFreshness: a.source_freshness,
        computedAt: a.computed_at,
        roleHistory: roleHistoryByPlayer.get(a.player_id) ?? [],
      })),
      usage: {
        d1: usageByDate(d1Date),
        d2: usageByDate(d2Date),
        d3: usageByDate(d3Date),
      },
      coveragePercentage,
      staleBadge,
      computedAt: latestComputed > 0 ? new Date(latestComputed).toISOString() : null,
    });
  }

  const allArms = result.flatMap((t) => t.arms);
  return {
    date: slateDate,
    requestedTeam: teamFilter ?? null,
    staleFreshnessWindowSeconds: 86400,
    teams: result,
    summary: {
      teamsWithData: result.length,
      teamsStale: result.filter((t) => t.staleBadge).length,
      totalArms: allArms.length,
      armsAvailable: allArms.filter((a) => a.availability === "AVAILABLE").length,
      armsLikelyAvailable: allArms.filter((a) => a.availability === "LIKELY_AVAILABLE").length,
      armsDoubtful: allArms.filter((a) => a.availability === "DOUBTFUL").length,
      armsOut: allArms.filter((a) => a.availability === "OUT").length,
      armsUnknown: allArms.filter((a) => a.availability === "UNKNOWN" || a.availability === "STALE").length,
    },
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type BullpenArmAvailability = "AVAILABLE" | "LIKELY_AVAILABLE" | "DOUBTFUL" | "OUT" | "UNKNOWN" | "STALE";
export type BullpenConfidence = "HEURISTIC" | "MANAGER_OVERRIDE" | "UNKNOWN";
export type BullpenRolePathStatus = "CURRENT" | "STALE" | "MISSING" | "ROLE_INCOMPLETE";

export interface BullpenRolePathArm {
  slot: "7TH" | "8TH" | "9TH";
  playerId: number;
  role: string;
}

/**
 * A market-safe bullpen path. Only CURRENT paths may contribute pitcher
 * metrics to a market engine; all other states are persisted as audit evidence.
 */
export interface BullpenRolePath {
  status: BullpenRolePathStatus;
  reason: string | null;
  availableArms: number;
  armIds: number[];
  rolePath: BullpenRolePathArm[];
  computedAt: string | null;
}

/** One entry in the append-only role_change_log for a reliever. */
export interface RoleHistoryEntry {
  changeId: string;
  previousRole: string | null;
  newRole: string;
  changeType: string;
  effectiveDate: string;
  source: string;
  notes: string | null;
  recordedAt: string;
}

export interface BullpenLeverageMap {
  projected9th: number | null;
  projected8th: number | null;
  projected7th: number | null;
  highestLeverageLefty: number | null;
  longMan: number | null;
  highestWalkReliever: number | null;
  lowestWalkReliever: number | null;
  roleUncertainty: boolean;
  notes: string | null;
  computedAt: string | null;
}

export interface BullpenArmData {
  playerId: number;
  name: string;
  throws: string;
  role: string;
  availability: BullpenArmAvailability;
  confidence: BullpenConfidence;
  d1Pitches: number | null;
  d2Pitches: number | null;
  d3Pitches: number | null;
  consecutiveDays: number;
  multiInningYesterday: boolean;
  daysSinceLastUse: number | null;
  managerOverride: BullpenArmAvailability | null;
  managerOverrideNote: string | null;
  staleBadge: boolean;
  sourceFreshness: string | null;
  computedAt: string | null;
  /** Append-only role-change event history for this arm, oldest-first. */
  roleHistory: RoleHistoryEntry[];
}

export interface BullpenUsageEntry {
  playerId: number;
  name: string;
  pitches: number;
  ip: string;
  multiInning: boolean;
}

export interface BullpenTeamData {
  teamId: number;
  abbreviation: string;
  name: string;
  slateDate: string;
  leverageMap: BullpenLeverageMap;
  arms: BullpenArmData[];
  usage: {
    d1: BullpenUsageEntry[];
    d2: BullpenUsageEntry[];
    d3: BullpenUsageEntry[];
  };
  coveragePercentage: number;
  staleBadge: boolean;
  computedAt: string | null;
}

export interface BullpenRoomData {
  date: string;
  requestedTeam: string | null;
  staleFreshnessWindowSeconds: number;
  teams: BullpenTeamData[];
  summary: {
    teamsWithData: number;
    teamsStale: number;
    totalArms: number;
    armsAvailable: number;
    armsLikelyAvailable: number;
    armsDoubtful: number;
    armsOut: number;
    armsUnknown: number;
  };
}
