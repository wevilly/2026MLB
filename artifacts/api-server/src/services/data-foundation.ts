import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { ingestFantasyProsWeatherObservations } from "./weather-foundation";

const MLB_SOURCE = "MLB_OFFICIAL";
const FANTASY_PROS_SOURCE = "FANTASYPROS";
const MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const MLB_TEAMS_URL = "https://statsapi.mlb.com/api/v1/teams?sportId=1";
const FANTASY_PROS_BASE_URL = "https://api.fantasypros.com/public/v2/json";

type JsonObject = Record<string, unknown>;

function checksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalisedChecksum(value: unknown) {
  const normalise = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalise);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as JsonObject)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalise(child)]),
      );
    }
    return item;
  };
  return checksum(normalise(value));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}

/**
 * Normalise a handedness code to L, R, S, or null.
 *
 * Null and the empty string are not interchangeable here. players.throws and
 * players.bats feed the platoon layer, and an empty string is not null: it
 * reads as a recorded value, resolveBatterSide returns null for a switch
 * hitter, isPlatoonDisfavored returns false, and every split metric quietly
 * falls back to the unsplit season line with nothing reporting it. Park and
 * weather then sit on top of a platoon layer that is not running.
 *
 * Anything absent, blank, or not one of the three MLB codes becomes null, which
 * is a value the rest of the system can recognise as unknown.
 */
export function handednessCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const code = String(value).trim().toUpperCase();
  return code === "L" || code === "R" || code === "S" ? code : null;
}

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("date must use YYYY-MM-DD");
  }
  return value;
}

async function ensureSources() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, base_url, expected_freshness_minutes, notes)
     VALUES
       ($1, 'MLB Official', 'OFFICIAL', 'https://statsapi.mlb.com', 30, 'Official schedule, game state, starters and posted lineups.'),
       ($2, 'FantasyPros', 'PROJECTION', 'https://api.fantasypros.com', 30, 'Forward projections, projected lineups, slate weather and news. Never authoritative for official game state.')
     ON CONFLICT (source_id) DO UPDATE SET name = EXCLUDED.name, source_type = EXCLUDED.source_type,
       base_url = EXCLUDED.base_url, notes = EXCLUDED.notes`,
    [MLB_SOURCE, FANTASY_PROS_SOURCE],
  );
}

async function startRun(sourceId: string, jobName: string, effectiveDate: string) {
  const result = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date)
     VALUES ($1, $2, 'RUNNING', $3) RETURNING ingest_run_id`,
    [sourceId, jobName, effectiveDate],
  );
  return result.rows[0].ingest_run_id;
}

async function finishRun(
  ingestRunId: string,
  status: "SUCCESS" | "PARTIAL" | "FAILED",
  metrics: { rowCount: number; normalizedRowCount: number; rejectedRowCount: number; httpStatus?: number; errorMessage?: string; metadata?: JsonObject },
  startedAt: number,
) {
  await pool.query(
    `UPDATE ingest_runs
     SET finished_at = now(), status = $2, row_count = $3, normalized_row_count = $4,
         rejected_row_count = $5, http_status = $6, duration_ms = $7, error_message = $8, metadata = $9
     WHERE ingest_run_id = $1`,
    [
      ingestRunId,
      status,
      metrics.rowCount,
      metrics.normalizedRowCount,
      metrics.rejectedRowCount,
      metrics.httpStatus ?? null,
      Date.now() - startedAt,
      metrics.errorMessage ?? null,
      metrics.metadata ?? {},
    ],
  );
}

async function recordIssue(sourceId: string, ingestRunId: string, issueType: string, severity: string, detail: string) {
  await pool.query(
    `INSERT INTO ingest_issues (source_id, ingest_run_id, issue_type, severity, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [sourceId, ingestRunId, issueType, severity, detail],
  );
}

async function storeRawPayload(
  ingestRunId: string,
  sourceId: string,
  payloadType: string,
  effectiveDate: string,
  payload: unknown,
) {
  const body = JSON.stringify(payload);
  const result = await pool.query<{ raw_payload_id: string }>(
    `INSERT INTO raw_payloads (ingest_run_id, source_id, payload_type, effective_date, checksum, byte_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING raw_payload_id`,
    [ingestRunId, sourceId, payloadType, effectiveDate, checksum(payload), Buffer.byteLength(body), { payload }],
  );
  return result.rows[0].raw_payload_id;
}

async function upsertTeam(team: JsonObject) {
  const id = Number(team.id);
  if (!Number.isFinite(id)) return false;
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name, league, division)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (team_id) DO UPDATE SET abbreviation = EXCLUDED.abbreviation, name = EXCLUDED.name,
       league = EXCLUDED.league, division = EXCLUDED.division, updated_at = now()`,
    [
      id,
      String(team.abbreviation ?? team.teamCode ?? "UNK"),
      String(team.name ?? team.teamName ?? "Unknown"),
      String(asObject(team.league).name ?? ""),
      String(asObject(team.division).name ?? ""),
    ],
  );
  return true;
}

// FantasyPros supplies team abbreviations but not the MLB schedule record that
// previously created the local team rows. This fixed directory is a key map,
// not a live MLB pregame lookup: FantasyPros remains the source of the date,
// matchup, lineup, and starter state.
const FANTASY_PROS_TEAM_IDS: Record<string, number> = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, ATH: 133, OAK: 133,
  PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120,
};

function fantasyProsTeamId(abbreviation: string) {
  return FANTASY_PROS_TEAM_IDS[abbreviation.toUpperCase()] ?? null;
}

async function upsertFantasyProsTeam(abbreviation: string) {
  const teamId = fantasyProsTeamId(abbreviation);
  if (!teamId) return null;
  await pool.query(
    `INSERT INTO teams (team_id, abbreviation, name, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (team_id) DO UPDATE SET abbreviation = EXCLUDED.abbreviation,
       name = EXCLUDED.name, active = true, updated_at = now()`,
    [teamId, abbreviation, abbreviation],
  );
  return teamId;
}

function fantasyProsGameTeams(game: JsonObject) {
  const teams = Object.keys(asObject(game.teams)).filter((team) => Boolean(fantasyProsTeamId(team)));
  const explicitAway = String(game.away_team ?? game.away ?? "").toUpperCase();
  const explicitHome = String(game.home_team ?? game.home ?? "").toUpperCase();
  if (fantasyProsTeamId(explicitAway) && fantasyProsTeamId(explicitHome) && explicitAway !== explicitHome) {
    return { away: explicitAway, home: explicitHome };
  }
  // Some lineups responses only list the two clubs. Side orientation is not a
  // research signal, but a stable order lets the same-team boards render both
  // sides without asking MLB to fill in a pregame schedule.
  const [away, home] = teams.sort();
  return away && home ? { away, home } : null;
}

async function persistFantasyProsGames(
  ingestRunId: string,
  effectiveDate: string,
  payload: JsonObject,
) {
  let games = 0;
  for (const rawGame of asArray(payload.games)) {
    const game = asObject(rawGame);
    const gamePk = Number(game.game_id);
    const sides = fantasyProsGameTeams(game);
    if (!Number.isSafeInteger(gamePk) || gamePk <= 0 || !sides) {
      await recordIssue(
        FANTASY_PROS_SOURCE,
        ingestRunId,
        "FANTASYPROS_GAME_MAPPING_BLOCKING",
        "BLOCKING",
        "FantasyPros matchup has no usable game ID or two mapped team abbreviations.",
      );
      continue;
    }
    const [awayTeamId, homeTeamId] = await Promise.all([
      upsertFantasyProsTeam(sides.away),
      upsertFantasyProsTeam(sides.home),
    ]);
    if (!awayTeamId || !homeTeamId || awayTeamId === homeTeamId) continue;
    await pool.query(
      `INSERT INTO games
         (game_pk, game_date, start_time_utc, away_team_id, home_team_id, game_status, game_type, doubleheader_code)
       VALUES ($1, $2, NULL, $3, $4, $5, 'R', '')
       ON CONFLICT (game_pk) DO UPDATE SET game_date = EXCLUDED.game_date,
         away_team_id = EXCLUDED.away_team_id, home_team_id = EXCLUDED.home_team_id,
         game_status = EXCLUDED.game_status, updated_at = now()`,
      [gamePk, effectiveDate, awayTeamId, homeTeamId, String(game.status ?? "SCHEDULED")],
    );
    games += 1;
  }
  return games;
}

async function persistFantasyProsStarters(
  ingestRunId: string,
  effectiveDate: string,
  payload: JsonObject,
) {
  let starters = 0;
  for (const rawGame of asArray(payload.games)) {
    const game = asObject(rawGame);
    const gamePk = Number(game.game_id);
    if (!Number.isSafeInteger(gamePk) || gamePk <= 0) continue;
    for (const [abbreviation, rawPitcher] of Object.entries(asObject(game.pitchers))) {
      const teamId = fantasyProsTeamId(abbreviation);
      const pitcher = asObject(rawPitcher);
      const externalId = String(pitcher.player_id ?? "");
      if (!teamId || !externalId) continue;
      const identity = await pool.query<{ player_id: number }>(
        `SELECT player_id FROM player_external_ids
         WHERE source_id = $1 AND external_player_id = $2 AND valid_to IS NULL
         UNION ALL
         SELECT player_id FROM player_external_id_aliases
         WHERE source_id = $1 AND external_player_id = $2
         LIMIT 1`,
        [FANTASY_PROS_SOURCE, externalId],
      );
      const raw = { ...pitcher, fantasyProsGameId: game.game_id, team: abbreviation };
      const existing = await pool.query(
        `SELECT 1 FROM starters WHERE game_pk = $1 AND team_id = $2 AND source_id = $3
           AND raw->>'checksum' = $4 LIMIT 1`,
        [gamePk, teamId, FANTASY_PROS_SOURCE, String(checksum(raw))],
      );
      if (existing.rowCount) continue;
      await pool.query(
        `INSERT INTO starters (game_pk, team_id, player_id, starter_state, source_id, observed_at, raw)
         VALUES ($1, $2, $3, 'PROBABLE', $4, now(), $5)`,
        [gamePk, teamId, identity.rows[0]?.player_id ?? null, FANTASY_PROS_SOURCE, { ...raw, checksum: checksum(raw), effectiveDate }],
      );
      starters += 1;
    }
  }
  return starters;
}

async function upsertStarter(
  person: JsonObject,
  teamId: number,
  gamePk: number,
  state: string,
  raw: JsonObject,
  effectiveDate: string,
) {
  const playerId = Number(person.id);
  if (!Number.isFinite(playerId)) return false;
  await pool.query(
    `INSERT INTO players (player_id, full_name, primary_position)
     VALUES ($1, $2, 'P')
     ON CONFLICT (player_id) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = now()`,
    [playerId, String(person.fullName ?? person.name ?? "Unknown pitcher")],
  );
  await upsertEligibility({
    playerId,
    sourceId: MLB_SOURCE,
    externalPlayerId: String(playerId),
    sourceDisplayName: String(person.fullName ?? person.name ?? "Unknown pitcher"),
    status: "MLB_ACTIVE",
    effectiveDate,
    currentTeamId: teamId,
    sourceTeamAbbreviation: null,
    evidence: { officialStarter: true, gamePk, starterState: state },
    confidence: "CONFIRMED",
    requiresIdentityReview: false,
    quarantineReason: null,
  });
  const observedRaw = { ...raw, checksum: checksum(raw) };
  const existing = await pool.query(
    `SELECT 1 FROM starters WHERE game_pk = $1 AND team_id = $2 AND player_id = $3
      AND starter_state = $4 AND source_id = $5 AND raw->>'checksum' = $6 LIMIT 1`,
    [gamePk, teamId, playerId, state, MLB_SOURCE, String(observedRaw.checksum)],
  );
  if (!existing.rowCount) {
    await pool.query(
      `INSERT INTO starters (game_pk, team_id, player_id, starter_state, source_id, observed_at, raw)
       VALUES ($1, $2, $3, $4, $5, now(), $6)`,
      [gamePk, teamId, playerId, state, MLB_SOURCE, observedRaw],
    );
  }
  return true;
}

function asNumbers(value: unknown) {
  return Array.isArray(value)
    ? value.map(Number).filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0)
    : [];
}

function normaliseName(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

type EligibilityStatus =
  | "MLB_ACTIVE" | "MLB_40_MAN" | "MLB_IL" | "MLB_OPTIONED" | "MINOR_LEAGUE"
  | "FREE_AGENT" | "HISTORICAL" | "RETIRED" | "UNKNOWN";

function officialEligibilityStatus(statusDescription: string, rosterType: string): EligibilityStatus {
  const value = statusDescription.toLowerCase();
  if (/\b(il|injured list|injured)\b/.test(value)) return "MLB_IL";
  if (/option/.test(value)) return "MLB_OPTIONED";
  if (/minor/.test(value)) return "MINOR_LEAGUE";
  if (rosterType === "active" || value === "active") return "MLB_ACTIVE";
  if (rosterType === "40Man") return "MLB_40_MAN";
  return "UNKNOWN";
}

function eligibilityFlags(status: EligibilityStatus, requiresIdentityReview: boolean) {
  const activeSeason = ["MLB_ACTIVE", "MLB_40_MAN", "MLB_IL"].includes(status);
  return {
    eligibleTodayResearch: activeSeason && !requiresIdentityReview,
    eligibleLineupProjection: ["MLB_ACTIVE", "MLB_IL"].includes(status) && !requiresIdentityReview,
    eligiblePitcherResearch: activeSeason && !requiresIdentityReview,
    quarantined: !activeSeason || requiresIdentityReview,
  };
}

async function upsertEligibility(input: {
  playerId: number | null;
  sourceId: string;
  externalPlayerId: string;
  sourceDisplayName: string | null;
  status: EligibilityStatus;
  effectiveDate: string;
  currentTeamId: number | null;
  sourceTeamAbbreviation: string | null;
  evidence: JsonObject;
  confidence: "CONFIRMED" | "HIGH_CONFIDENCE" | "REVIEW_REQUIRED";
  requiresIdentityReview: boolean;
  quarantineReason: string | null;
}) {
  const flags = eligibilityFlags(input.status, input.requiresIdentityReview);
  await pool.query(
    `INSERT INTO player_eligibility (
       player_id, source_id, external_player_id, source_display_name, status, effective_date,
       current_team_id, source_team_abbreviation, observed_at, evidence, confidence,
       eligible_today_research, eligible_lineup_projection, eligible_pitcher_research,
       requires_identity_review, quarantined_from_current_research, quarantine_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (source_id, external_player_id, effective_date) DO UPDATE SET
       player_id = EXCLUDED.player_id, source_display_name = EXCLUDED.source_display_name,
       status = EXCLUDED.status, current_team_id = EXCLUDED.current_team_id,
       source_team_abbreviation = EXCLUDED.source_team_abbreviation, observed_at = EXCLUDED.observed_at,
       evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence,
       eligible_today_research = EXCLUDED.eligible_today_research,
       eligible_lineup_projection = EXCLUDED.eligible_lineup_projection,
       eligible_pitcher_research = EXCLUDED.eligible_pitcher_research,
       requires_identity_review = EXCLUDED.requires_identity_review,
       quarantined_from_current_research = EXCLUDED.quarantined_from_current_research,
       quarantine_reason = EXCLUDED.quarantine_reason`,
    [
      input.playerId, input.sourceId, input.externalPlayerId, input.sourceDisplayName, input.status,
      input.effectiveDate, input.currentTeamId, input.sourceTeamAbbreviation, input.evidence,
      input.confidence, flags.eligibleTodayResearch, flags.eligibleLineupProjection,
      flags.eligiblePitcherResearch, input.requiresIdentityReview, flags.quarantined,
      flags.quarantined ? input.quarantineReason ?? "not_current_research_eligible" : null,
    ],
  );
  return flags;
}

async function officialEligibilityForPlayer(playerId: number, effectiveDate: string) {
  const result = await pool.query<{
    status: EligibilityStatus;
    current_team_id: number | null;
    abbreviation: string | null;
  }>(
    `SELECT pe.status, pe.current_team_id, t.abbreviation
     FROM player_eligibility pe
     LEFT JOIN teams t ON t.team_id = pe.current_team_id
     WHERE pe.source_id = $1 AND pe.player_id = $2 AND pe.effective_date = $3
     ORDER BY CASE pe.status WHEN 'MLB_ACTIVE' THEN 1 WHEN 'MLB_IL' THEN 2 WHEN 'MLB_40_MAN' THEN 3 ELSE 4 END,
       pe.observed_at DESC
     LIMIT 1`,
    [MLB_SOURCE, playerId, effectiveDate],
  );
  return result.rows[0] ?? null;
}

async function officialPersonFallback(playerId: number, effectiveDate: string) {
  const response = await fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}`);
  const payload = await response.json() as JsonObject;
  if (!response.ok) return null;
  const person = asArray(payload.people)[0];
  if (!person) return null;
  const active = person.active === true;
  const currentTeamId = Number(asObject(person.currentTeam).id);
  // The people endpoint can confirm that an inactive player is retired, but
  // `active` and `currentTeam` do not prove same-date MLB roster membership.
  const status: EligibilityStatus = active ? "UNKNOWN" : "RETIRED";
  await upsertEligibility({
    playerId,
    sourceId: MLB_SOURCE,
    externalPlayerId: String(playerId),
    sourceDisplayName: String(person.fullName ?? person.name ?? playerId),
    status,
    effectiveDate,
    currentTeamId: Number.isSafeInteger(currentTeamId) && currentTeamId > 0 ? currentTeamId : null,
    sourceTeamAbbreviation: null,
    evidence: { officialPerson: true, active, currentTeam: asObject(person.currentTeam) },
    confidence: "CONFIRMED",
    requiresIdentityReview: status === "UNKNOWN",
    quarantineReason: status === "RETIRED" ? "official_person_inactive" : "no_same_date_official_roster_observation",
  });
  return officialEligibilityForPlayer(playerId, effectiveDate);
}

async function projectionEligibility(
  effectiveDate: string,
  sourcePlayerId: string,
  rawName: string,
  sourceTeamAbbreviation: string,
  playerId: number | null,
  confidence: "CONFIRMED" | "HIGH_CONFIDENCE" | "REVIEW_REQUIRED",
) {
  const teamId = await upsertFantasyProsTeam(sourceTeamAbbreviation);
  const status: EligibilityStatus = playerId && teamId ? "MLB_ACTIVE" : "UNKNOWN";
  const requiresIdentityReview = !playerId;
  const reason = !playerId
    ? "missing_fantasypros_to_mlbam_identity_bridge"
    : !teamId
      ? "unmapped_fantasypros_team"
      : null;
  const flags = await upsertEligibility({
    playerId,
    sourceId: FANTASY_PROS_SOURCE,
    externalPlayerId: sourcePlayerId,
    sourceDisplayName: rawName,
    status,
    effectiveDate,
    currentTeamId: teamId,
    sourceTeamAbbreviation,
    evidence: {
      fantasyProsProjection: true,
      sourceTeam: sourceTeamAbbreviation,
      identityBridge: playerId ? "mlbam" : null,
    },
    confidence,
    requiresIdentityReview,
    quarantineReason: reason,
  });
  return { ...flags, officialTeam: sourceTeamAbbreviation || null, status, requiresIdentityReview };
}

function projectionComponents(row: JsonObject) {
  const keys = ["pa", "ab", "hits", "1b", "2b", "3b", "hrs", "bb"] as const;
  return Object.fromEntries(keys.flatMap((key) => {
    const value = row[key];
    return typeof value === "number" ? [[key, value]] : [];
  }));
}

async function upsertOfficialPlayer(entry: JsonObject, teamId: number, effectiveDate: string, rosterType = "game_feed") {
  const person = asObject(entry.person);
  const playerId = Number(person.id);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return null;
  const position = asObject(entry.position);
  const batSide = asObject(person.batSide);
  const pitchHand = asObject(person.pitchHand);
  await pool.query(
    `INSERT INTO players (player_id, full_name, first_name, last_name, bats, throws, primary_position, birth_date, current_team_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (player_id) DO UPDATE SET full_name = EXCLUDED.full_name, first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       -- Handedness is preserved when this payload does not carry it. The
       -- conflict clause used to be unconditional, so any call whose person
       -- object lacked batSide or pitchHand destroyed a known value. Same guard
       -- as reliever_profiles.throws in bullpen-foundation.
       bats = CASE
         WHEN EXCLUDED.bats IS NOT NULL AND EXCLUDED.bats <> '' THEN EXCLUDED.bats
         ELSE players.bats
       END,
       throws = CASE
         WHEN EXCLUDED.throws IS NOT NULL AND EXCLUDED.throws <> '' THEN EXCLUDED.throws
         ELSE players.throws
       END,
       primary_position = EXCLUDED.primary_position, current_team_id = EXCLUDED.current_team_id, updated_at = now()`,
    [
      playerId,
      String(person.fullName ?? "Unknown player"),
      String(person.firstName ?? ""),
      String(person.lastName ?? ""),
      // NULL, not an empty string. An empty string is not null: it reads as a
      // known handedness downstream and resolves a switch hitter to no side at
      // all, silently. Unknown has to stay distinguishable.
      handednessCode(batSide.code),
      handednessCode(pitchHand.code),
      String(position.abbreviation ?? ""),
      person.birthDate ? String(person.birthDate) : null,
      teamId,
    ],
  );
  await pool.query(
    `INSERT INTO rosters (team_id, player_id, roster_date, status, position, source_id, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (team_id, player_id, roster_date, source_id) DO UPDATE SET status = EXCLUDED.status, position = EXCLUDED.position, observed_at = EXCLUDED.observed_at`,
    [
      teamId,
      playerId,
      effectiveDate,
      String(asObject(entry.status).description ?? ""),
      String(position.abbreviation ?? ""),
      MLB_SOURCE,
    ],
  );
  if (rosterType !== "game_feed") {
    const statusDescription = String(asObject(entry.status).description ?? "");
    await upsertEligibility({
      playerId,
      sourceId: MLB_SOURCE,
      externalPlayerId: String(playerId),
      sourceDisplayName: String(person.fullName ?? "Unknown player"),
      status: officialEligibilityStatus(statusDescription, rosterType),
      effectiveDate,
      currentTeamId: teamId,
      sourceTeamAbbreviation: null,
      evidence: { rosterType, rosterStatus: statusDescription },
      confidence: "CONFIRMED",
      requiresIdentityReview: false,
      quarantineReason: null,
    });
  }
  return playerId;
}

async function persistOfficialTeamRoster(
  ingestRunId: string,
  effectiveDate: string,
  teamId: number,
  rosterType: "active" | "40Man",
) {
  const response = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=${rosterType}`);
  const payload = await response.json() as JsonObject;
  if (!response.ok) throw new Error(`MLB ${rosterType} roster for team ${teamId} returned HTTP ${response.status}`);
  await storeRawPayload(ingestRunId, MLB_SOURCE, `roster_${rosterType}`, effectiveDate, payload);
  let normalized = 0;
  for (const entry of asArray(payload.roster)) {
    if (await upsertOfficialPlayer(entry, teamId, effectiveDate, rosterType)) normalized += 1;
  }
  return normalized;
}

async function persistOfficialGameFeed(
  ingestRunId: string,
  effectiveDate: string,
  officialGamePk: number,
  // The slate's canonical game row (a FantasyPros game ID when the projected
  // slate established the row). The live feed is fetched by the official MLB
  // gamePk, but every dependent row — lineups, starters, settlement outcomes —
  // must be written under the slate key or settlement and training can never
  // join them back to the board candidates.
  gamePk: number,
  awayTeamId: number,
  homeTeamId: number,
) {
  const response = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${officialGamePk}/feed/live`);
  const payload = await response.json() as JsonObject;
  if (!response.ok) throw new Error(`MLB game feed ${officialGamePk} returned HTTP ${response.status}`);
  await storeRawPayload(ingestRunId, MLB_SOURCE, "game_feed", effectiveDate, payload);
  const boxscoreTeams = asObject(asObject(asObject(payload.liveData).boxscore).teams);
  const gameStatus = String(asObject(asObject(payload.gameData).status).detailedState ?? "");
  let normalized = 0;
  for (const [side, teamId] of [["away", awayTeamId], ["home", homeTeamId]] as const) {
    const teamBox = asObject(boxscoreTeams[side]);
    const entries = asObject(teamBox.players);
    for (const entry of Object.values(entries)) {
        await upsertOfficialPlayer(asObject(entry), teamId, effectiveDate);
    }
    const battingOrder = asNumbers(teamBox.battingOrder);
    if (battingOrder.length) {
      const lineupRaw = { checksum: checksum({ gamePk, side, battingOrder, gameStatus }), owner: MLB_SOURCE, gameStatus };
      const existing = await pool.query<{ lineup_snapshot_id: string }>(
        `SELECT lineup_snapshot_id FROM lineup_snapshots
         WHERE game_pk = $1 AND team_id = $2 AND state = 'POSTED' AND source_id = $3
           AND raw->>'checksum' = $4 LIMIT 1`,
        [gamePk, teamId, MLB_SOURCE, String(lineupRaw.checksum)],
      );
      const snapshotId = existing.rows[0]?.lineup_snapshot_id ?? (await pool.query<{ lineup_snapshot_id: string }>(
        `INSERT INTO lineup_snapshots (game_pk, team_id, state, source_id, observed_at, raw)
         VALUES ($1, $2, 'POSTED', $3, now(), $4) RETURNING lineup_snapshot_id`,
        [gamePk, teamId, MLB_SOURCE, lineupRaw],
      )).rows[0]?.lineup_snapshot_id;
      if (snapshotId && !existing.rowCount) {
        for (const [index, playerId] of battingOrder.entries()) {
          const entry = asObject(entries[`ID${playerId}`]);
          await pool.query(
            `INSERT INTO lineup_entries (lineup_snapshot_id, batting_order, player_id, position)
             VALUES ($1, $2, $3, $4)`,
            [snapshotId, index + 1, playerId, String(asObject(entry.position).abbreviation ?? "")],
          );
        }
      }
    }
    for (const entry of Object.values(entries)) {
      const player = asObject(entry);
      const pitching = asObject(asObject(player.stats).pitching);
      if (Number(pitching.gamesStarted) > 0) {
        await upsertStarter(asObject(player.person), teamId, gamePk, "CONFIRMED", player, effectiveDate);
      }
    }
    if (gameStatus === "Final") {
      for (const playerId of battingOrder) {
        const entry = asObject(entries[`ID${playerId}`]);
        const batting = asObject(asObject(entry.stats).batting);
        const doubles = Number(batting.doubles) || 0;
        const triples = Number(batting.triples) || 0;
        const homeRuns = Number(batting.homeRuns) || 0;
        const hits = Number(batting.hits) || 0;
        await pool.query(
          `INSERT INTO market_settlement_outcomes (game_pk, player_id, singles, doubles, triples, home_runs, total_bases, walks, source_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (game_pk, player_id) DO UPDATE SET singles = EXCLUDED.singles, doubles = EXCLUDED.doubles,
             triples = EXCLUDED.triples, home_runs = EXCLUDED.home_runs, total_bases = EXCLUDED.total_bases,
             walks = EXCLUDED.walks, observed_at = now()`,
          [
            gamePk,
            playerId,
            Math.max(0, hits - doubles - triples - homeRuns),
            doubles,
            triples,
            homeRuns,
            Number(batting.totalBases) || 0,
            Number(batting.baseOnBalls) || 0,
            MLB_SOURCE,
          ],
        );
      }
    }
    normalized += 1;
  }
  return normalized;
}

async function persistFantasyProsLineups(
  ingestRunId: string,
  effectiveDate: string,
  payload: JsonObject,
  state: "PROJECTED" | "CONFIRMED",
) {
  let snapshots = 0;
  let unresolvedEntries = 0;
  for (const game of asArray(payload.games)) {
    const gamePayload = asObject(game);
    const gamePk = Number(gamePayload.game_id);
    const hitters = asObject(game.hitters);
    for (const [abbreviation, lineup] of Object.entries(hitters)) {
      const target = await pool.query<{ game_pk: number; team_id: number }>(
        `SELECT g.game_pk, t.team_id
         FROM games g JOIN teams t ON t.team_id IN (g.away_team_id, g.home_team_id)
         WHERE g.game_pk = $1 AND g.game_date = $2 AND t.abbreviation = $3 LIMIT 1`,
        [gamePk, effectiveDate, abbreviation],
      );
      const gameTarget = target.rows[0];
      if (!gameTarget) {
        await recordIssue(FANTASY_PROS_SOURCE, ingestRunId, "FANTASYPROS_GAME_MAPPING_BLOCKING", "BLOCKING", `FantasyPros lineup team ${abbreviation} could not map to its FantasyPros game ID ${String(gamePayload.game_id ?? "unknown")}.`);
        continue;
      }
      const lineupRows = Object.entries(asObject(lineup))
        .map(([order, value]) => ({ order: Number(order), value: asObject(value) }))
        .filter((item) => Number.isInteger(item.order) && item.order >= 1 && item.order <= 9)
        .sort((a, b) => a.order - b.order);
      const lineupRaw = {
        checksum: checksum({ gameId: gamePayload.game_id, abbreviation, lineupRows }),
        owner: FANTASY_PROS_SOURCE,
        state,
        entries: lineupRows.map((row) => ({ order: row.order, playerId: String(row.value.player_id ?? ""), position: String(row.value.position ?? "") })),
      };
      const existing = await pool.query<{ lineup_snapshot_id: string }>(
        `SELECT lineup_snapshot_id FROM lineup_snapshots
         WHERE game_pk = $1 AND team_id = $2 AND state = $3 AND source_id = $4
           AND raw->>'checksum' = $5 LIMIT 1`,
        [gameTarget.game_pk, gameTarget.team_id, state, FANTASY_PROS_SOURCE, String(lineupRaw.checksum)],
      );
      if (existing.rowCount) continue;
      const snapshot = await pool.query<{ lineup_snapshot_id: string }>(
        `INSERT INTO lineup_snapshots (game_pk, team_id, state, source_id, observed_at, raw)
         VALUES ($1, $2, $3, $4, now(), $5) RETURNING lineup_snapshot_id`,
        [gameTarget.game_pk, gameTarget.team_id, state, FANTASY_PROS_SOURCE, lineupRaw],
      );
      for (const row of lineupRows) {
        const externalId = String(row.value.player_id ?? "");
        const identity = await pool.query<{ player_id: number; eligible_lineup_projection: boolean; requires_identity_review: boolean }>(
          `SELECT mapped.player_id, COALESCE(pe.eligible_lineup_projection, false) AS eligible_lineup_projection,
             COALESCE(pe.requires_identity_review, true) AS requires_identity_review
           FROM (
             SELECT player_id FROM player_external_ids WHERE source_id = $1 AND external_player_id = $2 AND valid_to IS NULL
             UNION ALL
             SELECT player_id FROM player_external_id_aliases WHERE source_id = $1 AND external_player_id = $2
           ) mapped
           LEFT JOIN player_eligibility pe ON pe.source_id = $1 AND pe.external_player_id = $2 AND pe.effective_date = $3
           LIMIT 1`,
          [FANTASY_PROS_SOURCE, externalId, effectiveDate],
        );
        if (!identity.rowCount || !identity.rows[0].eligible_lineup_projection || identity.rows[0].requires_identity_review) {
          unresolvedEntries += 1;
          await pool.query(
            `INSERT INTO identity_review_queue (source_id, external_player_id, raw_name, normalized_name, evidence)
             SELECT $1, $2, $3, $4, $5
             WHERE NOT EXISTS (
               SELECT 1 FROM identity_review_queue WHERE source_id = $1 AND external_player_id = $2 AND state = 'OPEN'
             )`,
            [
              FANTASY_PROS_SOURCE, externalId, `FantasyPros ${state.toLowerCase()} lineup ID ${externalId}`, normaliseName(externalId),
              { fantasyProsLineup: true, lineupState: state, gamePk: gameTarget.game_pk, team: abbreviation, reason: "identity_or_current_roster_not_confirmed" },
            ],
          );
          await recordIssue(
            FANTASY_PROS_SOURCE,
            ingestRunId,
            "PROJECTED_LINEUP_IDENTITY_BLOCKING",
            "BLOCKING",
            `FantasyPros ${state.toLowerCase()} lineup player ${externalId} is not a resolved current MLB player and is blocked from research.`,
          );
          continue;
        }
        await pool.query(
          `INSERT INTO lineup_entries (lineup_snapshot_id, batting_order, player_id, position)
           VALUES ($1, $2, $3, $4)`,
          [snapshot.rows[0].lineup_snapshot_id, row.order, identity.rows[0].player_id, String(row.value.position ?? "")],
        );
      }
      snapshots += 1;
    }
  }
  return { snapshots, unresolvedEntries };
}

/**
 * Removes a stray official-schedule game row that duplicates a projected-slate
 * row (same date and team pair under a different game_pk). Only the probable
 * starters this refresh itself wrote are deleted alongside it; any other
 * dependent row (lineups, weather, research, board state) makes the delete
 * fail its foreign keys and the row is left alone and reported instead.
 */
async function removeDuplicateOfficialGame(gamePk: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM starters WHERE game_pk = $1`, [gamePk]);
    await client.query(`DELETE FROM games WHERE game_pk = $1`, [gamePk]);
    await client.query("COMMIT");
    return true;
  } catch {
    await client.query("ROLLBACK");
    return false;
  } finally {
    client.release();
  }
}

/**
 * Schedule-metadata-only official refresh, safe to run pregame on the current
 * slate date. It deliberately ingests NO lineups, NO rosters and NO settlement
 * facts, so the postgame-only policy on the full ingestMlbOfficial path is
 * preserved.
 *
 * The projected slate's game rows use FantasyPros game IDs as game_pk, so the
 * official gamePk can never hit them via ON CONFLICT. Each official game is
 * therefore matched to the existing slate row by date and (unordered) team
 * pair and UPDATED in place — venue, start time, status, doubleheader code —
 * which is what actually re-enables venue weather. Inserting a parallel row
 * under the official gamePk would double every game on the slate. A previous
 * run's parallel rows are self-healed here when they carry no other evidence.
 * Same-team doubleheaders get their shared venue but no guessed per-game start
 * time or starters; the ambiguity is recorded as an issue instead.
 */
export async function refreshMlbSchedule(requestedDate: string) {
  const effectiveDate = parseDate(requestedDate);
  const startedAt = Date.now();
  await ensureSources();
  const ingestRunId = await startRun(MLB_SOURCE, "mlb-official-schedule-pregame", effectiveDate);
  try {
    const url = new URL(MLB_SCHEDULE_URL);
    url.searchParams.set("sportId", "1");
    url.searchParams.set("date", effectiveDate);
    url.searchParams.set("hydrate", "team,venue,probablePitcher");
    const response = await fetch(url);
    const payload = await response.json() as JsonObject;
    if (!response.ok) throw new Error(`MLB Stats API returned HTTP ${response.status}`);
    await storeRawPayload(ingestRunId, MLB_SOURCE, "schedule", effectiveDate, payload);
    const games = asArray(payload.dates).flatMap((day) => asArray(day.games));
    let normalized = 0;
    let rejected = 0;
    let unmatchedOfficialGames = 0;
    let duplicateRowsRemoved = 0;
    for (const game of games) {
      const officialGamePk = Number(game.gamePk);
      const teams = asObject(game.teams);
      const away = asObject(asObject(teams.away).team);
      const home = asObject(asObject(teams.home).team);
      const venue = asObject(game.venue);
      const awayId = Number(away.id);
      const homeId = Number(home.id);
      if (!Number.isFinite(officialGamePk) || !Number.isFinite(awayId) || !Number.isFinite(homeId)) {
        rejected += 1;
        continue;
      }
      await upsertTeam(away);
      await upsertTeam(home);
      const venueId = Number.isFinite(Number(venue.id)) ? Number(venue.id) : null;
      if (venueId !== null) {
        await pool.query(
          `INSERT INTO venues (venue_id, name, metadata) VALUES ($1, $2, $3)
           ON CONFLICT (venue_id) DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata`,
          [venueId, String(venue.name ?? "Unknown venue"), venue],
        );
      }
      const startTimeUtc = game.gameDate ? new Date(String(game.gameDate)).toISOString() : null;
      const gameStatus = String(asObject(game.status).detailedState ?? "UNKNOWN");
      const doubleheaderCode = String(game.doubleHeader ?? "");

      const pairRows = await pool.query<{ game_pk: string }>(
        `SELECT game_pk::text AS game_pk FROM games
          WHERE game_date = $1
            AND ((away_team_id = $2 AND home_team_id = $3) OR (away_team_id = $3 AND home_team_id = $2))
          ORDER BY game_pk`,
        [effectiveDate, awayId, homeId],
      );
      const slateGamePks = pairRows.rows
        .map((row) => Number(row.game_pk))
        .filter((gamePk) => gamePk !== officialGamePk);
      const strayOfficialRow = pairRows.rows.some((row) => Number(row.game_pk) === officialGamePk);

      if (slateGamePks.length === 0) {
        // No projected-slate row yet for this matchup: nothing safe to update.
        // The refresh does not insert a parallel official row — that is how the
        // slate ends up with two rows per game. Re-run after the FantasyPros
        // ingest has established the slate.
        unmatchedOfficialGames += 1;
        await recordIssue(
          MLB_SOURCE,
          ingestRunId,
          "OFFICIAL_SCHEDULE_UNMATCHED_GAME",
          "WARNING",
          `Official game ${officialGamePk} (${awayId} at ${homeId}) has no projected-slate row on ${effectiveDate}; run the FantasyPros ingest first, then re-run this refresh.`,
        );
        continue;
      }

      if (slateGamePks.length === 1) {
        const slateGamePk = slateGamePks[0];
        await pool.query(
          `UPDATE games SET
             venue_id = COALESCE($2, venue_id),
             start_time_utc = COALESCE($3, start_time_utc),
             game_status = $4,
             doubleheader_code = $5,
             away_team_id = $6,
             home_team_id = $7,
             updated_at = now()
           WHERE game_pk = $1`,
          // The official schedule is authoritative for away/home orientation:
          // the FantasyPros ingest sorts the clubs alphabetically when its
          // payload does not state sides, which reverses roughly half the
          // matchups (e.g. DET @ TB instead of TB @ DET).
          [slateGamePk, venueId, startTimeUtc, gameStatus, doubleheaderCode, awayId, homeId],
        );
        const awayProbable = asObject(asObject(teams.away).probablePitcher);
        const homeProbable = asObject(asObject(teams.home).probablePitcher);
        if (Object.keys(awayProbable).length) await upsertStarter(awayProbable, awayId, slateGamePk, "PROBABLE", awayProbable, effectiveDate);
        if (Object.keys(homeProbable).length) await upsertStarter(homeProbable, homeId, slateGamePk, "PROBABLE", homeProbable, effectiveDate);
        normalized += 1;
      } else {
        // Same-team doubleheader: the venue and official away/home orientation
        // are shared and safe to set on both rows. A per-game start time or
        // starter assignment would be a guess, so it is recorded as an
        // unresolved issue instead of assigned.
        await pool.query(
          `UPDATE games SET
             venue_id = COALESCE($2, venue_id),
             away_team_id = $3,
             home_team_id = $4,
             updated_at = now()
           WHERE game_pk = ANY($1)`,
          [slateGamePks, venueId, awayId, homeId],
        );
        await recordIssue(
          MLB_SOURCE,
          ingestRunId,
          "DOUBLEHEADER_START_TIME_UNRESOLVED",
          "WARNING",
          `Official game ${officialGamePk} is one of ${slateGamePks.length} slate rows for the same team pair on ${effectiveDate}; venue was set on all, start times and starters were not guessed.`,
        );
        normalized += 1;
      }

      if (strayOfficialRow) {
        if (await removeDuplicateOfficialGame(officialGamePk)) duplicateRowsRemoved += 1;
        else {
          await recordIssue(
            MLB_SOURCE,
            ingestRunId,
            "DUPLICATE_OFFICIAL_GAME_ROW",
            "WARNING",
            `Official game row ${officialGamePk} duplicates a projected-slate row but carries dependent evidence and was not removed.`,
          );
        }
      }
    }
    await finishRun(ingestRunId, rejected ? "PARTIAL" : "SUCCESS", {
      rowCount: games.length,
      normalizedRowCount: normalized,
      rejectedRowCount: rejected,
      httpStatus: response.status,
      metadata: { endpoint: url.toString(), scheduleOnly: true, unmatchedOfficialGames, duplicateRowsRemoved },
    }, startedAt);
    return {
      source: "MLB Official (schedule only)",
      ingestRunId,
      rowCount: games.length,
      normalizedRowCount: normalized,
      rejectedRowCount: rejected,
      unmatchedOfficialGames,
      duplicateRowsRemoved,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown MLB schedule failure";
    await recordIssue(MLB_SOURCE, ingestRunId, "SOURCE_FAILURE", "BLOCKING", detail);
    await finishRun(ingestRunId, "FAILED", { rowCount: 0, normalizedRowCount: 0, rejectedRowCount: 0, errorMessage: detail }, startedAt);
    throw error;
  }
}

export async function ingestMlbOfficial(requestedDate: string) {
  const effectiveDate = parseDate(requestedDate);
  const startedAt = Date.now();
  await ensureSources();
  const ingestRunId = await startRun(MLB_SOURCE, "mlb-official-schedule", effectiveDate);
  try {
    const url = new URL(MLB_SCHEDULE_URL);
    url.searchParams.set("sportId", "1");
    url.searchParams.set("date", effectiveDate);
    url.searchParams.set("hydrate", "team,venue,probablePitcher");
    const response = await fetch(url);
    const payload = await response.json() as JsonObject;
    if (!response.ok) throw new Error(`MLB Stats API returned HTTP ${response.status}`);
    await storeRawPayload(ingestRunId, MLB_SOURCE, "schedule", effectiveDate, payload);
    const dates = asArray(payload.dates);
    const games = dates.flatMap((day) => asArray(day.games));
    let normalized = 0;
    let rejected = 0;
    const rosterTeams = new Set<number>();
    try {
      const teamsResponse = await fetch(MLB_TEAMS_URL);
      const teamsPayload = await teamsResponse.json() as JsonObject;
      if (!teamsResponse.ok) throw new Error(`MLB teams endpoint returned HTTP ${teamsResponse.status}`);
      await storeRawPayload(ingestRunId, MLB_SOURCE, "teams", effectiveDate, teamsPayload);
      for (const team of asArray(teamsPayload.teams)) {
        const teamId = Number(team.id);
        if (!Number.isSafeInteger(teamId) || teamId <= 0) continue;
        await upsertTeam(team);
        rosterTeams.add(teamId);
        normalized += await persistOfficialTeamRoster(ingestRunId, effectiveDate, teamId, "40Man");
        normalized += await persistOfficialTeamRoster(ingestRunId, effectiveDate, teamId, "active");
      }
    } catch (error) {
      rejected += 1;
      const detail = error instanceof Error ? error.message : "Unknown official organization roster error";
      await recordIssue(MLB_SOURCE, ingestRunId, "ROSTER_NORMALIZATION_FAILURE", "WARNING", detail);
    }
    for (const game of games) {
      const gamePk = Number(game.gamePk);
      const teams = asObject(game.teams);
      const away = asObject(asObject(teams.away).team);
      const home = asObject(asObject(teams.home).team);
      const venue = asObject(game.venue);
      const awayId = Number(away.id);
      const homeId = Number(home.id);
      if (!Number.isFinite(gamePk) || !Number.isFinite(awayId) || !Number.isFinite(homeId)) {
        rejected += 1;
        continue;
      }
      await upsertTeam(away);
      await upsertTeam(home);
      for (const teamId of [awayId, homeId]) {
        if (rosterTeams.has(teamId)) continue;
        rosterTeams.add(teamId);
        try {
          normalized += await persistOfficialTeamRoster(ingestRunId, effectiveDate, teamId, "40Man");
          normalized += await persistOfficialTeamRoster(ingestRunId, effectiveDate, teamId, "active");
        } catch (error) {
          rejected += 1;
          const detail = error instanceof Error ? error.message : "Unknown official roster error";
          await recordIssue(MLB_SOURCE, ingestRunId, "ROSTER_NORMALIZATION_FAILURE", "WARNING", detail);
        }
      }
      if (Number.isFinite(Number(venue.id))) {
        await pool.query(
          `INSERT INTO venues (venue_id, name, metadata) VALUES ($1, $2, $3)
           ON CONFLICT (venue_id) DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata`,
          [Number(venue.id), String(venue.name ?? "Unknown venue"), venue],
        );
      }
      // The projected slate's game rows use FantasyPros game IDs as game_pk,
      // so the official gamePk never hits them via ON CONFLICT. Inserting the
      // official row unconditionally created a parallel game universe postgame:
      // the FantasyPros rows never reached a terminal status, the official rows
      // carried the settlement facts, settlementIsComplete counted a doubled
      // slate that could never settle, and model training found no official
      // settled rows that joined back to the board candidates. Match each
      // official game to the slate row by date and unordered team pair — the
      // same policy as refreshMlbSchedule — and write everything under it.
      const pairRows = await pool.query<{ game_pk: string }>(
        `SELECT game_pk::text AS game_pk FROM games
          WHERE game_date = $1
            AND ((away_team_id = $2 AND home_team_id = $3) OR (away_team_id = $3 AND home_team_id = $2))
          ORDER BY game_pk`,
        [effectiveDate, awayId, homeId],
      );
      const slateGamePks = pairRows.rows
        .map((row) => Number(row.game_pk))
        .filter((slatePk) => slatePk !== gamePk);
      const officialRowExists = pairRows.rows.some((row) => Number(row.game_pk) === gamePk);
      let writeGamePk = gamePk;
      if (slateGamePks.length === 1 && !officialRowExists) {
        writeGamePk = slateGamePks[0];
        await pool.query(
          `UPDATE games SET
             start_time_utc = COALESCE($2, start_time_utc),
             venue_id = COALESCE($3, venue_id),
             game_status = $4,
             game_type = $5,
             doubleheader_code = $6,
             away_team_id = $7,
             home_team_id = $8,
             updated_at = now()
           WHERE game_pk = $1`,
          [
            writeGamePk,
            game.gameDate ? new Date(String(game.gameDate)).toISOString() : null,
            Number.isFinite(Number(venue.id)) ? Number(venue.id) : null,
            String(asObject(game.status).detailedState ?? "UNKNOWN"),
            String(game.gameType ?? ""),
            String(game.doubleHeader ?? ""),
            awayId,
            homeId,
          ],
        );
      } else {
        if (slateGamePks.length > 1) {
          // Same-team doubleheader: mapping one official game onto one of two
          // slate rows would be a guess. Keep the official row and disclose.
          await recordIssue(
            MLB_SOURCE,
            ingestRunId,
            "DOUBLEHEADER_SETTLEMENT_UNMATCHED",
            "WARNING",
            `Official game ${gamePk} matches ${slateGamePks.length} slate rows for the same team pair on ${effectiveDate}; settlement facts stay under the official gamePk.`,
          );
        }
        await pool.query(
          `INSERT INTO games (game_pk, game_date, start_time_utc, away_team_id, home_team_id, venue_id, game_status, game_type, doubleheader_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (game_pk) DO UPDATE SET
             start_time_utc = COALESCE(EXCLUDED.start_time_utc, games.start_time_utc),
             venue_id = COALESCE(EXCLUDED.venue_id, games.venue_id),
             game_status = EXCLUDED.game_status,
             game_type = EXCLUDED.game_type, doubleheader_code = EXCLUDED.doubleheader_code, updated_at = now()`,
          [
            gamePk,
            effectiveDate,
            game.gameDate ? new Date(String(game.gameDate)).toISOString() : null,
            awayId,
            homeId,
            Number.isFinite(Number(venue.id)) ? Number(venue.id) : null,
            String(asObject(game.status).detailedState ?? "UNKNOWN"),
            String(game.gameType ?? ""),
            String(game.doubleHeader ?? ""),
          ],
        );
      }
      const awayProbable = asObject(asObject(teams.away).probablePitcher);
      const homeProbable = asObject(asObject(teams.home).probablePitcher);
      if (Object.keys(awayProbable).length) await upsertStarter(awayProbable, awayId, writeGamePk, "PROBABLE", awayProbable, effectiveDate);
      if (Object.keys(homeProbable).length) await upsertStarter(homeProbable, homeId, writeGamePk, "PROBABLE", homeProbable, effectiveDate);
      try {
        normalized += await persistOfficialGameFeed(ingestRunId, effectiveDate, gamePk, writeGamePk, awayId, homeId);
      } catch (error) {
        rejected += 1;
        const detail = error instanceof Error ? error.message : "Unknown official game-feed error";
        await recordIssue(MLB_SOURCE, ingestRunId, "NORMALIZATION_FAILURE", "WARNING", detail);
      }
      normalized += 1;
    }
    await finishRun(ingestRunId, rejected ? "PARTIAL" : "SUCCESS", {
      rowCount: games.length,
      normalizedRowCount: normalized,
      rejectedRowCount: rejected,
      httpStatus: response.status,
      metadata: { endpoint: url.toString() },
    }, startedAt);
    return { source: "MLB Official", ingestRunId, rowCount: games.length, normalizedRowCount: normalized, rejectedRowCount: rejected };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown MLB ingest failure";
    await recordIssue(MLB_SOURCE, ingestRunId, "SOURCE_FAILURE", "BLOCKING", detail);
    await finishRun(ingestRunId, "FAILED", { rowCount: 0, normalizedRowCount: 0, rejectedRowCount: 0, errorMessage: detail }, startedAt);
    throw error;
  }
}

export async function ingestFantasyPros(requestedDate: string) {
  const effectiveDate = parseDate(requestedDate);
  const apiKey = process.env.FANTASYPROS_API_KEY;
  if (!apiKey) throw new Error("FantasyPros is not configured");
  const startedAt = Date.now();
  await ensureSources();
  const ingestRunId = await startRun(FANTASY_PROS_SOURCE, "fantasypros-daily-state", effectiveDate);
  try {
    const season = effectiveDate.slice(0, 4);
    const headers = { "x-api-key": apiKey };
    const getJson = async (path: string, params: Record<string, string>): Promise<{
      payload: JsonObject;
      status: number;
      endpoint: string;
      error: string | null;
    }> => {
      const url = new URL(`${FANTASY_PROS_BASE_URL}${path}`);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      try {
        const response = await fetch(url, { headers });
        const payload = await response.json() as JsonObject;
        return response.ok
          ? { payload, status: response.status, endpoint: url.toString(), error: null }
          : { payload: { notAccessible: true, endpoint: path, status: response.status }, status: response.status, endpoint: url.toString(), error: `NOT ACCESSIBLE: FantasyPros ${path} returned HTTP ${response.status}` };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown network error";
        return { payload: { notAccessible: true, endpoint: path }, status: 0, endpoint: url.toString(), error: `NOT ACCESSIBLE: FantasyPros ${path}: ${detail}` };
      }
    };
    const [hitters, pitchers, lineups, currentLineups, news, playerDirectoryResponse] = await Promise.all([
      getJson(`/mlb/${season}/projections`, { type: "daily", position: "H", date: effectiveDate }),
      getJson(`/mlb/${season}/projections`, { type: "daily", position: "P", date: effectiveDate }),
      getJson("/mlb/lineups", { start: effectiveDate, period: "REG", projected: "true" }),
      getJson("/mlb/lineups", { start: effectiveDate, period: "REG" }),
      getJson("/mlb/news", { limit: "100" }),
      getJson("/mlb/players", { external_ids: "mlbam" }),
    ]);
    const endpointResults = [
      { label: "hitter projections", result: hitters },
      { label: "pitcher projections", result: pitchers },
      { label: "projected lineups", result: lineups },
      { label: "current lineups", result: currentLineups },
      { label: "news", result: news },
      { label: "player metadata", result: playerDirectoryResponse },
    ];
    for (const endpoint of endpointResults) {
      if (endpoint.result.error) {
        await recordIssue(FANTASY_PROS_SOURCE, ingestRunId, "SOURCE_FAILURE", "REVIEW", `${endpoint.label}: ${endpoint.result.error}`);
      }
    }
    const playerDirectory = new Map(
      asArray(playerDirectoryResponse.payload.players).map((player) => [String(player.player_id), player]),
    );
    const sources = [
      { kind: "hitter_projections", data: hitters.payload },
      { kind: "pitcher_projections", data: pitchers.payload },
      { kind: "lineups", data: lineups.payload },
      { kind: "current_lineups", data: currentLineups.payload },
      { kind: "news", data: news.payload },
    ];
    const payloadIds = new Map<string, string>();
    for (const source of sources) {
      payloadIds.set(source.kind, await storeRawPayload(ingestRunId, FANTASY_PROS_SOURCE, source.kind, effectiveDate, source.data));
    }
    let projectionRows = 0;
    const missingIdentity = new Set<string>();
    const teamConflicts = new Set<string>();
    for (const item of [
      { label: "Hitter", payload: hitters.payload },
      { label: "Pitcher", payload: pitchers.payload },
    ]) {
      const rows = asArray(item.payload.player);
      const snapshotChecksum = checksum(item.payload);
      const contentChecksum = normalisedChecksum(item.payload);
      const snapshotLabel = `${item.label} daily`;
      const priorSnapshot = await pool.query<{ content_checksum: string }>(
        `SELECT content_checksum FROM fantasypros_projection_snapshots
         WHERE effective_date = $1 AND source_id = $2 AND snapshot_label = $3
         ORDER BY retrieved_at DESC LIMIT 1`,
        [effectiveDate, FANTASY_PROS_SOURCE, snapshotLabel],
      );
      const snapshotResult = await pool.query<{ snapshot_id: string }>(
        `INSERT INTO fantasypros_projection_snapshots (
           effective_date, source_id, ingest_run_id, snapshot_label, raw_payload_id, checksum,
           content_checksum, unchanged_from_prior
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING snapshot_id`,
        [
          effectiveDate, FANTASY_PROS_SOURCE, ingestRunId, snapshotLabel,
          payloadIds.get(item.label === "Hitter" ? "hitter_projections" : "pitcher_projections"),
          snapshotChecksum, contentChecksum, priorSnapshot.rows[0]?.content_checksum === contentChecksum,
        ],
      );
      const snapshotId = snapshotResult.rows[0].snapshot_id;
      for (const row of rows) {
        const sourcePlayerId = String(row.fpid ?? row.player_id ?? "");
        if (!sourcePlayerId) continue;
        const metadata = playerDirectory.get(sourcePlayerId);
        const rawMlbamId = metadata?.mlbam_id;
        const canonicalId = typeof rawMlbamId === "string" || typeof rawMlbamId === "number"
          ? Number(rawMlbamId)
          : Number.NaN;
        const resolvedPlayerId = Number.isSafeInteger(canonicalId) && canonicalId > 0 ? canonicalId : null;
        if (resolvedPlayerId && metadata) {
          await pool.query(
            `INSERT INTO players (player_id, full_name, first_name, last_name, bats, throws, primary_position, birth_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (player_id) DO UPDATE SET full_name = EXCLUDED.full_name, first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name,
               -- Same guard as the official upsert above. The projections
               -- directory frequently carries no handedness at all, and it must
               -- not be able to erase what the official feed established.
               bats = CASE
                 WHEN EXCLUDED.bats IS NOT NULL AND EXCLUDED.bats <> '' THEN EXCLUDED.bats
                 ELSE players.bats
               END,
               throws = CASE
                 WHEN EXCLUDED.throws IS NOT NULL AND EXCLUDED.throws <> '' THEN EXCLUDED.throws
                 ELSE players.throws
               END,
               primary_position = EXCLUDED.primary_position, birth_date = EXCLUDED.birth_date, updated_at = now()`,
            [
              resolvedPlayerId,
              String(metadata.player_name ?? row.name ?? "Unknown player"),
              String(metadata.first_name ?? ""),
              String(metadata.last_name ?? ""),
              handednessCode(metadata.bat_hand),
              handednessCode(metadata.throw_hand),
              String(metadata.primary_position ?? ""),
              metadata.birthdate ? String(metadata.birthdate) : null,
            ],
          );
          const primaryExternal = await pool.query<{ external_player_id: string }>(
            `SELECT external_player_id FROM player_external_ids
             WHERE player_id = $1 AND source_id = $2 LIMIT 1`,
            [resolvedPlayerId, FANTASY_PROS_SOURCE],
          );
          if (primaryExternal.rowCount && primaryExternal.rows[0].external_player_id !== sourcePlayerId) {
            await pool.query(
              `INSERT INTO player_external_id_aliases (player_id, source_id, external_player_id, link_type, evidence)
               VALUES ($1, $2, $3, 'DUPLICATE_SOURCE_ID', $4)
               ON CONFLICT (source_id, external_player_id) DO UPDATE SET
                 player_id = EXCLUDED.player_id, link_type = EXCLUDED.link_type, evidence = EXCLUDED.evidence, observed_at = now()`,
              [resolvedPlayerId, FANTASY_PROS_SOURCE, sourcePlayerId, { mlbamId: resolvedPlayerId, primaryExternalId: primaryExternal.rows[0].external_player_id }],
            );
          } else {
            await pool.query(
              `INSERT INTO player_external_ids (player_id, source_id, external_player_id, confidence, evidence, reviewed_at)
               VALUES ($1, $2, $3, 'CONFIRMED', $4, now())
               ON CONFLICT (source_id, external_player_id) DO UPDATE SET player_id = EXCLUDED.player_id,
                 confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, reviewed_at = EXCLUDED.reviewed_at`,
              [resolvedPlayerId, FANTASY_PROS_SOURCE, sourcePlayerId, { mlbamId: resolvedPlayerId, name: metadata.player_name }],
            );
          }
          await pool.query(
            `INSERT INTO player_aliases (player_id, alias, normalized_alias, source_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (normalized_alias, source_id) DO NOTHING`,
            [resolvedPlayerId, String(row.name ?? metadata.player_name ?? sourcePlayerId), normaliseName(String(row.name ?? metadata.player_name ?? sourcePlayerId)), FANTASY_PROS_SOURCE],
          );
          await pool.query(
            `INSERT INTO identity_match_events (player_id, source_id, external_player_id, confidence, algorithm_version, evidence)
             VALUES ($1, $2, $3, 'CONFIRMED', 'fantasypros-mlbam-bridge-v1', $4)`,
            [resolvedPlayerId, FANTASY_PROS_SOURCE, sourcePlayerId, { mlbamId: resolvedPlayerId, bridge: "FantasyPros player metadata" }],
          );
        }
        const identityConfidence = resolvedPlayerId ? "CONFIRMED" : "REVIEW_REQUIRED";
        if (!resolvedPlayerId) {
          missingIdentity.add(sourcePlayerId);
          await pool.query(
            `INSERT INTO identity_review_queue (source_id, external_player_id, raw_name, normalized_name, evidence)
             SELECT $1, $2, $3, $4, $5
             WHERE NOT EXISTS (
               SELECT 1 FROM identity_review_queue
               WHERE source_id = $1 AND external_player_id = $2 AND state = 'OPEN'
             )`,
            [FANTASY_PROS_SOURCE, sourcePlayerId, String(row.name ?? sourcePlayerId), normaliseName(String(row.name ?? sourcePlayerId)), { sourceRow: row }],
          );
        }
        const sourceName = String(row.name ?? metadata?.player_name ?? sourcePlayerId);
        const sourceTeam = String(row.team_id ?? "");
        const eligibility = await projectionEligibility(
          effectiveDate,
          sourcePlayerId,
          sourceName,
          sourceTeam,
          resolvedPlayerId,
          identityConfidence,
        );
        // FantasyPros is the pregame team authority. A team change is reflected
        // by a new source snapshot; there is no pregame MLB comparison or
        // silent fallback here.
        await pool.query(
          `INSERT INTO fantasypros_projection_rows (snapshot_id, source_player_id, canonical_player_id, team_abbreviation, position, projected_stats, normalized_stats, raw_row, identity_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            snapshotId,
            sourcePlayerId,
            resolvedPlayerId,
            String(row.team_id ?? ""),
            item.label === "Hitter" ? "H" : "P",
            row,
            projectionComponents(row),
            row,
            identityConfidence,
          ],
        );
        projectionRows += 1;
      }
    }
    const newsItems = asArray(news.payload.items);
    for (const item of newsItems) {
      const rawMlbamId = playerDirectory.get(String(item.player_id))?.mlbam_id;
      const canonicalPlayerId = typeof rawMlbamId === "string" || typeof rawMlbamId === "number"
        ? Number(rawMlbamId)
        : Number.NaN;
      const knownNewsPlayer = Number.isSafeInteger(canonicalPlayerId) && canonicalPlayerId > 0
        ? await pool.query<{ player_id: number }>("SELECT player_id FROM players WHERE player_id = $1", [canonicalPlayerId])
        : { rowCount: 0, rows: [] };
      await pool.query(
        `INSERT INTO news_items (source_id, source_reference, player_id, headline, body, published_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          FANTASY_PROS_SOURCE,
          String(item.id ?? ""),
          knownNewsPlayer.rowCount ? canonicalPlayerId : null,
          String(item.title ?? "FantasyPros update"),
          String(item.desc ?? item.impact ?? ""),
          item.created ? new Date(String(item.created).replace(" ", "T") + "Z").toISOString() : null,
          item,
        ],
      );
    }
    await pool.query(
      `UPDATE ingest_issues SET resolved_at = now()
       WHERE source_id = $1 AND resolved_at IS NULL
         AND issue_type IN ('IDENTITY_CONFLICT', 'LINEUP_NORMALIZATION_PENDING')`,
      [FANTASY_PROS_SOURCE],
    );
    if (missingIdentity.size) {
      await recordIssue(
        FANTASY_PROS_SOURCE,
        ingestRunId,
        "IDENTITY_CONFLICT",
        "REVIEW",
        `${missingIdentity.size} FantasyPros player IDs require canonical MLB identity resolution.`,
      );
    }
    const gamesPersisted = await persistFantasyProsGames(ingestRunId, effectiveDate, lineups.payload);
    const fantasyProsWeather = await ingestFantasyProsWeatherObservations(effectiveDate, lineups.payload);
    const starterRows = await persistFantasyProsStarters(ingestRunId, effectiveDate, lineups.payload);
    const [lineupResult, confirmedLineupResult] = await Promise.all([
      persistFantasyProsLineups(ingestRunId, effectiveDate, lineups.payload, "PROJECTED"),
      persistFantasyProsLineups(ingestRunId, effectiveDate, currentLineups.payload, "CONFIRMED"),
    ]);
    await finishRun(ingestRunId, "PARTIAL", {
      rowCount: projectionRows + newsItems.length,
      normalizedRowCount: projectionRows + newsItems.length,
      rejectedRowCount: missingIdentity.size,
      httpStatus: 200,
      metadata: {
        hitterRows: asArray(hitters.payload.player).length,
        pitcherRows: asArray(pitchers.payload.player).length,
        playerDirectoryRows: playerDirectory.size,
        projectedLineupPayloads: asArray(lineups.payload.games).length,
        confirmedLineupPayloads: asArray(currentLineups.payload.games).length,
        fantasyProsGamesPersisted: gamesPersisted,
        fantasyProsWeather,
        fantasyProsStartersPersisted: starterRows,
        projectedLineupSnapshots: lineupResult.snapshots,
        confirmedLineupSnapshots: confirmedLineupResult.snapshots,
        lineupIdentityRejected: lineupResult.unresolvedEntries + confirmedLineupResult.unresolvedEntries,
        newsRows: newsItems.length,
        endpoints: endpointResults.map((endpoint) => ({
          label: endpoint.label,
          status: endpoint.result.status,
          endpoint: endpoint.result.endpoint,
          error: endpoint.result.error,
        })),
      },
    }, startedAt);
    return {
      source: "FantasyPros",
      ingestRunId,
      rowCount: projectionRows + newsItems.length,
      normalizedRowCount: projectionRows + newsItems.length,
      rejectedRowCount: missingIdentity.size,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown FantasyPros ingest failure";
    await recordIssue(FANTASY_PROS_SOURCE, ingestRunId, "SOURCE_FAILURE", "BLOCKING", detail);
    await finishRun(ingestRunId, "FAILED", { rowCount: 0, normalizedRowCount: 0, rejectedRowCount: 0, errorMessage: detail }, startedAt);
    throw error;
  }
}