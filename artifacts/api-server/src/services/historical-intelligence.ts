import { pool } from "@workspace/db";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger";

const STATCAST_SOURCE = "STATCAST";
const TRANSFORMATION_VERSION = "historical-intelligence-v1";
const RATE_SAMPLE_MINIMUM = 10;

export type HistoricalIntelligenceRefreshInput = {
  from: string;
  to: string;
  limit: number;
  cursor?: string;
};

type HistoricalCursor = { date: string; eventKey: string };
type SourceEventKey = { game_date: string; source_event_key: string };
type QueryExecutor = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rowCount: number | null; rows: T[] }>;
};

type CoverageRow = {
  first_observation_date: string | null;
  latest_observation_date: string | null;
  event_count: number;
  context_count: number;
  derived_feature_count: number;
  latest_derived_at: string | null;
  latest_run_status: "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED" | null;
};
type HorizonCoverageRow = {
  required_range_count: number;
  completed_range_count: number;
  partial_range_count: number;
};
type StatcastRow = Record<string, string>;
type HistoricalTarget = { player_id: number; role: "HITTER" | "PITCHER"; requested_from: string; requested_to: string };
type HistoricalMaterializationInput = HistoricalIntelligenceRefreshInput & {
  target?: HistoricalTarget;
  skipSourceSeed?: boolean;
};
type BackfillLease = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
  release: () => void;
};
let backfillWorkerStarted = false;
let backfillWorkerRunning = false;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const asNumber = (value: string | undefined) => {
  const parsed = Number(value?.trim() ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};

function parseCsv(text: string): StatcastRow[] {
  const split = (line: string) => {
    const values: string[] = []; let value = ""; let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
      } else if (character === "," && !quoted) { values.push(value); value = ""; } else value += character;
    }
    values.push(value);
    return values.map((cell) => cell.trim());
  };
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = split(lines.shift() ?? "");
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, split(line)[index] ?? ""])));
}

function terminalPlateKeys(rows: StatcastRow[]) {
  const terminal = new Map<string, number>();
  for (const row of rows) {
    if (!row.game_pk || !row.at_bat_number) continue;
    const key = `${row.game_pk}:${row.at_bat_number}`;
    const pitchNumber = asNumber(row.pitch_number) ?? 0;
    if (pitchNumber >= (terminal.get(key) ?? -1)) terminal.set(key, pitchNumber);
  }
  return terminal;
}

function statcastHistoricalUrl(target: HistoricalTarget, from: string, to: string) {
  const params = new URLSearchParams({
    all: "true",
    type: target.role === "HITTER" ? "batter" : "pitcher",
    player_type: target.role === "HITTER" ? "batter" : "pitcher",
    game_date_gt: from,
    game_date_lt: to,
  });
  params.append(target.role === "HITTER" ? "batters_lookup[]" : "pitchers_lookup[]", String(target.player_id));
  return `https://baseballsavant.mlb.com/statcast_search/csv?${params.toString()}`;
}

function safeDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HistoricalIntelligenceValidationError("Dates must use YYYY-MM-DD.");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HistoricalIntelligenceValidationError("Dates must be real calendar dates.");
  }
  return value;
}

function seasonStart(value: string) {
  return `${value.slice(0, 4)}-03-01`;
}

function rollingStart(value: string, days: number) {
  const end = new Date(`${value}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() - days + 1);
  return end.toISOString().slice(0, 10);
}

function decodeCursor(cursor: string | undefined): HistoricalCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof (decoded as HistoricalCursor).date !== "string" ||
      typeof (decoded as HistoricalCursor).eventKey !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return { date: safeDate((decoded as HistoricalCursor).date), eventKey: (decoded as HistoricalCursor).eventKey };
  } catch {
    throw new HistoricalIntelligenceValidationError("cursor must be an opaque cursor returned by a prior historical materialization response.");
  }
}

function encodeCursor(cursor: HistoricalCursor | null) {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

async function ensureSource() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, base_url, expected_freshness_minutes, notes)
     VALUES ($1, 'Baseball Savant / Statcast', 'RESEARCH', 'https://baseballsavant.mlb.com', 1440,
       'Canonical-ID historical observations. Retained event coverage is explicit and may be partial.')
     ON CONFLICT (source_id) DO NOTHING`,
    [STATCAST_SOURCE],
  );
}

async function historicalTargets(from: string, to: string, limit: number) {
  const result = await pool.query<HistoricalTarget>(
    `WITH current_eligibility AS (
       SELECT DISTINCT ON (pe.player_id) pe.player_id, pe.eligible_today_research, pe.eligible_pitcher_research, p.primary_position
       FROM player_eligibility pe
       JOIN players p ON p.player_id = pe.player_id
       WHERE p.active AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
       ORDER BY pe.player_id, pe.effective_date DESC, pe.observed_at DESC
     ), candidates AS (
       SELECT player_id, 'HITTER'::text AS role FROM current_eligibility
       WHERE eligible_today_research AND COALESCE(primary_position, '') <> 'P'
       UNION ALL
       SELECT player_id, 'PITCHER'::text AS role FROM current_eligibility
       WHERE eligible_pitcher_research AND primary_position = 'P'
      ), season_ranges AS (
        SELECT GREATEST($2::date, make_date(year, 3, 1))::date AS requested_from,
          LEAST($3::date, make_date(year, 11, 30))::date AS requested_to
        FROM generate_series(EXTRACT(YEAR FROM $2::date)::int, EXTRACT(YEAR FROM $3::date)::int) AS year
        WHERE GREATEST($2::date, make_date(year, 3, 1)) <= LEAST($3::date, make_date(year, 11, 30))
     )
      SELECT c.player_id, c.role::text AS role, sr.requested_from::text, sr.requested_to::text
      FROM candidates c CROSS JOIN season_ranges sr
     WHERE NOT EXISTS (
        SELECT 1 FROM historical_source_coverage coverage
        WHERE coverage.source_id = $1
          AND coverage.player_id = c.player_id
          AND coverage.participant_role = c.role
           AND coverage.status = 'SUCCESS'
          AND coverage.requested_from <= sr.requested_from
          AND coverage.requested_to >= sr.requested_to
          AND (
            coverage.source_rows = 0
            OR EXISTS (
              SELECT 1 FROM player_intelligence_features feature
              WHERE feature.player_id = c.player_id
                AND feature.dimensions->>'participantRole' = c.role
                AND feature.effective_from <= sr.requested_from
                AND feature.effective_to >= sr.requested_to
            )
          )
     )
      ORDER BY (
        SELECT count(*)
        FROM historical_source_coverage retry
        WHERE retry.source_id = $1
          AND retry.player_id = c.player_id
          AND retry.participant_role = c.role
          AND retry.requested_from = sr.requested_from
          AND retry.requested_to = sr.requested_to
          AND retry.status = 'PARTIAL'
      ) ASC, c.player_id, c.role, sr.requested_from
     LIMIT $4`,
    [STATCAST_SOURCE, from, to, limit],
  );
  return result.rows;
}

async function startSourceLoadRun(to: string) {
  const result = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date, metadata)
     VALUES ($1, 'statcast_historical_intelligence_seed', 'RUNNING', $2, $3)
     RETURNING ingest_run_id`,
    [STATCAST_SOURCE, to, { sourceContract: "documented Baseball Savant Statcast Search CSV", scope: "bounded eligible canonical MLB IDs" }],
  );
  return result.rows[0].ingest_run_id;
}

async function recordSourceCoverage(target: HistoricalTarget, ingestRunId: string, status: "SUCCESS" | "PARTIAL" | "FAILED", sourceRows: number, normalizedRows: number, rejectedRows: number, errorMessage: string | null) {
  await pool.query(
    `INSERT INTO historical_source_coverage
      (source_id, player_id, participant_role, requested_from, requested_to, ingest_run_id, status,
       source_rows, normalized_rows, rejected_rows, error_message, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      STATCAST_SOURCE, target.player_id, target.role, target.requested_from, target.requested_to, ingestRunId, status,
      sourceRows, normalizedRows, rejectedRows, errorMessage,
      { sourceContract: "documented Baseball Savant Statcast Search CSV", target, completionMeaning: "Source request completed for this canonical player, role, and bounded season range." },
    ],
  );
}

async function loadHistoricalTarget(target: HistoricalTarget) {
  const ingestRunId = await startSourceLoadRun(target.requested_to);
  let payload = "";
  try {
    const endpoint = statcastHistoricalUrl(target, target.requested_from, target.requested_to);
    const response = await fetch(endpoint, {
      headers: { accept: "text/csv,text/plain", "user-agent": "MLBAnalystHistoricalIntelligence/1.0" },
      signal: AbortSignal.timeout(90_000),
    });
    payload = await response.text();
    if (!response.ok) throw new Error(`Statcast Search returned HTTP ${response.status}.`);
    const rawPayload = await pool.query<{ raw_payload_id: string }>(
      `INSERT INTO raw_payloads (ingest_run_id, source_id, payload_type, effective_date, checksum, byte_count, metadata)
       VALUES ($1, $2, 'statcast_historical_intelligence_csv', $3, $4, $5, $6)
       RETURNING raw_payload_id`,
      [ingestRunId, STATCAST_SOURCE, target.requested_to, hash(payload), Buffer.byteLength(payload), { endpoint, from: target.requested_from, to: target.requested_to, target, source: "Baseball Savant / Statcast Search", canonicalIdsOnly: true }],
    );
    const rows = parseCsv(payload);
    const canonicalIds = [...new Set(rows.flatMap((row) => [asNumber(row.batter), asNumber(row.pitcher)]).filter((id): id is number => id !== null))];
    const known = await pool.query<{ player_id: number }>(`SELECT player_id FROM players WHERE player_id = ANY($1::int[])`, [canonicalIds]);
    const knownIds = new Set(known.rows.map((row) => row.player_id));
    const terminal = terminalPlateKeys(rows);
    let inserted = 0;
    let rejected = 0;
    for (const row of rows) {
      const batterId = asNumber(row.batter);
      const pitcherId = asNumber(row.pitcher);
      const gamePk = asNumber(row.game_pk);
      const atBatNumber = asNumber(row.at_bat_number);
      const pitchNumber = asNumber(row.pitch_number);
      const matchesTarget = target.role === "HITTER"
        ? batterId === target.player_id
        : pitcherId === target.player_id;
      if (!batterId || !pitcherId || !gamePk || !atBatNumber || !pitchNumber || !row.game_date || !matchesTarget || !knownIds.has(batterId) || !knownIds.has(pitcherId)) {
        rejected += 1;
        continue;
      }
      const eventKey = `${gamePk}:${atBatNumber}:${pitchNumber}`;
      const result = await pool.query(
        `INSERT INTO batter_pitcher_events
          (source_id, source_event_key, raw_payload_id, batter_id, pitcher_id, game_pk, game_date, at_bat_number, pitch_number,
           is_terminal_plate_appearance, event_type, pitch_type, release_speed, horizontal_movement, vertical_movement,
           launch_speed, launch_angle, estimated_ba, estimated_slg, raw, content_checksum)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (source_id, source_event_key, content_checksum) DO NOTHING`,
        [
          STATCAST_SOURCE, eventKey, rawPayload.rows[0].raw_payload_id, batterId, pitcherId, gamePk, row.game_date, atBatNumber, pitchNumber,
          terminal.get(`${gamePk}:${atBatNumber}`) === pitchNumber, row.events || null, row.pitch_type || null,
          asNumber(row.release_speed), asNumber(row.pfx_x), asNumber(row.pfx_z), asNumber(row.launch_speed), asNumber(row.launch_angle),
          asNumber(row.estimated_ba_using_speedangle), asNumber(row.estimated_slg_using_speedangle), row, hash(row),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    await pool.query(
      `UPDATE ingest_runs SET status = $2, row_count = $3, normalized_row_count = $4, rejected_row_count = $5, finished_at = now()
       WHERE ingest_run_id = $1`,
      [ingestRunId, rejected ? "PARTIAL" : "SUCCESS", rows.length, inserted, rejected],
    );
    await recordSourceCoverage(target, ingestRunId, rejected ? "PARTIAL" : "SUCCESS", rows.length, inserted, rejected, null);
    return { sourceRows: rows.length, inserted, rejected, target };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE ingest_runs SET status = 'FAILED', error_message = $2, finished_at = now() WHERE ingest_run_id = $1`,
      [ingestRunId, message],
    );
    await recordSourceCoverage(target, ingestRunId, "FAILED", 0, 0, 0, message);
    return { sourceRows: 0, inserted: 0, rejected: 0, target, error: message };
  }
}

async function seedHistoricalSource(from: string, to: string) {
  const targets = await historicalTargets(from, to, 1);
  if (!targets.length) return { targets: 0, sourceRows: 0, inserted: 0, rejected: 0, failures: [] as string[] };
  const result = await loadHistoricalTarget(targets[0]);
  return {
    targets: 1,
    sourceRows: result.sourceRows,
    inserted: result.inserted,
    rejected: result.rejected,
    failures: "error" in result ? [result.error] : [],
  };
}

async function sourceEventBatch(from: string, to: string, cursor: HistoricalCursor | null, limit: number, target?: HistoricalTarget) {
  const result = await pool.query<SourceEventKey>(
    `SELECT DISTINCT b.game_date::text AS game_date, b.source_event_key
     FROM batter_pitcher_events b
     WHERE b.source_id = $1
       AND b.game_date BETWEEN $2 AND $3
       AND ($4::date IS NULL OR b.game_date > $4 OR (b.game_date = $4 AND b.source_event_key > $5))
        AND (
          $6::integer IS NULL
          OR ($7::text = 'HITTER' AND b.batter_id = $6)
          OR ($7::text = 'PITCHER' AND b.pitcher_id = $6)
        )
     ORDER BY b.game_date::text, b.source_event_key
      LIMIT $8`,
    [STATCAST_SOURCE, from, to, cursor?.date ?? null, cursor?.eventKey ?? "", target?.player_id ?? null, target?.role ?? null, limit + 1],
  );
  return result.rows;
}

function batchPayload(keys: SourceEventKey[]) {
  return JSON.stringify(keys);
}

async function materializeContexts(keys: SourceEventKey[], db: QueryExecutor) {
  if (keys.length === 0) return 0;
  const result = await db.query<{ context_id: string }>(
    `WITH batch_keys AS (
       SELECT game_date::date, source_event_key
       FROM jsonb_to_recordset($2::jsonb) AS keys(game_date text, source_event_key text)
     ), event_games AS (
       SELECT DISTINCT ON (b.game_pk) b.game_pk, b.game_date
       FROM batter_pitcher_events b
       JOIN batch_keys keys ON keys.game_date = b.game_date AND keys.source_event_key = b.source_event_key
       WHERE b.source_id = $1 AND b.game_pk IS NOT NULL
       ORDER BY b.game_pk, b.game_date DESC
     ), source_context AS (
       SELECT eg.game_pk, eg.game_date, g.venue_id, g.start_time_utc,
         COALESCE(v.timezone, 'America/New_York') AS local_timezone,
         g.doubleheader_code, v.roof_type,
         weather.temperature_f, weather.humidity_percent, weather.wind_speed_mph,
         weather.wind_direction_degrees, weather.wind_out_component_mph, weather.roof_state,
         CASE
           WHEN g.start_time_utc IS NULL THEN 'NOT_FOUND'
           WHEN EXTRACT(HOUR FROM g.start_time_utc AT TIME ZONE COALESCE(v.timezone, 'America/New_York')) < 17 THEN 'DAY'
           ELSE 'NIGHT'
         END AS day_night
       FROM event_games eg
       LEFT JOIN games g ON g.game_pk = eg.game_pk
       LEFT JOIN venues v ON v.venue_id = g.venue_id
       LEFT JOIN LATERAL (
         SELECT temperature_f, humidity_percent, wind_speed_mph, wind_direction_degrees,
                wind_out_component_mph, roof_state
         FROM game_weather_observations w
          WHERE w.game_pk = eg.game_pk
            AND g.start_time_utc IS NOT NULL
            AND w.retrieved_at <= g.start_time_utc
         ORDER BY w.retrieved_at DESC
         LIMIT 1
       ) weather ON true
     )
     INSERT INTO historical_game_contexts
       (game_pk, game_date, venue_id, local_scheduled_start, local_timezone, day_night,
        doubleheader_game_number, roof_state, temperature_f, humidity_percent, wind_speed_mph,
        wind_direction_degrees, wind_out_component_mph, source_id, content_checksum, raw)
     SELECT game_pk, game_date, venue_id, start_time_utc, local_timezone, day_night,
       CASE WHEN doubleheader_code ~ '^[0-9]+$' THEN doubleheader_code::integer ELSE NULL END,
       COALESCE(roof_state, roof_type), temperature_f, humidity_percent, wind_speed_mph,
       wind_direction_degrees, wind_out_component_mph, $1,
       md5(concat_ws('|', game_pk::text, game_date::text, COALESCE(venue_id::text, ''),
         COALESCE(start_time_utc::text, ''), local_timezone, day_night, COALESCE(doubleheader_code, ''),
         COALESCE(roof_state, roof_type, ''), COALESCE(temperature_f::text, ''),
         COALESCE(humidity_percent::text, ''), COALESCE(wind_speed_mph::text, ''),
         COALESCE(wind_direction_degrees::text, ''), COALESCE(wind_out_component_mph::text, ''))),
       jsonb_build_object(
         'owner', 'MLB official game context where available',
         'classification', 'descriptive day/night context, not a causal skill claim',
         'weatherCoverage', CASE WHEN temperature_f IS NULL AND roof_state IS NULL THEN 'NOT_FOUND' ELSE 'SOURCED' END,
         'weatherAsOf', start_time_utc
       )
     FROM source_context
     ON CONFLICT (source_id, game_pk, content_checksum) DO NOTHING
     RETURNING context_id`,
     [STATCAST_SOURCE, batchPayload(keys)],
  );
  return result.rowCount ?? 0;
}

async function materializeObservations(keys: SourceEventKey[], db: QueryExecutor) {
  if (keys.length === 0) return 0;
  const result = await db.query<{ observation_id: string }>(
    `WITH batch_keys AS (
       SELECT game_date::date, source_event_key
       FROM jsonb_to_recordset($2::jsonb) AS keys(game_date text, source_event_key text)
      ), source_events AS (
       SELECT b.*
       FROM batter_pitcher_events b
       JOIN batch_keys keys ON keys.game_date = b.game_date AND keys.source_event_key = b.source_event_key
       WHERE b.source_id = $1
     ), contexts AS (
        SELECT DISTINCT ON (game_pk) context_id, game_pk, observed_at
       FROM historical_game_contexts
       WHERE source_id = $1
       ORDER BY game_pk, observed_at DESC
      ), participants AS (
        SELECT e.*, e.batter_id AS participant_id, e.pitcher_id AS opponent_id, 'HITTER'::text AS participant_role
        FROM source_events e
        UNION ALL
        SELECT e.*, e.pitcher_id AS participant_id, e.batter_id AS opponent_id, 'PITCHER'::text AS participant_role
        FROM source_events e
      )
     INSERT INTO historical_player_observations
       (source_id, source_event_key, source_player_id, player_id, opponent_player_id, context_id,
         raw_payload_id, observation_date, retrieved_at, event_type, pitch_type, batter_side, pitcher_side,
        is_terminal_plate_appearance, release_speed, horizontal_movement, vertical_movement,
        launch_speed, launch_angle, estimated_ba, estimated_slg, content_checksum,
        transformation_version, raw)
      SELECT e.source_id, e.source_event_key, e.participant_id::text, e.participant_id, e.opponent_id, c.context_id,
        e.raw_payload_id, e.game_date, e.retrieved_at, e.event_type, e.pitch_type,
       NULLIF(upper(e.raw->>'stand'), ''), NULLIF(upper(e.raw->>'p_throws'), ''),
       e.is_terminal_plate_appearance, e.release_speed, e.horizontal_movement, e.vertical_movement,
        e.launch_speed, e.launch_angle, e.estimated_ba, e.estimated_slg,
         md5(concat_ws('|', e.content_checksum, e.participant_role, COALESCE(c.context_id::text, 'NO_CONTEXT'))),
        $3,
        e.raw || jsonb_build_object(
          'sourceEventChecksum', e.content_checksum,
          'participantRole', e.participant_role,
          'gamePk', e.game_pk,
          'contextId', c.context_id,
          'contextObservedAt', c.observed_at
        )
      FROM participants e
     LEFT JOIN contexts c ON c.game_pk = e.game_pk
     ON CONFLICT (source_id, source_event_key, source_player_id, content_checksum) DO NOTHING
     RETURNING observation_id`,
     [STATCAST_SOURCE, batchPayload(keys), TRANSFORMATION_VERSION],
  );
  return result.rowCount ?? 0;
}

async function materializeFeatures(runId: string, from: string, to: string, db: QueryExecutor) {
  const windows: Array<{ window: "SEASON" | "ROLLING_14" | "ROLLING_30" | "ROLLING_60"; from: string }> = [
    { window: "SEASON", from: seasonStart(to) },
    { window: "ROLLING_14", from: rollingStart(to, 14) },
    { window: "ROLLING_30", from: rollingStart(to, 30) },
    { window: "ROLLING_60", from: rollingStart(to, 60) },
  ];
  let written = 0;
  for (const scope of windows) {
    if (scope.from < from) continue;
    const result = await db.query(
       `WITH latest_observations AS (
          SELECT DISTINCT ON (o.source_id, o.source_event_key, o.source_player_id) o.*
          FROM historical_player_observations o
          WHERE o.source_id = $1
            AND o.observation_date BETWEEN $2 AND $3
          ORDER BY o.source_id, o.source_event_key, o.source_player_id, o.retrieved_at DESC,
            COALESCE(o.raw->>'contextObservedAt', '') DESC, o.content_checksum DESC
        ), terminal_events AS (
           SELECT o.player_id, COALESCE(o.raw->>'participantRole', 'HITTER') AS participant_role, o.source_event_key, o.content_checksum, o.context_id, o.observation_date, lower(COALESCE(o.event_type, '')) AS event_type,
            CASE WHEN COALESCE(o.raw->>'participantRole', 'HITTER') = 'PITCHER'
              THEN COALESCE(NULLIF(o.batter_side, ''), 'NOT_FOUND')
              ELSE COALESCE(NULLIF(o.pitcher_side, ''), 'NOT_FOUND') END AS opponent_side,
           COALESCE(c.day_night, 'NOT_FOUND') AS day_night
          FROM latest_observations o
         LEFT JOIN historical_game_contexts c ON c.context_id = o.context_id
         WHERE o.source_id = $1
           AND o.observation_date BETWEEN $2 AND $3
           AND o.is_terminal_plate_appearance
        ), split_aggregate AS (
          SELECT player_id, participant_role, opponent_side, day_night,
           count(*)::numeric AS pa,
           count(*) FILTER (WHERE event_type NOT IN ('walk', 'intent_walk', 'intentional_walk', 'hit_by_pitch'))::numeric AS ab,
           count(*) FILTER (WHERE event_type IN ('single', 'double', 'triple', 'home_run'))::numeric AS hits,
           count(*) FILTER (WHERE event_type IN ('double', 'triple', 'home_run'))::numeric AS xbh,
           count(*) FILTER (WHERE event_type = 'home_run')::numeric AS home_runs,
           count(*) FILTER (WHERE event_type IN ('walk', 'intent_walk', 'intentional_walk'))::numeric AS walks,
           sum(CASE event_type WHEN 'single' THEN 1 WHEN 'double' THEN 2 WHEN 'triple' THEN 3 WHEN 'home_run' THEN 4 ELSE 0 END)::numeric AS total_bases,
           md5(string_agg(
             concat_ws(':', source_event_key, content_checksum, COALESCE(context_id::text, 'NO_CONTEXT')),
             '|' ORDER BY source_event_key, content_checksum, context_id
           )) AS source_input_checksum
         FROM terminal_events
          GROUP BY player_id, participant_role, opponent_side, day_night
        ), aggregate AS (
          SELECT * FROM split_aggregate
          UNION ALL
          SELECT player_id, participant_role, 'ALL' AS opponent_side, 'ALL' AS day_night,
            sum(pa), sum(ab), sum(hits), sum(xbh), sum(home_runs), sum(walks), sum(total_bases),
            md5(string_agg(source_input_checksum, '|' ORDER BY source_input_checksum))
          FROM split_aggregate
          GROUP BY player_id, participant_role
       ), metrics AS (
          SELECT a.*, m.metric_key, m.metric_label, m.value, m.numerator, m.denominator,
           m.denominator_type, m.sample_status
         FROM aggregate a
         CROSS JOIN LATERAL (
           VALUES
              ('plate_appearances', 'Plate appearances', CASE WHEN a.participant_role = 'HITTER' THEN a.pa ELSE NULL END, a.pa, a.pa, 'PA', CASE WHEN a.participant_role = 'HITTER' THEN 'AVAILABLE' ELSE 'NOT_FOUND' END),
              ('batting_average', 'Batting average', CASE WHEN a.participant_role = 'HITTER' AND a.ab > 0 THEN a.hits / a.ab ELSE NULL END, a.hits, a.ab, 'AB', CASE WHEN a.participant_role = 'HITTER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'HITTER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('slugging_percentage', 'Slugging percentage', CASE WHEN a.participant_role = 'HITTER' AND a.ab > 0 THEN a.total_bases / a.ab ELSE NULL END, a.total_bases, a.ab, 'AB', CASE WHEN a.participant_role = 'HITTER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'HITTER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('xbh_per_pa', 'Extra-base hits / PA', CASE WHEN a.participant_role = 'HITTER' AND a.pa > 0 THEN a.xbh / a.pa ELSE NULL END, a.xbh, a.pa, 'PA', CASE WHEN a.participant_role = 'HITTER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'HITTER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('home_run_per_pa', 'Home runs / PA', CASE WHEN a.participant_role = 'HITTER' AND a.pa > 0 THEN a.home_runs / a.pa ELSE NULL END, a.home_runs, a.pa, 'PA', CASE WHEN a.participant_role = 'HITTER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'HITTER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('walk_rate', 'Walk rate', CASE WHEN a.participant_role = 'HITTER' AND a.pa > 0 THEN a.walks / a.pa ELSE NULL END, a.walks, a.pa, 'PA', CASE WHEN a.participant_role = 'HITTER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'HITTER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('batters_faced', 'Batters faced', CASE WHEN a.participant_role = 'PITCHER' THEN a.pa ELSE NULL END, a.pa, a.pa, 'BF', CASE WHEN a.participant_role = 'PITCHER' THEN 'AVAILABLE' ELSE 'NOT_FOUND' END),
              ('opponent_batting_average', 'Opponent batting average', CASE WHEN a.participant_role = 'PITCHER' AND a.ab > 0 THEN a.hits / a.ab ELSE NULL END, a.hits, a.ab, 'AB', CASE WHEN a.participant_role = 'PITCHER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'PITCHER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('opponent_slugging_percentage', 'Opponent slugging percentage', CASE WHEN a.participant_role = 'PITCHER' AND a.ab > 0 THEN a.total_bases / a.ab ELSE NULL END, a.total_bases, a.ab, 'AB', CASE WHEN a.participant_role = 'PITCHER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'PITCHER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('xbh_allowed_per_bf', 'XBH allowed / BF', CASE WHEN a.participant_role = 'PITCHER' AND a.pa > 0 THEN a.xbh / a.pa ELSE NULL END, a.xbh, a.pa, 'BF', CASE WHEN a.participant_role = 'PITCHER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'PITCHER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('home_runs_allowed_per_bf', 'Home runs allowed / BF', CASE WHEN a.participant_role = 'PITCHER' AND a.pa > 0 THEN a.home_runs / a.pa ELSE NULL END, a.home_runs, a.pa, 'BF', CASE WHEN a.participant_role = 'PITCHER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'PITCHER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END),
              ('walk_rate_allowed', 'Walk rate allowed', CASE WHEN a.participant_role = 'PITCHER' AND a.pa > 0 THEN a.walks / a.pa ELSE NULL END, a.walks, a.pa, 'BF', CASE WHEN a.participant_role = 'PITCHER' AND a.pa >= $6 THEN 'AVAILABLE' WHEN a.participant_role = 'PITCHER' THEN 'INSUFFICIENT_SAMPLE' ELSE 'NOT_FOUND' END)
         ) AS m(metric_key, metric_label, value, numerator, denominator, denominator_type, sample_status)
          WHERE (a.participant_role = 'HITTER' AND m.metric_key IN ('plate_appearances', 'batting_average', 'slugging_percentage', 'xbh_per_pa', 'home_run_per_pa', 'walk_rate'))
             OR (a.participant_role = 'PITCHER' AND m.metric_key IN ('batters_faced', 'opponent_batting_average', 'opponent_slugging_percentage', 'xbh_allowed_per_bf', 'home_runs_allowed_per_bf', 'walk_rate_allowed'))
       )
       INSERT INTO player_intelligence_features
         (player_id, intelligence_run_id, source_id, research_window, effective_from, effective_to,
          dimensions, metric_key, metric_label, value, numerator, denominator, denominator_type,
           sample_size, sample_status, transformation_version, source_input_count, source_input_checksum, provenance)
       SELECT player_id, $4, $1, $5, $2, $3,
          jsonb_build_object('participantRole', participant_role, 'dayNight', day_night, 'opponentSide', opponent_side),
         metric_key, metric_label, value, numerator, denominator, denominator_type,
          pa::integer, sample_status::research_sample_status, $7, pa::integer, source_input_checksum,
         jsonb_build_object(
           'source', 'Baseball Savant / Statcast retained events',
           'eventRange', jsonb_build_object('from', $2, 'to', $3),
            'participantRole', participant_role,
            'descriptiveSplitCaveat', 'Day/night and hand splits are descriptive and retain their sample sizes; they are not causal skill claims.'
         )
       FROM metrics
        ON CONFLICT (player_id, research_window, effective_from, effective_to, metric_key, transformation_version, dimensions, source_input_checksum) DO NOTHING`,
      [STATCAST_SOURCE, scope.from, to, runId, scope.window, RATE_SAMPLE_MINIMUM, TRANSFORMATION_VERSION],
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

export async function materializeHistoricalIntelligence(input: HistoricalMaterializationInput) {
  const from = safeDate(input.from);
  const to = safeDate(input.to);
  const cursor = decodeCursor(input.cursor);
  if (from > to) throw new HistoricalIntelligenceValidationError("'from' must be on or before 'to'.");
  if (from < "2024-01-01" || to > "2026-12-31") {
    throw new HistoricalIntelligenceValidationError("Historical materialization is bounded to the configured 2024-2026 seed horizon.");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5000) {
    throw new HistoricalIntelligenceValidationError("limit must be an integer between 1 and 5000.");
  }

  await ensureSource();
  const run = await pool.query<{ intelligence_run_id: string }>(
    `INSERT INTO historical_intelligence_runs (source_id, requested_from, requested_to, status, metadata)
     VALUES ($1, $2, $3, 'RUNNING', $4)
     RETURNING intelligence_run_id`,
    [STATCAST_SOURCE, from, to, {
      bounded: true,
      backgroundOnly: true,
      sourceContract: "retained canonical-ID Statcast events only",
      transformationVersion: TRANSFORMATION_VERSION,
    }],
  );
  const runId = run.rows[0].intelligence_run_id;

  try {
    const sourceSeed = cursor || input.skipSourceSeed
      ? { targets: 0, sourceRows: 0, inserted: 0, rejected: 0, failures: [] as string[] }
      : await seedHistoricalSource(from, to);
    const batchPlusOne = await sourceEventBatch(from, to, cursor, input.limit, input.target);
    const hasMore = batchPlusOne.length > input.limit;
    const batch = batchPlusOne.slice(0, input.limit);
    const last = batch.at(-1);
    const client = await pool.connect();
    let contextsWritten = 0;
    let observationsWritten = 0;
    let featuresWritten = 0;
    try {
      await client.query("BEGIN");
      contextsWritten = await materializeContexts(batch, client);
      observationsWritten = await materializeObservations(batch, client);
      featuresWritten = await materializeFeatures(runId, from, to, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const nextCursor = hasMore && last ? encodeCursor({ date: last.game_date, eventKey: last.source_event_key }) : null;
    const status = batch.length === 0 || hasMore ? "PARTIAL" : "SUCCESS";
    await pool.query(
      `UPDATE historical_intelligence_runs
       SET status = $2, source_rows = $3, normalized_rows = $4, cursor_date = $5, finished_at = now(),
           metadata = metadata || $6::jsonb
       WHERE intelligence_run_id = $1`,
      [runId, status, batch.length, observationsWritten, last?.game_date ?? null, JSON.stringify({ contextsWritten, featuresWritten, cursor: nextCursor, hasMore, sourceSeed })],
    );
    return {
      runId,
      status: status === "SUCCESS" ? "READY" as const : "PARTIAL" as const,
      requestedFrom: from,
      requestedTo: to,
      nextCursor,
      sourceRows: batch.length,
      contextsWritten,
      observationsWritten,
      featuresWritten,
      notes: [
         "Historical intelligence uses immutable, canonical-ID Statcast events and performs at most one bounded eligible-player source load per worker step.",
         "This background operation is not part of the daily slate workflow. Source-load failures remain explicit and do not fabricate coverage.",
        "Rates retain numerator, denominator, sample size, split dimensions, and transformation version. Thin splits remain visibly insufficient.",
        ...(nextCursor ? ["Additional retained event keys remain. Continue with the opaque nextCursor before treating the requested range as complete."] : []),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE historical_intelligence_runs SET status = 'FAILED', error_message = $2, finished_at = now()
       WHERE intelligence_run_id = $1`,
      [runId, message],
    );
    throw error;
  }
}

/**
 * One durable queue step for the permanent 2024–2026 seed. The source-range
 * ledger is the queue: a range is not considered complete until the requested
 * target has feature lineage, so an API restart safely retries a source-loaded
 * but unmaterialized target.
 */
export async function runHistoricalIntelligenceBackfillStep(from = "2024-03-01", to = new Date().toISOString().slice(0, 10)) {
  if (backfillWorkerRunning) return { status: "SKIPPED" as const, reason: "A historical intelligence worker step is already running." };
  backfillWorkerRunning = true;
  let lease: BackfillLease | undefined;
  let claimedLease = false;
  try {
    const databaseLease = await pool.connect();
    lease = databaseLease;
    const claim = await databaseLease.query<{ claimed: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS claimed`,
      ["mlb-player-intelligence-backfill"],
    );
    if (!claim.rows[0]?.claimed) {
      return { status: "SKIPPED" as const, reason: "Another API instance currently owns the database-backed historical intelligence lease." };
    }
    claimedLease = true;
    const boundedTo = to > "2026-11-30" ? "2026-11-30" : to;
    await ensureSource();
    const targets = await historicalTargets(from, boundedTo, 1);
    const target = targets[0];
    if (!target) return { status: "READY" as const, reason: "All eligible canonical player ranges have a completed source receipt and derived-profile lineage." };
    const loaded = await loadHistoricalTarget(target);
    if ("error" in loaded) {
      logger.warn({ target, error: loaded.error }, "historical intelligence source load failed; range remains retryable");
      return { status: "FAILED" as const, target, reason: loaded.error };
    }

    let cursor: string | undefined;
    let batches = 0;
    let contextsWritten = 0;
    let observationsWritten = 0;
    let featuresWritten = 0;
    do {
      const result = await materializeHistoricalIntelligence({
        from: target.requested_from,
        to: target.requested_to,
        limit: 5000,
        cursor,
        target,
        skipSourceSeed: true,
      });
      cursor = result.nextCursor ?? undefined;
      contextsWritten += result.contextsWritten;
      observationsWritten += result.observationsWritten;
      featuresWritten += result.featuresWritten;
      batches += 1;
    } while (cursor && batches < 20);

    const status = cursor ? "PARTIAL" as const : (loaded.rejected ? "PARTIAL" as const : "READY" as const);
    logger.info({ target, batches, sourceRows: loaded.sourceRows, contextsWritten, observationsWritten, featuresWritten, cursor }, "historical intelligence backfill step completed");
    return { status, target, requestedTo: boundedTo, batches, sourceRows: loaded.sourceRows, contextsWritten, observationsWritten, featuresWritten, nextCursor: cursor ?? null };
  } finally {
    if (lease) {
      try {
        if (claimedLease) await lease.query(`SELECT pg_advisory_unlock(hashtext($1))`, ["mlb-player-intelligence-backfill"]);
      } finally {
        lease.release();
      }
    }
    backfillWorkerRunning = false;
  }
}

export function startHistoricalIntelligenceBackfillWorker() {
  if (process.env.ENABLE_HISTORICAL_INTELLIGENCE_WORKER === "false" || backfillWorkerStarted) return;
  backfillWorkerStarted = true;
  const tick = () => void runHistoricalIntelligenceBackfillStep()
    .catch((error) => logger.error({ err: error }, "historical intelligence backfill worker step failed"));
  setInterval(tick, 5 * 60_000).unref();
  tick();
}

export async function historicalIntelligenceCoverage(playerId: number | null) {
  const result = await pool.query<CoverageRow>(
       `SELECT min(o.observation_date)::text AS first_observation_date,
       max(o.observation_date)::text AS latest_observation_date,
        count(DISTINCT concat_ws('|', o.source_id, o.source_event_key, o.source_player_id))::int AS event_count,
       count(DISTINCT o.context_id)::int AS context_count,
       (SELECT count(*)::int FROM player_intelligence_features f
         WHERE ($1::integer IS NULL OR f.player_id = $1)) AS derived_feature_count,
       (SELECT max(f.created_at)::text FROM player_intelligence_features f
         WHERE ($1::integer IS NULL OR f.player_id = $1)) AS latest_derived_at
        ,(SELECT r.status FROM player_intelligence_features f
           JOIN historical_intelligence_runs r ON r.intelligence_run_id = f.intelligence_run_id
           WHERE ($1::integer IS NULL OR f.player_id = $1)
           ORDER BY f.created_at DESC
            LIMIT 1) AS latest_run_status
     FROM historical_player_observations o
     WHERE ($1::integer IS NULL OR o.player_id = $1)`,
    [playerId],
  );
  const horizon = await pool.query<HorizonCoverageRow>(
    `WITH current_eligibility AS (
       SELECT DISTINCT ON (pe.player_id) pe.player_id, pe.eligible_today_research, pe.eligible_pitcher_research, p.primary_position
       FROM player_eligibility pe
       JOIN players p ON p.player_id = pe.player_id
       WHERE p.active AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
         AND ($1::integer IS NULL OR pe.player_id = $1)
       ORDER BY pe.player_id, pe.effective_date DESC, pe.observed_at DESC
     ), active_roles AS (
       SELECT player_id, 'HITTER'::text AS participant_role FROM current_eligibility
       WHERE eligible_today_research AND COALESCE(primary_position, '') <> 'P'
       UNION ALL
       SELECT player_id, 'PITCHER'::text AS participant_role FROM current_eligibility
       WHERE eligible_pitcher_research AND primary_position = 'P'
     ), retained_roles AS (
       SELECT DISTINCT player_id, raw->>'participantRole' AS participant_role
       FROM historical_player_observations
       WHERE $1::integer IS NOT NULL
         AND player_id = $1
         AND raw->>'participantRole' IN ('HITTER', 'PITCHER')
     ), roles AS (
       SELECT player_id, participant_role FROM active_roles
       UNION
       SELECT player_id, participant_role FROM retained_roles
     ), season_ranges AS (
       SELECT make_date(year, 3, 1)::date AS requested_from,
         LEAST(CURRENT_DATE, make_date(year, 11, 30), DATE '2026-11-30')::date AS requested_to
       FROM generate_series(2024, LEAST(EXTRACT(YEAR FROM CURRENT_DATE)::int, 2026)) AS year
       WHERE make_date(year, 3, 1) <= LEAST(CURRENT_DATE, make_date(year, 11, 30), DATE '2026-11-30')
     ), range_status AS (
       SELECT role.player_id, role.participant_role, season.requested_from, season.requested_to,
         EXISTS(
           SELECT 1 FROM historical_source_coverage coverage
           WHERE coverage.source_id = $2
             AND coverage.player_id = role.player_id
             AND coverage.participant_role = role.participant_role
             AND coverage.status = 'SUCCESS'
             AND coverage.requested_from <= season.requested_from
             AND coverage.requested_to >= season.requested_to
             AND (
               coverage.source_rows = 0
               OR EXISTS (
                 SELECT 1 FROM player_intelligence_features feature
                 WHERE feature.player_id = role.player_id
                   AND feature.dimensions->>'participantRole' = role.participant_role
                   AND feature.effective_from <= season.requested_from
                   AND feature.effective_to >= season.requested_to
               )
             )
         ) AS completed,
         EXISTS(
           SELECT 1 FROM historical_source_coverage coverage
           WHERE coverage.source_id = $2
             AND coverage.player_id = role.player_id
             AND coverage.participant_role = role.participant_role
             AND coverage.status = 'PARTIAL'
             AND coverage.requested_from <= season.requested_from
             AND coverage.requested_to >= season.requested_to
             AND NOT EXISTS (
               SELECT 1 FROM historical_source_coverage success
               WHERE success.source_id = $2
                 AND success.player_id = role.player_id
                 AND success.participant_role = role.participant_role
                 AND success.status = 'SUCCESS'
                 AND success.requested_from <= season.requested_from
                 AND success.requested_to >= season.requested_to
                 AND (
                   success.source_rows = 0
                   OR EXISTS (
                     SELECT 1 FROM player_intelligence_features feature
                     WHERE feature.player_id = role.player_id
                       AND feature.dimensions->>'participantRole' = role.participant_role
                       AND feature.effective_from <= season.requested_from
                       AND feature.effective_to >= season.requested_to
                   )
                 )
             )
         ) AS partial
       FROM roles role CROSS JOIN season_ranges season
     )
     SELECT count(*)::int AS required_range_count,
       count(*) FILTER (WHERE completed)::int AS completed_range_count,
       count(*) FILTER (WHERE partial)::int AS partial_range_count
     FROM range_status`,
    [playerId, STATCAST_SOURCE],
  );
  const row = result.rows[0] ?? {
    first_observation_date: null, latest_observation_date: null, event_count: 0,
     context_count: 0, derived_feature_count: 0, latest_derived_at: null, latest_run_status: null,
  };
  const horizonRow = horizon.rows[0] ?? { required_range_count: 0, completed_range_count: 0, partial_range_count: 0 };
  const allRequiredRangesComplete = horizonRow.required_range_count > 0
    && horizonRow.completed_range_count === horizonRow.required_range_count
    && horizonRow.partial_range_count === 0;
  const status = row.event_count === 0
    ? "NOT_FOUND" as const
    : horizonRow.partial_range_count > 0 || !allRequiredRangesComplete
    ? "PARTIAL" as const
    : row.derived_feature_count > 0 && row.latest_run_status === "SUCCESS"
    ? "READY" as const
    : row.event_count > 0 ? "PARTIAL" as const : "NOT_FOUND" as const;
  return {
    status,
    playerId,
    firstObservationDate: row.first_observation_date,
    latestObservationDate: row.latest_observation_date,
    eventCount: row.event_count,
    contextCount: row.context_count,
    derivedFeatureCount: row.derived_feature_count,
    latestDerivedAt: row.latest_derived_at,
    notes: [
      "Coverage represents retained canonical-ID source events only. It is not a claim of complete career or league history.",
      `${horizonRow.completed_range_count}/${horizonRow.required_range_count} configured player-role season range(s) have a successful source receipt and materialized feature lineage; ${horizonRow.partial_range_count} range(s) retain partial source evidence.`,
      "Day/night and handedness splits are descriptive and preserve their samples. Missing split evidence is not replaced with overall values.",
    ],
  };
}

export class HistoricalIntelligenceValidationError extends Error {}