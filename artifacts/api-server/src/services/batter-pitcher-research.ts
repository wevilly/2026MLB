import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { PREGAME_LINEUP_SOURCE_PRECEDENCE, lineupSourceFilter } from "./lineup-sources";

const STATCAST_SOURCE = "STATCAST";
const RETROSHEET_SOURCE = "RETROSHEET";
const CAREER_START = "2008-01-01";
const MIN_CONTEXT_PA = 25;
const MAX_RANK_ADJUSTMENT = 0.25;
const STATCAST_FETCH_TIMEOUT_MS = 45_000;
const SLATE_PAIR_BATCH_SIZE = 8;
const PREGAME_LINEUP_FILTER = lineupSourceFilter(PREGAME_LINEUP_SOURCE_PRECEDENCE);

type StatcastRow = Record<string, string>;
export type BvpMarket = "TB" | "XBH" | "WALK" | "HR";

export type BvpEvidence = {
  status: "AVAILABLE" | "INSUFFICIENT_SAMPLE" | "NOT_FOUND";
  source: string;
  coverageStatus: string;
  batterId: number;
  pitcherId: number;
  effectiveTo: string;
  sampleBand: "ANECDOTE" | "WEAK_CONTEXT" | "SECONDARY_CONTEXT" | "MEANINGFUL_SUPPORT";
  pa: number;
  metrics: { avg: number | null; slg: number | null; xslg: number | null; xbh: number; homeRuns: number; walks: number; hardHitPercent: number | null; barrelPercent: number | null };
  ageDays: number;
  decayWeight: number;
  shrinkageWeight: number;
  marketSignal: number;
  rankAdjustment: number;
  arsenal: { status: "AVAILABLE" | "INSUFFICIENT_SAMPLE" | "NOT_FOUND"; summary: string; weightedXslg: number | null; pitchTypes: number };
  note: string;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

function parseCsv(text: string): StatcastRow[] {
  const cells = (line: string) => {
    const values: string[] = []; let value = ""; let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
      } else if (char === "," && !quoted) { values.push(value); value = ""; } else value += char;
    }
    values.push(value);
    return values.map((cell) => cell.trim());
  };
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = cells(lines.shift() ?? "");
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, cells(line)[index] ?? ""])));
}

function terminalKeys(rows: StatcastRow[]) {
  const terminal = new Set<string>();
  const byPlate = new Map<string, StatcastRow>();
  for (const row of rows) {
    const key = `${row.game_pk}:${row.at_bat_number}`;
    if (!row.game_pk || !row.at_bat_number) continue;
    const previous = byPlate.get(key);
    if (!previous || (asNumber(row.pitch_number) ?? 0) >= (asNumber(previous.pitch_number) ?? 0)) byPlate.set(key, row);
  }
  byPlate.forEach((_row, key) => terminal.add(key));
  return terminal;
}

function sampleBand(pa: number): BvpEvidence["sampleBand"] {
  if (pa < 10) return "ANECDOTE";
  if (pa < 25) return "WEAK_CONTEXT";
  if (pa < 50) return "SECONDARY_CONTEXT";
  return "MEANINGFUL_SUPPORT";
}

function statcastUrl(batterId: number, pitcherId: number | null, end: string) {
  const params = new URLSearchParams({
    // Date bounds, not a one-season hfSea filter, define the declared career window.
    all: "true", type: "batter", player_type: "batter", game_date_gt: CAREER_START, game_date_lt: end,
  });
  params.append("batters_lookup[]", String(batterId));
  if (pitcherId !== null) params.append("pitchers_lookup[]", String(pitcherId));
  return `https://baseballsavant.mlb.com/statcast_search/csv?${params.toString()}`;
}

async function ensureSources() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, base_url, expected_freshness_minutes, notes)
     VALUES
       ($1, 'Baseball Savant / Statcast', 'RESEARCH', 'https://baseballsavant.mlb.com', 1440, 'Canonical-ID event-level Statcast source for named batter-versus-pitcher research.'),
       ($2, 'Retrosheet adapter', 'RESEARCH', 'https://www.retrosheet.org', 525600, 'Adapter status only. No rows attach unless a canonical-ID mapping and authoritative usable feed are configured.')
     ON CONFLICT (source_id) DO UPDATE SET name = EXCLUDED.name, source_type = EXCLUDED.source_type, base_url = EXCLUDED.base_url, expected_freshness_minutes = EXCLUDED.expected_freshness_minutes, notes = EXCLUDED.notes`,
    [STATCAST_SOURCE, RETROSHEET_SOURCE],
  );
}

async function startRun(effectiveDate: string) {
  const result = await pool.query<{ ingest_run_id: string }>(
    `INSERT INTO ingest_runs (source_id, job_name, status, effective_date) VALUES ($1, 'statcast_batter_pitcher', 'RUNNING', $2) RETURNING ingest_run_id`,
    [STATCAST_SOURCE, effectiveDate],
  );
  return result.rows[0].ingest_run_id;
}

async function finishRun(runId: string, status: "SUCCESS" | "PARTIAL" | "FAILED", rowCount: number, normalized: number, rejected: number, error: string | null) {
  await pool.query(
    `UPDATE ingest_runs SET status = $2, finished_at = now(), row_count = $3, normalized_row_count = $4, rejected_row_count = $5, error_message = $6,
      metadata = $7 WHERE ingest_run_id = $1`,
    [runId, status, rowCount, normalized, rejected, error, { sourcePolicy: "Statcast current history; Retrosheet is explicitly unavailable until an authoritative mapped adapter exists." }],
  );
}

async function requireCanonicalPair(batterId: number, pitcherId: number) {
  const result = await pool.query<{ player_id: number }>(
    `SELECT player_id FROM players WHERE player_id = ANY($1::int[])`,
    [[batterId, pitcherId]],
  );
  if (result.rows.length !== 2) throw new Error("Batter-vs-pitcher research requires two resolved canonical MLB player IDs; name-only joins are prohibited.");
}

async function storeRaw(runId: string, effectiveDate: string, payload: string, endpoint: string, kind: string) {
  const result = await pool.query<{ raw_payload_id: string }>(
    `INSERT INTO raw_payloads (ingest_run_id, source_id, payload_type, effective_date, checksum, byte_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING raw_payload_id`,
    [runId, STATCAST_SOURCE, kind, effectiveDate, hash(payload), Buffer.byteLength(payload), { endpoint, effectiveDate, source: "Statcast Search", canonicalIdsOnly: true }],
  );
  return result.rows[0].raw_payload_id;
}

async function persistEvents(rows: StatcastRow[], batterId: number, pitcherId: number, rawPayloadId: string) {
  const terminal = terminalKeys(rows);
  let inserted = 0;
  for (const row of rows) {
    if (asNumber(row.batter) !== batterId || asNumber(row.pitcher) !== pitcherId || !row.game_date) continue;
    const key = `${row.game_pk}:${row.at_bat_number}:${row.pitch_number}`;
    if (!row.game_pk || !row.at_bat_number || !row.pitch_number) continue;
    const contentChecksum = hash(row);
    const result = await pool.query(
      `INSERT INTO batter_pitcher_events
       (source_id, source_event_key, raw_payload_id, batter_id, pitcher_id, game_pk, game_date, at_bat_number, pitch_number, is_terminal_plate_appearance,
        event_type, pitch_type, release_speed, horizontal_movement, vertical_movement, launch_speed, launch_angle, estimated_ba, estimated_slg, raw, content_checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (source_id, source_event_key, content_checksum) DO NOTHING`,
      [STATCAST_SOURCE, key, rawPayloadId, batterId, pitcherId, asNumber(row.game_pk), row.game_date, asNumber(row.at_bat_number), asNumber(row.pitch_number),
        terminal.has(`${row.game_pk}:${row.at_bat_number}`) && (asNumber(row.pitch_number) ?? 0) === Math.max(...rows.filter((candidate) => candidate.game_pk === row.game_pk && candidate.at_bat_number === row.at_bat_number).map((candidate) => asNumber(candidate.pitch_number) ?? 0)),
        row.events || null, row.pitch_type || null, asNumber(row.release_speed), asNumber(row.pfx_x), asNumber(row.pfx_z), asNumber(row.launch_speed), asNumber(row.launch_angle),
        asNumber(row.estimated_ba_using_speedangle), asNumber(row.estimated_slg_using_speedangle), row, contentChecksum],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

function eventRollup(rows: Array<{ event_type: string | null; launch_speed: string | null; estimated_slg: string | null; estimated_ba: string | null }>) {
  const events = rows.map((row) => String(row.event_type ?? "").toLowerCase());
  const count = (event: string) => events.filter((value) => value === event).length;
  const hitCount = count("single") + count("double") + count("triple") + count("home_run");
  const walks = count("walk") + count("intent_walk");
  const nonAb = new Set(["walk", "intent_walk", "hit_by_pitch", "sac_bunt", "sac_fly", "catcher_interf"]);
  const ab = events.filter((event) => !nonAb.has(event)).length;
  const totalBases = count("single") + 2 * count("double") + 3 * count("triple") + 4 * count("home_run");
  const batted = rows.filter((row) => asNumber(row.launch_speed) !== null);
  const average = (field: "estimated_slg" | "estimated_ba") => {
    const values = rows.map((row) => asNumber(row[field])).filter((value): value is number => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  };
  return {
    pa: rows.length, ab, hits: hitCount, totalBases, xbh: count("double") + count("triple") + count("home_run"), homeRuns: count("home_run"), walks,
    strikeouts: count("strikeout") + count("strikeout_double_play"), avg: ab ? hitCount / ab : null, slg: ab ? totalBases / ab : null,
    xslg: average("estimated_slg"), xwoba: null, woba: null,
    hardHitPercent: batted.length ? (batted.filter((row) => (asNumber(row.launch_speed) ?? 0) >= 95).length / batted.length) * 100 : null,
    barrelPercent: null,
  };
}

async function snapshotPair(batterId: number, pitcherId: number, effectiveDate: string, runId: string, rawPayloadId: string) {
  const terminal = await pool.query<{ event_type: string | null; launch_speed: string | null; estimated_slg: string | null; estimated_ba: string | null; game_date: string; game_pk: number | null; at_bat_number: number | null }>(
    `SELECT event_type, launch_speed, estimated_slg, estimated_ba, game_date::text, game_pk, at_bat_number
     FROM (
       SELECT DISTINCT ON (source_event_key) event_type, launch_speed, estimated_slg, estimated_ba, game_date, game_pk, at_bat_number, is_terminal_plate_appearance
       FROM batter_pitcher_events
       WHERE batter_id = $1 AND pitcher_id = $2 AND game_date <= $3
       ORDER BY source_event_key, retrieved_at DESC, event_id DESC
     ) latest_revision
     WHERE is_terminal_plate_appearance
     ORDER BY game_date, game_pk, at_bat_number`,
    [batterId, pitcherId, effectiveDate],
  );
  const rows = terminal.rows;
  const metrics = eventRollup(rows);
  const first = rows[0]?.game_date ?? effectiveDate;
  const last = rows.at(-1)?.game_date ?? effectiveDate;
  const ageDays = Math.max(0, Math.floor((Date.parse(`${effectiveDate}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000));
  const decayWeight = Math.exp(-ageDays / 730);
  const shrinkageWeight = Math.min(1, metrics.pa / 100);
  const checksum = hash({ batterId, pitcherId, effectiveDate, metrics, first, last });
  await pool.query(
    `INSERT INTO batter_pitcher_snapshots
     (batter_id,pitcher_id,source_id,ingest_run_id,raw_payload_id,effective_from,effective_to,seasons,pa,ab,hits,total_bases,xbh,home_runs,walks,strikeouts,avg,slg,xslg,woba,xwoba,hard_hit_percent,barrel_percent,sample_band,age_days,decay_weight,shrinkage_weight,content_checksum,provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
     ON CONFLICT (batter_id,pitcher_id,effective_to,content_checksum) DO NOTHING`,
    [batterId, pitcherId, STATCAST_SOURCE, runId, rawPayloadId, first, effectiveDate, [...new Set(rows.map((row) => Number(row.game_date.slice(0, 4))))],
      metrics.pa, metrics.ab, metrics.hits, metrics.totalBases, metrics.xbh, metrics.homeRuns, metrics.walks, metrics.strikeouts, metrics.avg, metrics.slg, metrics.xslg,
      metrics.woba, metrics.xwoba, metrics.hardHitPercent, metrics.barrelPercent, sampleBand(metrics.pa), ageDays, decayWeight, shrinkageWeight, checksum,
      { source: "Statcast Search", historicalCoverage: { statcast: "AVAILABLE", retrosheet: "NOT_CONFIGURED" }, sourceRows: rows.length, cutoff: effectiveDate, noNameJoin: true }],
  );
}

async function snapshotBatterPitchTypes(batterId: number, rows: StatcastRow[], effectiveDate: string, runId: string, rawPayloadId: string) {
  const grouped = new Map<string, StatcastRow[]>();
  for (const row of rows) {
    const pitchType = row.pitch_type;
    if (!pitchType || asNumber(row.batter) !== batterId) continue;
    grouped.set(pitchType, [...(grouped.get(pitchType) ?? []), row]);
  }
  const checksum = hash({ batterId, effectiveDate, groups: [...grouped.entries()].map(([pitch, values]) => [pitch, values.length]) });
  const snapshot = await pool.query<{ snapshot_id: string }>(
    `INSERT INTO batter_pitch_type_snapshots (batter_id,source_id,ingest_run_id,raw_payload_id,effective_from,effective_to,content_checksum,provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING snapshot_id`,
    [batterId, STATCAST_SOURCE, runId, rawPayloadId, CAREER_START, effectiveDate, checksum, { source: "Statcast Search", cutoff: effectiveDate, purpose: "Batter performance against pitch types for starter-arsenal comparison" }],
  );
  for (const [pitchType, values] of grouped) {
    const terminal = terminalKeys(values);
    const plates = values.filter((row) => terminal.has(`${row.game_pk}:${row.at_bat_number}`) && (row.events || ""));
    const metrics = eventRollup(plates.map((row) => ({ event_type: row.events || null, launch_speed: row.launch_speed || null, estimated_slg: row.estimated_slg_using_speedangle || null, estimated_ba: row.estimated_ba_using_speedangle || null })));
    await pool.query(
      `INSERT INTO batter_pitch_type_features (snapshot_id,pitch_type,pitches,plate_appearances,avg,slg,xslg,xwoba,whiff_percent,hard_hit_percent,sample_status,provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [snapshot.rows[0].snapshot_id, pitchType, values.length, plates.length, metrics.avg, metrics.slg, metrics.xslg, metrics.xwoba, null, metrics.hardHitPercent,
        values.length < 25 ? "INSUFFICIENT_SAMPLE" : "AVAILABLE", { source: "Statcast Search", cutoff: effectiveDate, pitchType }],
    );
  }
}

export async function refreshBatterPitcherPair(batterId: number, pitcherId: number, effectiveDate: string) {
  await ensureSources();
  await requireCanonicalPair(batterId, pitcherId);
  const runId = await startRun(effectiveDate);
  let rowCount = 0; let normalized = 0; let rejected = 0;
  try {
    const [pairResponse, batterResponse] = await Promise.all([
      fetch(statcastUrl(batterId, pitcherId, effectiveDate), {
        headers: { accept: "text/csv,text/plain", "user-agent": "MLBAnalystResearch/1.0" },
        signal: AbortSignal.timeout(STATCAST_FETCH_TIMEOUT_MS),
      }),
      fetch(statcastUrl(batterId, null, effectiveDate), {
        headers: { accept: "text/csv,text/plain", "user-agent": "MLBAnalystResearch/1.0" },
        signal: AbortSignal.timeout(STATCAST_FETCH_TIMEOUT_MS),
      }),
    ]);
    const [pairPayload, batterPayload] = await Promise.all([pairResponse.text(), batterResponse.text()]);
    if (!pairResponse.ok || !batterResponse.ok) throw new Error(`Statcast BvP request failed (pair ${pairResponse.status}; batter pitch-type ${batterResponse.status}).`);
    const pairRows = parseCsv(pairPayload);
    const batterRows = parseCsv(batterPayload);
    rowCount = pairRows.length + batterRows.length;
    const [pairRaw, batterRaw] = await Promise.all([
      storeRaw(runId, effectiveDate, pairPayload, statcastUrl(batterId, pitcherId, effectiveDate), "statcast_batter_pitcher_pair_csv"),
      storeRaw(runId, effectiveDate, batterPayload, statcastUrl(batterId, null, effectiveDate), "statcast_batter_pitch_type_csv"),
    ]);
    normalized = await persistEvents(pairRows, batterId, pitcherId, pairRaw);
    await snapshotPair(batterId, pitcherId, effectiveDate, runId, pairRaw);
    await snapshotBatterPitchTypes(batterId, batterRows, effectiveDate, runId, batterRaw);
    await finishRun(runId, "SUCCESS", rowCount, normalized, rejected, null);
    return { ingestRunId: runId, status: "SUCCESS" as const, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "FAILED", rowCount, normalized, rejected + 1, message);
    throw error;
  }
}

export async function refreshBatterPitcherSlate(effectiveDate: string) {
  const pairs = await pool.query<{ batter_id: number; pitcher_id: number }>(
    `WITH accepted AS (
       SELECT * FROM unnest($2::text[], $3::text[]) AS source_state(source_id, state)
     ), latest_lineup AS (
       SELECT DISTINCT ON (ls.game_pk, ls.team_id) ls.lineup_snapshot_id, ls.game_pk, ls.team_id
       FROM lineup_snapshots ls JOIN games g ON g.game_pk = ls.game_pk
       JOIN accepted a ON a.source_id = ls.source_id AND a.state = ls.state::text
       WHERE g.game_date = $1
       ORDER BY ls.game_pk, ls.team_id,
         array_position($2::text[], ls.source_id),
         ls.observed_at DESC
     ), latest_starter AS (
       SELECT DISTINCT ON (s.game_pk, s.team_id) s.game_pk, s.team_id, s.player_id
       FROM starters s JOIN games g ON g.game_pk = s.game_pk
       WHERE g.game_date = $1 AND s.player_id IS NOT NULL ORDER BY s.game_pk, s.team_id, s.observed_at DESC
     )
     SELECT DISTINCT le.player_id AS batter_id, opponent.player_id AS pitcher_id
     FROM latest_lineup ll JOIN lineup_entries le ON le.lineup_snapshot_id = ll.lineup_snapshot_id
     JOIN games g ON g.game_pk = ll.game_pk
     JOIN latest_starter opponent ON opponent.game_pk = g.game_pk AND opponent.team_id <> ll.team_id
     WHERE le.player_id IS NOT NULL`,
    [effectiveDate, PREGAME_LINEUP_FILTER.sourceIds, PREGAME_LINEUP_FILTER.states],
  );
  const results: Array<{ batterId: number; pitcherId: number; status: string }> = [];
  for (let index = 0; index < pairs.rows.length; index += SLATE_PAIR_BATCH_SIZE) {
    const batch = pairs.rows.slice(index, index + SLATE_PAIR_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (pair) => {
      try { await refreshBatterPitcherPair(pair.batter_id, pair.pitcher_id, effectiveDate); return { batterId: pair.batter_id, pitcherId: pair.pitcher_id, status: "SUCCESS" }; }
      catch { return { batterId: pair.batter_id, pitcherId: pair.pitcher_id, status: "FAILED" }; }
    }));
    results.push(...batchResults);
  }
  return { effectiveDate, pairsRequested: pairs.rows.length, pairsRefreshed: results.filter((result) => result.status === "SUCCESS").length, failures: results.filter((result) => result.status === "FAILED").length, results };
}

function numeric(value: string | number | null) { return value === null ? null : Number(value); }
export function bvpAgeDaysAtAsOf(snapshotAgeDays: number, snapshotEffectiveTo: string, effectiveDate: string) {
  const elapsedDays = Math.max(0, Math.floor(
    (Date.parse(`${effectiveDate}T00:00:00Z`) - Date.parse(`${snapshotEffectiveTo}T00:00:00Z`)) / 86_400_000,
  ));
  return snapshotAgeDays + elapsedDays;
}
function marketSignal(snapshot: { pa: number; slg: string | null; xslg: string | null; xbh: number; home_runs: number; walks: number }, market: BvpMarket) {
  if (!snapshot.pa) return 0;
  if (market === "WALK") return (snapshot.walks / snapshot.pa) - 0.08;
  if (market === "TB") return ((numeric(snapshot.slg) ?? 0.4) - 0.4) + ((numeric(snapshot.xslg) ?? 0.4) - 0.4);
  if (market === "HR") return (snapshot.home_runs / snapshot.pa) - 0.035 + ((numeric(snapshot.xslg) ?? 0.4) - 0.4);
  return (snapshot.xbh / snapshot.pa) - 0.08 + ((numeric(snapshot.xslg) ?? 0.4) - 0.4);
}

async function arsenalEvidence(batterId: number, pitcherId: number, effectiveDate: string): Promise<BvpEvidence["arsenal"]> {
  const result = await pool.query<{ pitch_type: string; usage_percent: string | null; xslg: string | null; sample_status: string }>(
    `WITH pitcher_arsenal AS (
       SELECT DISTINCT ON (pa.pitch_type) pa.pitch_type, pa.usage_percent
       FROM pitch_arsenal_features pa JOIN pitcher_research_snapshots ps ON ps.research_snapshot_id = pa.research_snapshot_id
       WHERE ps.player_id = $1 AND ps.effective_to <= $3 ORDER BY pa.pitch_type, ps.effective_to DESC, ps.retrieved_at DESC
     ), batter_snapshot AS (
       SELECT DISTINCT ON (batter_id) snapshot_id FROM batter_pitch_type_snapshots
       WHERE batter_id = $2 AND effective_to <= $3 ORDER BY batter_id, effective_to DESC, created_at DESC
     )
     SELECT pa.pitch_type, pa.usage_percent, bf.xslg, bf.sample_status
     FROM pitcher_arsenal pa LEFT JOIN batter_snapshot bs ON true LEFT JOIN batter_pitch_type_features bf ON bf.snapshot_id = bs.snapshot_id AND bf.pitch_type = pa.pitch_type`,
    [pitcherId, batterId, effectiveDate],
  );
  const usable = result.rows.filter((row) => row.xslg !== null && row.sample_status === "AVAILABLE" && numeric(row.usage_percent) !== null);
  if (!result.rows.length) return { status: "NOT_FOUND", summary: "Starter arsenal or batter pitch-type coverage is not available as of this date.", weightedXslg: null, pitchTypes: 0 };
  if (!usable.length) return { status: "INSUFFICIENT_SAMPLE", summary: "Starter arsenal exists, but batter pitch-type history is too thin for a secondary comparison.", weightedXslg: null, pitchTypes: result.rows.length };
  const usage = usable.reduce((total, row) => total + (numeric(row.usage_percent) ?? 0), 0);
  const weightedXslg = usage ? usable.reduce((total, row) => total + (numeric(row.xslg) ?? 0) * (numeric(row.usage_percent) ?? 0), 0) / usage : null;
  return { status: "AVAILABLE", summary: `Current starter arsenal compared with ${usable.length} covered batter pitch type${usable.length === 1 ? "" : "s"}.`, weightedXslg, pitchTypes: usable.length };
}

export async function getBatterPitcherEvidence(batterId: number, pitcherId: number, effectiveDate: string, market: BvpMarket): Promise<BvpEvidence> {
  const snapshotResult = await pool.query<{
    effective_to: string; sample_band: BvpEvidence["sampleBand"]; pa: number; avg: string | null; slg: string | null; xslg: string | null; xbh: number; home_runs: number; walks: number; hard_hit_percent: string | null; barrel_percent: string | null; age_days: number; decay_weight: string; shrinkage_weight: string;
  }>(
    `SELECT effective_to::text, sample_band, pa, avg, slg, xslg, xbh, home_runs, walks, hard_hit_percent, barrel_percent, age_days, decay_weight, shrinkage_weight
     FROM batter_pitcher_snapshots WHERE batter_id = $1 AND pitcher_id = $2 AND effective_to <= $3
     ORDER BY effective_to DESC, created_at DESC LIMIT 1`,
    [batterId, pitcherId, effectiveDate],
  );
  const snapshot = snapshotResult.rows[0];
  if (!snapshot) return {
    status: "NOT_FOUND", source: "Baseball Savant / Statcast", coverageStatus: "STATCAST_NO_PAIR_SNAPSHOT; RETROSHEET_ADAPTER_NOT_CONFIGURED",
    batterId, pitcherId, effectiveTo: effectiveDate, sampleBand: "ANECDOTE", pa: 0,
    metrics: { avg: null, slg: null, xslg: null, xbh: 0, homeRuns: 0, walks: 0, hardHitPercent: null, barrelPercent: null },
    ageDays: 0, decayWeight: 0, shrinkageWeight: 0, marketSignal: 0, rankAdjustment: 0,
    arsenal: await arsenalEvidence(batterId, pitcherId, effectiveDate),
    note: "No named-pair snapshot exists as of the requested date. The app does not fall forward or infer BvP from names.",
  };
  const rawSignal = marketSignal(snapshot, market);
  const smallSample = snapshot.pa < MIN_CONTEXT_PA;
  const ageDays = bvpAgeDaysAtAsOf(snapshot.age_days, snapshot.effective_to, effectiveDate);
  const age = Math.exp(-ageDays / 730);
  const shrinkage = numeric(snapshot.shrinkage_weight) ?? 0;
  // BvP has no score effect below 25 PA and is bounded even above it. Arsenal/current
  // skill retain precedence because this can only resolve near ties, never set a state.
  const adjustment = smallSample ? 0 : Math.max(-MAX_RANK_ADJUSTMENT, Math.min(MAX_RANK_ADJUSTMENT, rawSignal * age * shrinkage));
  const arsenal = await arsenalEvidence(batterId, pitcherId, effectiveDate);
  return {
    status: smallSample ? "INSUFFICIENT_SAMPLE" : "AVAILABLE", source: "Baseball Savant / Statcast",
    coverageStatus: "STATCAST_AVAILABLE; RETROSHEET_ADAPTER_NOT_CONFIGURED", batterId, pitcherId, effectiveTo: snapshot.effective_to,
    sampleBand: snapshot.sample_band, pa: snapshot.pa,
    metrics: { avg: numeric(snapshot.avg), slg: numeric(snapshot.slg), xslg: numeric(snapshot.xslg), xbh: snapshot.xbh, homeRuns: snapshot.home_runs, walks: snapshot.walks, hardHitPercent: numeric(snapshot.hard_hit_percent), barrelPercent: numeric(snapshot.barrel_percent) },
    ageDays, decayWeight: age, shrinkageWeight: shrinkage, marketSignal: rawSignal, rankAdjustment: adjustment, arsenal,
    note: smallSample ? `${snapshot.sample_band.replaceAll("_", " ")} (${snapshot.pa} PA): visible as context only; no ranking effect.` : `${snapshot.sample_band.replaceAll("_", " ")} (${snapshot.pa} PA): bounded secondary context; current skill and arsenal retain precedence.`,
  };
}