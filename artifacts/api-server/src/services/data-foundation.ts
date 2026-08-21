import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

const MLB_SOURCE = "MLB_OFFICIAL";
const FANTASY_PROS_SOURCE = "FANTASYPROS";
const MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const FANTASY_PROS_BASE_URL = "https://api.fantasypros.com/public/v2/json";

type JsonObject = Record<string, unknown>;

function checksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
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
       ($2, 'FantasyPros', 'PROJECTION', 'https://api.fantasypros.com', 30, 'Forward projections, lineups and news. Never authoritative for official game state.')
     ON CONFLICT (source_id) DO UPDATE SET name = EXCLUDED.name, source_type = EXCLUDED.source_type, base_url = EXCLUDED.base_url`,
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

async function upsertStarter(person: JsonObject, teamId: number, gamePk: number, state: string, raw: JsonObject) {
  const playerId = Number(person.id);
  if (!Number.isFinite(playerId)) return false;
  await pool.query(
    `INSERT INTO players (player_id, full_name, primary_position)
     VALUES ($1, $2, 'P')
     ON CONFLICT (player_id) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = now()`,
    [playerId, String(person.fullName ?? person.name ?? "Unknown pitcher")],
  );
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

function projectionComponents(row: JsonObject) {
  const keys = ["pa", "ab", "hits", "1b", "2b", "3b", "hrs", "bb"] as const;
  return Object.fromEntries(keys.flatMap((key) => {
    const value = row[key];
    return typeof value === "number" ? [[key, value]] : [];
  }));
}

async function upsertOfficialPlayer(entry: JsonObject, teamId: number, effectiveDate: string) {
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
       last_name = EXCLUDED.last_name, bats = EXCLUDED.bats, throws = EXCLUDED.throws,
       primary_position = EXCLUDED.primary_position, current_team_id = EXCLUDED.current_team_id, updated_at = now()`,
    [
      playerId,
      String(person.fullName ?? "Unknown player"),
      String(person.firstName ?? ""),
      String(person.lastName ?? ""),
      String(batSide.code ?? ""),
      String(pitchHand.code ?? ""),
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
  return playerId;
}

async function persistOfficialGameFeed(
  ingestRunId: string,
  effectiveDate: string,
  gamePk: number,
  awayTeamId: number,
  homeTeamId: number,
) {
  const response = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
  const payload = await response.json() as JsonObject;
  if (!response.ok) throw new Error(`MLB game feed ${gamePk} returned HTTP ${response.status}`);
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
        await upsertStarter(asObject(player.person), teamId, gamePk, "CONFIRMED", player);
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
) {
  let snapshots = 0;
  let unresolvedEntries = 0;
  for (const game of asArray(payload.games)) {
    const hitters = asObject(game.hitters);
    for (const [abbreviation, lineup] of Object.entries(hitters)) {
      const target = await pool.query<{ game_pk: number; team_id: number }>(
        `SELECT g.game_pk, t.team_id
         FROM games g JOIN teams t ON t.team_id IN (g.away_team_id, g.home_team_id)
         WHERE g.game_date = $1 AND t.abbreviation = $2 LIMIT 1`,
        [effectiveDate, abbreviation],
      );
      const gameTarget = target.rows[0];
      if (!gameTarget) {
        await recordIssue(FANTASY_PROS_SOURCE, ingestRunId, "GAME_STATE_CONFLICT", "REVIEW", `Projected lineup team ${abbreviation} could not map to an official game.`);
        continue;
      }
      const lineupRows = Object.entries(asObject(lineup))
        .map(([order, value]) => ({ order: Number(order), value: asObject(value) }))
        .filter((item) => Number.isInteger(item.order) && item.order >= 1 && item.order <= 9)
        .sort((a, b) => a.order - b.order);
      const lineupRaw = {
        checksum: checksum({ gameId: game.game_id, abbreviation, lineupRows }),
        owner: FANTASY_PROS_SOURCE,
        state: "PROJECTED",
      };
      const existing = await pool.query<{ lineup_snapshot_id: string }>(
        `SELECT lineup_snapshot_id FROM lineup_snapshots
         WHERE game_pk = $1 AND team_id = $2 AND state = 'PROJECTED' AND source_id = $3
           AND raw->>'checksum' = $4 LIMIT 1`,
        [gameTarget.game_pk, gameTarget.team_id, FANTASY_PROS_SOURCE, String(lineupRaw.checksum)],
      );
      if (existing.rowCount) continue;
      const snapshot = await pool.query<{ lineup_snapshot_id: string }>(
        `INSERT INTO lineup_snapshots (game_pk, team_id, state, source_id, observed_at, raw)
         VALUES ($1, $2, 'PROJECTED', $3, now(), $4) RETURNING lineup_snapshot_id`,
        [gameTarget.game_pk, gameTarget.team_id, FANTASY_PROS_SOURCE, lineupRaw],
      );
      for (const row of lineupRows) {
        const externalId = String(row.value.player_id ?? "");
        const identity = await pool.query<{ player_id: number }>(
          `SELECT player_id FROM player_external_ids
           WHERE source_id = $1 AND external_player_id = $2 AND valid_to IS NULL LIMIT 1`,
          [FANTASY_PROS_SOURCE, externalId],
        );
        if (!identity.rowCount) {
          unresolvedEntries += 1;
          await recordIssue(FANTASY_PROS_SOURCE, ingestRunId, "IDENTITY_CONFLICT", "REVIEW", `FantasyPros lineup player ${externalId} could not map to an MLBAM identity.`);
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
      if (Number.isFinite(Number(venue.id))) {
        await pool.query(
          `INSERT INTO venues (venue_id, name, metadata) VALUES ($1, $2, $3)
           ON CONFLICT (venue_id) DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata`,
          [Number(venue.id), String(venue.name ?? "Unknown venue"), venue],
        );
      }
      await pool.query(
        `INSERT INTO games (game_pk, game_date, start_time_utc, away_team_id, home_team_id, venue_id, game_status, game_type, doubleheader_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (game_pk) DO UPDATE SET start_time_utc = EXCLUDED.start_time_utc, game_status = EXCLUDED.game_status,
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
      const awayProbable = asObject(asObject(teams.away).probablePitcher);
      const homeProbable = asObject(asObject(teams.home).probablePitcher);
      if (Object.keys(awayProbable).length) await upsertStarter(awayProbable, awayId, gamePk, "PROBABLE", awayProbable);
      if (Object.keys(homeProbable).length) await upsertStarter(homeProbable, homeId, gamePk, "PROBABLE", homeProbable);
      try {
        normalized += await persistOfficialGameFeed(ingestRunId, effectiveDate, gamePk, awayId, homeId);
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
    for (const item of [
      { label: "Hitter", payload: hitters.payload },
      { label: "Pitcher", payload: pitchers.payload },
    ]) {
      const rows = asArray(item.payload.player);
      const snapshotChecksum = checksum(item.payload);
      const snapshotResult = await pool.query<{ snapshot_id: string }>(
        `INSERT INTO fantasypros_projection_snapshots (effective_date, source_id, ingest_run_id, snapshot_label, raw_payload_id, checksum)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING snapshot_id`,
        [effectiveDate, FANTASY_PROS_SOURCE, ingestRunId, `${item.label} daily`, payloadIds.get(item.label === "Hitter" ? "hitter_projections" : "pitcher_projections"), snapshotChecksum],
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
               last_name = EXCLUDED.last_name, bats = EXCLUDED.bats, throws = EXCLUDED.throws,
               primary_position = EXCLUDED.primary_position, birth_date = EXCLUDED.birth_date, updated_at = now()`,
            [
              resolvedPlayerId,
              String(metadata.player_name ?? row.name ?? "Unknown player"),
              String(metadata.first_name ?? ""),
              String(metadata.last_name ?? ""),
              String(metadata.bat_hand ?? ""),
              String(metadata.throw_hand ?? ""),
              String(metadata.primary_position ?? ""),
              metadata.birthdate ? String(metadata.birthdate) : null,
            ],
          );
          await pool.query(
            `INSERT INTO player_external_ids (player_id, source_id, external_player_id, confidence, evidence, reviewed_at)
             VALUES ($1, $2, $3, 'CONFIRMED', $4, now())
             ON CONFLICT (source_id, external_player_id) DO UPDATE SET player_id = EXCLUDED.player_id,
               confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, reviewed_at = EXCLUDED.reviewed_at`,
            [resolvedPlayerId, FANTASY_PROS_SOURCE, sourcePlayerId, { mlbamId: resolvedPlayerId, name: metadata.player_name }],
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
    const lineupResult = await persistFantasyProsLineups(ingestRunId, effectiveDate, lineups.payload);
    await finishRun(ingestRunId, "PARTIAL", {
      rowCount: projectionRows + newsItems.length,
      normalizedRowCount: projectionRows + newsItems.length,
      rejectedRowCount: missingIdentity.size,
      httpStatus: 200,
      metadata: {
        hitterRows: asArray(hitters.payload.player).length,
        pitcherRows: asArray(pitchers.payload.player).length,
        playerDirectoryRows: playerDirectory.size,
        lineupPayloads: asArray(lineups.payload.games).length,
        lineupSnapshots: lineupResult.snapshots,
        lineupIdentityRejected: lineupResult.unresolvedEntries,
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