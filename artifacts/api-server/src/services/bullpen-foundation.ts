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

const BULLPEN_SOURCE = "BULLPEN";
const MLB_BASE = "https://statsapi.mlb.com/api/v1";

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
): Promise<void> {
  await pool.query(
    `UPDATE ingest_runs SET finished_at = now(), status = $2, row_count = $3,
       normalized_row_count = $4, rejected_row_count = $5, duration_ms = $6, error_message = $7
     WHERE ingest_run_id = $1`,
    [ingestRunId, status, counts.rows, counts.normalized, counts.rejected,
     Date.now() - started, counts.error ?? null],
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
async function ingestActiveRosters(season: number): Promise<number> {
  let count = 0;
  try {
    const teamsRes = await fetch(`${MLB_BASE}/teams?sportId=1&season=${season}&gameType=R`);
    if (!teamsRes.ok) return 0;
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
      } catch {
        // Continue to next team on roster fetch failure
      }
    }
  } catch {
    // Return partial count on teams API failure
  }
  return count;
}

/**
 * Fetch all regular-season games on a given date.
 * Returns array of { gamePk, awayTeamId, homeTeamId, status }.
 */
async function fetchGamesForDate(date: string): Promise<Array<{ gamePk: number; awayTeamId: number; homeTeamId: number; status: string }>> {
  try {
    const url = `${MLB_BASE}/schedule?sportId=1&date=${date}&gameType=R,F,D,L,W`;
    const res = await fetch(url);
    if (!res.ok) return [];
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
  } catch {
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
        } catch {
          rejected++;
        }
      }
    }
  } catch {
    rejected++;
  }
  return { normalized, rejected };
}

/**
 * Derive heuristic availability state from D-1/D-2/D-3 pitch counts.
 * Returns state and confidence label HEURISTIC.
 */
export function computeHeuristicAvailability(data: {
  d1Pitches: number | null;
  d2Pitches: number | null;
  d3Pitches: number | null;
  multiInningYesterday: boolean;
}): "AVAILABLE" | "LIKELY_AVAILABLE" | "DOUBTFUL" | "OUT" | "UNKNOWN" {
  const { d1Pitches, d2Pitches, d3Pitches, multiInningYesterday } = data;

  // No data at all
  if (d1Pitches === null && d2Pitches === null && d3Pitches === null) return "UNKNOWN";

  const usedD1 = (d1Pitches ?? 0) > 0;
  const usedD2 = (d2Pitches ?? 0) > 0;
  const usedD3 = (d3Pitches ?? 0) > 0;

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

    const d1Pitches = d1Row?.pitch_count ?? (d1Row ? 1 : null);
    const d2Pitches = d2Row?.pitch_count ?? (d2Row ? 1 : null);
    const d3Pitches = d3Row?.pitch_count ?? (d3Row ? 1 : null);
    const multiInningYesterday = d1Row?.is_multi_inning ?? false;

    const usedD1 = (d1Pitches ?? 0) > 0;
    const usedD2 = (d2Pitches ?? 0) > 0;
    const usedD3 = (d3Pitches ?? 0) > 0;
    const consecutiveDaysUsed = usedD1 ? (usedD2 ? (usedD3 ? 3 : 2) : 1) : 0;

    // Days since last use
    let daysSinceLastUse: number | null = null;
    if (!usedD1 && !usedD2 && !usedD3) {
      const lastApp = await pool.query<{ game_date: string }>(
        `SELECT game_date FROM relief_appearance_log
         WHERE player_id = $1 AND team_id = $2 AND game_date < $3
         ORDER BY game_date DESC LIMIT 1`,
        [playerId, teamId, d1],
      );
      if (lastApp.rows[0]) {
        const lastDate = new Date(`${lastApp.rows[0].game_date}T12:00:00Z`);
        const slateD = new Date(`${slateDate}T12:00:00Z`);
        daysSinceLastUse = Math.round((slateD.getTime() - lastDate.getTime()) / 86400000);
      }
    } else {
      daysSinceLastUse = usedD1 ? 1 : usedD2 ? 2 : 3;
    }

    const heuristic = computeHeuristicAvailability({ d1Pitches, d2Pitches, d3Pitches, multiInningYesterday });

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
          final_state, confidence, source_freshness, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT (player_id, slate_date) DO UPDATE SET
         d1_pitches            = EXCLUDED.d1_pitches,
         d2_pitches            = EXCLUDED.d2_pitches,
         d3_pitches            = EXCLUDED.d3_pitches,
         consecutive_days_used = EXCLUDED.consecutive_days_used,
         multi_inning_yesterday= EXCLUDED.multi_inning_yesterday,
         days_since_last_use   = EXCLUDED.days_since_last_use,
         heuristic_availability= EXCLUDED.heuristic_availability,
         final_state           = EXCLUDED.final_state,
         confidence            = EXCLUDED.confidence,
         source_freshness      = EXCLUDED.source_freshness,
         computed_at           = now()`,
      [
        playerId, teamId, slateDate, d1Pitches, d2Pitches, d3Pitches,
        consecutiveDaysUsed, multiInningYesterday, daysSinceLastUse,
        heuristic, override, overrideNote, finalState, confidence,
        new Date().toISOString(),
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
  }>(
    `SELECT rp.player_id, rp.role, rp.throws, rp.walk_rate_percent,
            obs.final_state
     FROM reliever_profiles rp
     LEFT JOIN bullpen_availability_observations obs
       ON obs.player_id = rp.player_id AND obs.slate_date = $1
     WHERE rp.team_id = $2 AND rp.season = $3 AND rp.active_roster = true`,
    [slateDate, teamId, season],
  );

  const available = arms.rows.filter((a) =>
    a.final_state === "AVAILABLE" || a.final_state === "LIKELY_AVAILABLE" || a.final_state === null,
  );

  // Role priority ordering for high-leverage slots
  const rolePriority: Record<string, number> = {
    CLOSER: 1, PRIMARY_SETUP: 2, SETUP: 3, MIDDLE: 4,
    LEFTY_SPECIALIST: 5, SWING: 6, LONG_MAN: 7, OPENER: 8, UNKNOWN: 9,
  };

  const sorted = [...available].sort(
    (a, b) => (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9),
  );

  const closer = sorted.find((a) => a.role === "CLOSER")?.player_id ?? null;
  const setup8 = sorted.find((a) => a.role === "PRIMARY_SETUP" || (a.role === "SETUP" && !closer))?.player_id ?? null;
  const setup7 = sorted.filter((a) => a.role === "SETUP").find((a) => a.player_id !== setup8)?.player_id ?? null;
  const leftySpecialist = available.find((a) => a.role === "LEFTY_SPECIALIST" && a.throws === "L")?.player_id ?? null;
  const longMan = available.find((a) => a.role === "LONG_MAN")?.player_id ?? null;

  // Highest/lowest walk rate among available arms
  const withWalkRate = available.filter((a) => a.walk_rate_percent !== null);
  withWalkRate.sort((a, b) => (b.walk_rate_percent ?? 0) - (a.walk_rate_percent ?? 0));
  const highestWalk = withWalkRate[0]?.player_id ?? null;
  const lowestWalk = withWalkRate[withWalkRate.length - 1]?.player_id ?? null;

  const hasRoleData = arms.rows.some((a) => a.role !== "UNKNOWN");
  const roleUncertainty = !hasRoleData || sorted.length < 3;

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
      hasRoleData ? null : "Roles are UNKNOWN — no manager role data ingested for this team",
    ],
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Main ingestion entry point. Refreshes the last 3 days of game data and
 * recomputes availability observations and leverage maps for slateDate.
 */
export async function refreshBullpen(slateDate: string): Promise<{
  gamesProcessed: number;
  appearancesNormalized: number;
  appearancesRejected: number;
  teamsComputed: number;
  error?: string;
}> {
  await ensureBullpenSource();
  const started = Date.now();
  const runId = await startRun("bullpen_ingest", slateDate);

  let gamesProcessed = 0;
  let appearancesNormalized = 0;
  let appearancesRejected = 0;
  let runError: string | undefined;

  const season = Number(slateDate.slice(0, 4));

  try {
    // Step 1: Ensure all active MLB pitchers have profiles (roster coverage).
    // This runs before game-feed ingestion so arms that haven't appeared recently
    // still show up in the bullpen room with UNKNOWN state.
    await ingestActiveRosters(season);

    // Step 2: Ingest last 3 days of completed game appearances.
    for (let offset = -3; offset <= -1; offset++) {
      const date = dateOffset(slateDate, offset);
      const games = await fetchGamesForDate(date);
      for (const game of games) {
        if (!game.status.toLowerCase().includes("final")) continue;
        const { normalized, rejected } = await persistGameAppearances(
          game.gamePk, date, game.awayTeamId, game.homeTeamId,
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

    await finishRun(runId, "SUCCESS", {
      rows: gamesProcessed,
      normalized: appearancesNormalized,
      rejected: appearancesRejected,
    }, started);

    return { gamesProcessed, appearancesNormalized, appearancesRejected, teamsComputed };
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "FAILED", {
      rows: gamesProcessed,
      normalized: appearancesNormalized,
      rejected: appearancesRejected,
      error: runError,
    }, started);
    return { gamesProcessed, appearancesNormalized, appearancesRejected, teamsComputed: 0, error: runError };
  }
}

/**
 * Get the bullpen room data for the API response.
 * Returns all 30 teams (or a single team if filtered).
 */
export async function getBullpenRoom(slateDate: string, teamFilter?: string): Promise<BullpenRoomData> {
  const season = Number(slateDate.slice(0, 4));
  const freshnessThresholdMs = 24 * 60 * 60 * 1000; // 24 hours

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
