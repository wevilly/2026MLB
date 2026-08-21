import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

const STATCAST_SOURCE = "STATCAST";
const FANGRAPHS_SOURCE = "FANGRAPHS";
const PARK_SOURCE = "PARK_FACTORS";

type JsonObject = Record<string, unknown>;
type ResearchWindow = "SEASON" | "CAREER" | "ROLLING_7" | "ROLLING_14" | "ROLLING_30" | "ROLLING_60";
type ResearchRole = "HITTER" | "PITCHER";
type MetricRow = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  denominator: number | null;
  sampleSize: number | null;
  source: string;
  definition: string;
  transformation: "RAW" | "NORMALIZED" | "DERIVED" | "HEURISTIC";
  status: "AVAILABLE" | "INSUFFICIENT_SAMPLE" | "NOT_FOUND" | "QUARANTINED";
  retrievedAt: string;
};

const hitterCatalog: Array<[string, string, string, string]> = [
  ["opportunity", "games", "Games", "count"],
  ["opportunity", "pa", "Plate appearances", "PA"],
  ["opportunity", "ab", "At bats", "AB"],
  ["core_offense", "avg", "AVG", "rate"],
  ["core_offense", "obp", "OBP", "rate"],
  ["core_offense", "slg", "SLG", "rate"],
  ["core_offense", "ops", "OPS", "rate"],
  ["core_offense", "iso", "ISO", "rate"],
  ["core_offense", "woba", "wOBA", "rate"],
  ["core_offense", "xba", "xBA", "rate"],
  ["core_offense", "xslg", "xSLG", "rate"],
  ["core_offense", "xwoba", "xwOBA", "rate"],
  ["contact", "k_percent", "K%", "%"],
  ["contact", "contact_percent", "Contact%", "%"],
  ["contact", "z_contact_percent", "Z-Contact%", "%"],
  ["contact", "o_contact_percent", "O-Contact%", "%"],
  ["contact", "swstr_percent", "Swinging-strike%", "%"],
  ["contact", "ld_percent", "Line-drive%", "%"],
  ["contact", "gb_percent", "Ground-ball%", "%"],
  ["contact", "fb_percent", "Fly-ball%", "%"],
  ["damage", "avg_ev", "Average exit velocity", "mph"],
  ["damage", "hard_hit_percent", "Hard-hit%", "%"],
  ["damage", "barrels", "Barrels", "count"],
  ["damage", "barrel_percent", "Barrel%", "%"],
  ["damage", "barrel_pa", "Barrels / PA", "%"],
  ["damage", "launch_angle", "Launch angle", "degrees"],
  ["damage", "sweet_spot_percent", "Sweet-spot%", "%"],
  ["damage", "pull_percent", "Pull%", "%"],
  ["damage", "center_percent", "Center%", "%"],
  ["damage", "oppo_percent", "Opposite-field%", "%"],
  ["xbh", "singles", "Singles", "count"],
  ["xbh", "doubles", "Doubles", "count"],
  ["xbh", "triples", "Triples", "count"],
  ["xbh", "home_runs", "Home runs", "count"],
  ["xbh", "xbh", "Extra-base hits", "count"],
  ["xbh", "xbh_per_pa", "XBH / PA", "rate"],
  ["discipline", "bb_percent", "BB%", "%"],
  ["discipline", "o_swing_percent", "Chase / O-Swing%", "%"],
  ["discipline", "z_swing_percent", "Z-Swing%", "%"],
  ["discipline", "zone_percent", "Zone%", "%"],
  ["discipline", "f_strike_percent", "First-pitch strike%", "%"],
  ["discipline", "pitches_per_pa", "Pitches / PA", "count"],
];

const pitcherCatalog: Array<[string, string, string, string]> = [
  ["workload", "games", "Games", "count"],
  ["workload", "games_started", "Games started", "count"],
  ["workload", "bf", "Batters faced", "BF"],
  ["run_prevention", "era", "ERA", "rate"],
  ["run_prevention", "fip", "FIP", "rate"],
  ["run_prevention", "xfip", "xFIP", "rate"],
  ["run_prevention", "xera", "xERA", "rate"],
  ["contact_allowed", "xba_allowed", "xBA allowed", "rate"],
  ["contact_allowed", "xslg_allowed", "xSLG allowed", "rate"],
  ["contact_allowed", "xwoba_allowed", "xwOBA allowed", "rate"],
  ["contact_allowed", "hard_hit_percent", "Hard-hit%", "%"],
  ["contact_allowed", "barrel_percent", "Barrel%", "%"],
  ["command", "k_percent", "K%", "%"],
  ["command", "bb_percent", "BB%", "%"],
  ["command", "k_minus_bb_percent", "K-BB%", "%"],
  ["command", "zone_percent", "Zone%", "%"],
  ["command", "swstr_percent", "Swinging-strike%", "%"],
  ["xbh_vulnerability", "doubles_allowed", "Doubles allowed", "count"],
  ["xbh_vulnerability", "triples_allowed", "Triples allowed", "count"],
  ["xbh_vulnerability", "home_runs_allowed", "Home runs allowed", "count"],
  ["xbh_vulnerability", "xbh_allowed", "XBH allowed", "count"],
  ["xbh_vulnerability", "xbh_per_bf", "XBH / BF", "rate"],
];

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isoValue = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? "");
const asNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim().replaceAll(",", "").replace("%", "");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

function parseCsv(text: string): Array<Record<string, string>> {
  const parseLine = (line: string) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = !quoted;
      } else if (char === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += char;
    }
    cells.push(cell);
    return cells.map((item) => item.trim());
  };
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = parseLine(lines.shift() ?? "");
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, parseLine(line)[index] ?? ""])));
}

function windowScope(window: ResearchWindow, effectiveDate: string) {
  const end = new Date(`${effectiveDate}T12:00:00Z`);
  if (window === "SEASON") return { window, from: `${end.getUTCFullYear()}-03-01`, to: effectiveDate };
  if (window === "CAREER") return { window, from: "2008-01-01", to: effectiveDate };
  const days = Number(window.replace("ROLLING_", ""));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { window, from: dateOnly(start), to: effectiveDate };
}

function csvUrl(role: ResearchRole, year: number) {
  const selections = role === "HITTER"
    ? "pa,ab,hits,single,doubles,triples,home_run,bb_percent,k_percent,avg_hit_speed,hard_hit_percent,barrel_batted_rate,barrel_pa,launch_angle,sweet_spot_percent,expected_ba,expected_slg,estimated_woba"
    : "pitches,pa,k_percent,bb_percent,avg_hit_speed,hard_hit_percent,barrel_batted_rate,expected_ba,expected_slg,estimated_woba,era,xera";
  return `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=${role === "HITTER" ? "batter" : "pitcher"}&filter=&sort=4&sortDir=desc&min=q&selections=${selections}&chart=false&x=x&csv=true`;
}

function fanGraphsUrl(role: ResearchRole, scope: ReturnType<typeof windowScope>) {
  const params = new URLSearchParams({
    pos: "all",
    stats: role === "HITTER" ? "bat" : "pit",
    type: "8",
    lg: "all",
    qual: "0",
    ind: "0",
    season: scope.to.slice(0, 4),
    season1: scope.from.slice(0, 4),
    startdate: scope.window === "CAREER" || scope.window === "SEASON" ? "" : scope.from,
    enddate: scope.window === "CAREER" || scope.window === "SEASON" ? "" : scope.to,
  });
  return `https://www.fangraphs.com/api/leaders/major-league/data?${params.toString()}`;
}

async function ensureResearchSources() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, base_url, expected_freshness_minutes, notes)
     VALUES
      ($1, 'Baseball Savant / Statcast', 'RESEARCH', 'https://baseballsavant.mlb.com', 1440, 'Public Statcast leaderboard evidence. MLBAM IDs are required for attachment.'),
      ($2, 'FanGraphs', 'RESEARCH', 'https://www.fangraphs.com', 1440, 'Public leaderboard research evidence. Definition-specific metrics remain source-labeled.'),
      ($3, 'Park Factors', 'RESEARCH', NULL, 10080, 'Park component factor storage. Missing public source coverage is surfaced as unavailable, not estimated.')
     ON CONFLICT (source_id) DO UPDATE SET name = EXCLUDED.name, source_type = EXCLUDED.source_type,
       base_url = EXCLUDED.base_url, expected_freshness_minutes = EXCLUDED.expected_freshness_minutes, notes = EXCLUDED.notes`,
    [STATCAST_SOURCE, FANGRAPHS_SOURCE, PARK_SOURCE],
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

async function finishRun(ingestRunId: string, status: "SUCCESS" | "PARTIAL" | "FAILED", counts: { rows: number; normalized: number; rejected: number; httpStatus?: number; error?: string; metadata?: JsonObject }, started: number) {
  await pool.query(
    `UPDATE ingest_runs SET finished_at = now(), status = $2, row_count = $3, normalized_row_count = $4,
       rejected_row_count = $5, http_status = $6, duration_ms = $7, error_message = $8, metadata = $9
     WHERE ingest_run_id = $1`,
    [ingestRunId, status, counts.rows, counts.normalized, counts.rejected, counts.httpStatus ?? null, Date.now() - started, counts.error ?? null, counts.metadata ?? {}],
  );
}

async function storeRaw(ingestRunId: string, sourceId: string, payloadType: string, effectiveDate: string, payload: unknown, endpoint: string, scope: JsonObject) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const result = await pool.query<{ raw_payload_id: string }>(
    `INSERT INTO raw_payloads (ingest_run_id, source_id, payload_type, effective_date, checksum, byte_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING raw_payload_id`,
    [ingestRunId, sourceId, payloadType, effectiveDate, hash(payload), Buffer.byteLength(body), { endpoint, scope, payload }],
  );
  return result.rows[0].raw_payload_id;
}

async function canonicalPlayer(playerId: number, effectiveDate: string, role: ResearchRole) {
  const result = await pool.query<{ player_id: number; status: string; quarantined_from_current_research: boolean }>(
    `SELECT p.player_id, pe.status, pe.quarantined_from_current_research
     FROM players p JOIN player_eligibility pe ON pe.player_id = p.player_id
     WHERE p.player_id = $1 AND pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = $2
       AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
       AND CASE WHEN $3 = 'HITTER' THEN pe.eligible_today_research ELSE pe.eligible_pitcher_research END
     ORDER BY pe.observed_at DESC LIMIT 1`,
    [playerId, effectiveDate, role],
  );
  const row = result.rows[0];
  return row && !row.quarantined_from_current_research ? row : null;
}

async function quarantineResearchRow(ingestRunId: string, sourceId: string, externalPlayerId: string | null, rawName: string | null, reason: string, rawEvidence: JsonObject) {
  await pool.query(
    `INSERT INTO research_identity_quarantine (ingest_run_id, source_id, external_player_id, raw_name, reason, raw_evidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ingestRunId, sourceId, externalPlayerId, rawName, reason, rawEvidence],
  );
}

function sourceMetric(family: string, key: string, label: string, value: unknown, unit: string, denominator: number | null, sampleSize: number | null, source: string, definition: string, transformation: MetricRow["transformation"] = "NORMALIZED"): MetricRow {
  const parsed = asNumber(value);
  return {
    key,
    label,
    value: parsed,
    unit,
    denominator,
    sampleSize,
    source,
    definition,
    transformation,
    status: parsed === null ? "NOT_FOUND" : (sampleSize !== null && sampleSize < 10 ? "INSUFFICIENT_SAMPLE" : "AVAILABLE"),
    retrievedAt: new Date().toISOString(),
  };
}

function hitterMetrics(row: JsonObject, source: string): Array<{ family: string; metric: MetricRow }> {
  const pa = asNumber(row.PA ?? row.pa);
  const ab = asNumber(row.AB ?? row.ab);
  const doubles = asNumber(row["2B"] ?? row.doubles);
  const triples = asNumber(row["3B"] ?? row.triples);
  const homers = asNumber(row.HR ?? row.home_run);
  const singles = asNumber(row["1B"] ?? row.single);
  const xbh = [doubles, triples, homers].every((value) => value !== null) ? (doubles ?? 0) + (triples ?? 0) + (homers ?? 0) : null;
  const map: Array<[string, string, string, unknown, string, string, MetricRow["transformation"]?]> = [
    ["opportunity", "games", "Games", row.G, "count", "Games played."],
    ["opportunity", "pa", "Plate appearances", pa, "PA", "Plate appearances."],
    ["opportunity", "ab", "At bats", ab, "AB", "At bats."],
    ["core_offense", "avg", "AVG", row.AVG, "rate", "Batting average."],
    ["core_offense", "obp", "OBP", row.OBP, "rate", "On-base percentage."],
    ["core_offense", "slg", "SLG", row.SLG, "rate", "Slugging percentage."],
    ["core_offense", "ops", "OPS", row.OPS, "rate", "On-base plus slugging."],
    ["core_offense", "iso", "ISO", row.ISO, "rate", "Isolated power."],
    ["core_offense", "woba", "wOBA", row.wOBA, "rate", "Source-defined weighted on-base average."],
    ["core_offense", "xba", "xBA", row.xAVG ?? row.expected_ba, "rate", "Expected batting average."],
    ["core_offense", "xslg", "xSLG", row.xSLG ?? row.expected_slg, "rate", "Expected slugging percentage."],
    ["core_offense", "xwoba", "xwOBA", row.xwOBA ?? row.estimated_woba, "rate", "Expected weighted on-base average."],
    ["contact", "k_percent", "K%", row["K%"] ?? row.k_percent, "%", "Strikeout percentage."],
    ["contact", "contact_percent", "Contact%", row["Contact%"], "%", "Contact percentage."],
    ["contact", "z_contact_percent", "Z-Contact%", row["Z-Contact%"], "%", "Zone contact percentage."],
    ["contact", "o_contact_percent", "O-Contact%", row["O-Contact%"], "%", "Out-of-zone contact percentage."],
    ["contact", "swstr_percent", "Swinging-strike%", row["SwStr%"], "%", "Swinging-strike percentage."],
    ["contact", "ld_percent", "Line-drive%", row["LD%"], "%", "Line-drive percentage."],
    ["contact", "gb_percent", "Ground-ball%", row["GB%"], "%", "Ground-ball percentage."],
    ["contact", "fb_percent", "Fly-ball%", row["FB%"], "%", "Fly-ball percentage."],
    ["damage", "avg_ev", "Average exit velocity", row.EV ?? row.avg_hit_speed, "mph", "Average exit velocity."],
    ["damage", "hard_hit_percent", "Hard-hit%", row["HardHit%"] ?? row.hard_hit_percent, "%", "Hard-hit percentage."],
    ["damage", "barrels", "Barrels", row.Barrels, "count", "Batted balls classified as barrels."],
    ["damage", "barrel_percent", "Barrel%", row["Barrel%"] ?? row.barrel_batted_rate, "%", "Barrel rate."],
    ["damage", "barrel_pa", "Barrels / PA", row.barrel_pa, "%", "Barrels per plate appearance."],
    ["damage", "launch_angle", "Launch angle", row.LA ?? row.launch_angle, "degrees", "Average launch angle."],
    ["damage", "sweet_spot_percent", "Sweet-spot%", row.sweet_spot_percent, "%", "Sweet-spot percentage."],
    ["damage", "pull_percent", "Pull%", row["Pull%"], "%", "Pull percentage."],
    ["damage", "center_percent", "Center%", row["Cent%"], "%", "Center-field percentage."],
    ["damage", "oppo_percent", "Opposite-field%", row["Oppo%"], "%", "Opposite-field percentage."],
    ["xbh", "singles", "Singles", singles, "count", "Singles. Excluded from XBH.", "RAW"],
    ["xbh", "doubles", "Doubles", doubles, "count", "Doubles.", "RAW"],
    ["xbh", "triples", "Triples", triples, "count", "Triples.", "RAW"],
    ["xbh", "home_runs", "Home runs", homers, "count", "Home runs.", "RAW"],
    ["xbh", "xbh", "Extra-base hits", xbh, "count", "Derived as doubles + triples + home runs. Singles excluded.", "DERIVED"],
    ["xbh", "xbh_per_pa", "XBH / PA", xbh !== null && pa ? xbh / pa : null, "rate", "Derived XBH per plate appearance.", "DERIVED"],
    ["discipline", "bb_percent", "BB%", row["BB%"] ?? row.bb_percent, "%", "Walk percentage."],
    ["discipline", "o_swing_percent", "Chase / O-Swing%", row["O-Swing%"], "%", "Out-of-zone swing percentage."],
    ["discipline", "z_swing_percent", "Z-Swing%", row["Z-Swing%"], "%", "In-zone swing percentage."],
    ["discipline", "zone_percent", "Zone%", row["Zone%"], "%", "Pitches in the zone."],
    ["discipline", "f_strike_percent", "First-pitch strike%", row["F-Strike%"], "%", "First-pitch strike percentage."],
    ["discipline", "pitches_per_pa", "Pitches / PA", row.Pitches && pa ? (asNumber(row.Pitches) ?? 0) / pa : null, "count", "Pitches per plate appearance.", "DERIVED"],
  ];
  return map.map(([family, key, label, value, unit, definition, transformation]) => ({
    family,
    metric: sourceMetric(family, key, label, value, unit, pa, pa, source, definition, transformation),
  }));
}

function pitcherMetrics(row: JsonObject, source: string): Array<{ family: string; metric: MetricRow }> {
  const bf = asNumber(row.BF ?? row.PA ?? row.pa);
  const k = asNumber(row["K%"] ?? row.k_percent);
  const bb = asNumber(row["BB%"] ?? row.bb_percent);
  const doubles = asNumber(row["2B"] ?? row.doubles);
  const triples = asNumber(row["3B"] ?? row.triples);
  const homers = asNumber(row.HR ?? row.home_run);
  const xbh = [doubles, triples, homers].every((value) => value !== null) ? (doubles ?? 0) + (triples ?? 0) + (homers ?? 0) : null;
  const map: Array<[string, string, string, unknown, string, string, MetricRow["transformation"]?]> = [
    ["workload", "games", "Games", row.G, "count", "Games pitched."],
    ["workload", "games_started", "Games started", row.GS, "count", "Games started."],
    ["workload", "bf", "Batters faced", bf, "BF", "Batters faced."],
    ["run_prevention", "era", "ERA", row.ERA ?? row.era, "rate", "Earned run average."],
    ["run_prevention", "fip", "FIP", row.FIP, "rate", "FanGraphs fielding independent pitching."],
    ["run_prevention", "xfip", "xFIP", row.xFIP, "rate", "FanGraphs expected FIP."],
    ["run_prevention", "xera", "xERA", row.xERA ?? row.xera, "rate", "Expected ERA."],
    ["contact_allowed", "xba_allowed", "xBA allowed", row.xAVG ?? row.expected_ba, "rate", "Expected batting average allowed."],
    ["contact_allowed", "xslg_allowed", "xSLG allowed", row.xSLG ?? row.expected_slg, "rate", "Expected slugging allowed."],
    ["contact_allowed", "xwoba_allowed", "xwOBA allowed", row.xwOBA ?? row.estimated_woba, "rate", "Expected wOBA allowed."],
    ["contact_allowed", "hard_hit_percent", "Hard-hit%", row["HardHit%"] ?? row.hard_hit_percent, "%", "Hard-hit percentage allowed."],
    ["contact_allowed", "barrel_percent", "Barrel%", row["Barrel%"] ?? row.barrel_batted_rate, "%", "Barrel percentage allowed."],
    ["command", "k_percent", "K%", k, "%", "Strikeout percentage."],
    ["command", "bb_percent", "BB%", bb, "%", "Walk percentage."],
    ["command", "k_minus_bb_percent", "K-BB%", k !== null && bb !== null ? k - bb : null, "%", "Derived strikeout percentage minus walk percentage.", "DERIVED"],
    ["command", "zone_percent", "Zone%", row["Zone%"], "%", "Pitches in the zone."],
    ["command", "swstr_percent", "Swinging-strike%", row["SwStr%"], "%", "Swinging-strike percentage."],
    ["xbh_vulnerability", "doubles_allowed", "Doubles allowed", doubles, "count", "Doubles allowed.", "RAW"],
    ["xbh_vulnerability", "triples_allowed", "Triples allowed", triples, "count", "Triples allowed.", "RAW"],
    ["xbh_vulnerability", "home_runs_allowed", "Home runs allowed", homers, "count", "Home runs allowed.", "RAW"],
    ["xbh_vulnerability", "xbh_allowed", "XBH allowed", xbh, "count", "Derived as doubles + triples + home runs allowed. Singles excluded.", "DERIVED"],
    ["xbh_vulnerability", "xbh_per_bf", "XBH / BF", xbh !== null && bf ? xbh / bf : null, "rate", "Derived XBH allowed per batter faced.", "DERIVED"],
  ];
  return map.map(([family, key, label, value, unit, definition, transformation]) => ({
    family,
    metric: sourceMetric(family, key, label, value, unit, bf, bf, source, definition, transformation),
  }));
}

async function persistHitterSnapshot(playerId: number, sourceId: string, ingestRunId: string, rawPayloadId: string, scope: ReturnType<typeof windowScope>, row: JsonObject) {
  const metrics = hitterMetrics(row, sourceId === STATCAST_SOURCE ? "Baseball Savant / Statcast" : "FanGraphs");
  const pa = asNumber(row.PA ?? row.pa);
  const contentChecksum = hash({ sourceId, playerId, scope, row });
  const previous = await pool.query<{ content_checksum: string }>(
    `SELECT content_checksum FROM player_research_snapshots WHERE player_id = $1 AND source_id = $2 AND research_window = $3
      ORDER BY retrieved_at DESC LIMIT 1`,
    [playerId, sourceId, scope.window],
  );
  const snapshot = await pool.query<{ research_snapshot_id: string }>(
    `INSERT INTO player_research_snapshots (player_id, source_id, ingest_run_id, raw_payload_id, research_window, effective_from, effective_to, sample_size, denominator_type, denominator, content_checksum, unchanged_from_prior, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PA', $9, $10, $11, $12) RETURNING research_snapshot_id`,
    [playerId, sourceId, ingestRunId, rawPayloadId, scope.window, scope.from, scope.to, pa, pa, contentChecksum, previous.rows[0]?.content_checksum === contentChecksum, { source: sourceId, externalPlayerId: playerId, scope }],
  );
  for (const { family, metric } of metrics) {
    await pool.query(
      `INSERT INTO player_research_features (research_snapshot_id, family, metric_key, metric_label, value, unit, denominator, sample_size, transformation, sample_status, definition, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [snapshot.rows[0].research_snapshot_id, family, metric.key, metric.label, metric.value, metric.unit, metric.denominator, metric.sampleSize, metric.transformation, metric.status, metric.definition, { source: metric.source, retrievedAt: metric.retrievedAt }],
    );
  }
}

function pitcherRole(row: JsonObject): "STARTER" | "RELIEVER" | "MIXED" | "UNKNOWN" {
  const games = asNumber(row.G);
  const starts = asNumber(row.GS);
  if (starts === null || games === null) return "UNKNOWN";
  if (starts === 0) return "RELIEVER";
  if (starts === games) return "STARTER";
  return "MIXED";
}

async function persistPitcherSnapshot(playerId: number, sourceId: string, ingestRunId: string, rawPayloadId: string, scope: ReturnType<typeof windowScope>, row: JsonObject) {
  const metrics = pitcherMetrics(row, sourceId === STATCAST_SOURCE ? "Baseball Savant / Statcast" : "FanGraphs");
  const bf = asNumber(row.BF ?? row.PA ?? row.pa);
  const contentChecksum = hash({ sourceId, playerId, scope, row });
  const previous = await pool.query<{ content_checksum: string }>(
    `SELECT content_checksum FROM pitcher_research_snapshots WHERE player_id = $1 AND source_id = $2 AND research_window = $3
      ORDER BY retrieved_at DESC LIMIT 1`,
    [playerId, sourceId, scope.window],
  );
  const snapshot = await pool.query<{ research_snapshot_id: string }>(
    `INSERT INTO pitcher_research_snapshots (player_id, source_id, ingest_run_id, raw_payload_id, research_window, role, effective_from, effective_to, sample_size, denominator_type, denominator, content_checksum, unchanged_from_prior, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'BF', $10, $11, $12, $13) RETURNING research_snapshot_id`,
    [playerId, sourceId, ingestRunId, rawPayloadId, scope.window, pitcherRole(row), scope.from, scope.to, bf, bf, contentChecksum, previous.rows[0]?.content_checksum === contentChecksum, { source: sourceId, externalPlayerId: playerId, scope }],
  );
  for (const { family, metric } of metrics) {
    await pool.query(
      `INSERT INTO pitcher_research_features (research_snapshot_id, family, metric_key, metric_label, value, unit, denominator, sample_size, transformation, sample_status, definition, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [snapshot.rows[0].research_snapshot_id, family, metric.key, metric.label, metric.value, metric.unit, metric.denominator, metric.sampleSize, metric.transformation, metric.status, metric.definition, { source: metric.source, retrievedAt: metric.retrievedAt }],
    );
  }
  if (sourceId !== FANGRAPHS_SOURCE) return;
  const pitchMap: Array<[string, string, string]> = [
    ["FA", "Four-seam fastball", "piFA%"], ["SI", "Sinker", "piSI%"], ["FC", "Cutter", "piFC%"],
    ["SL", "Slider", "piSL%"], ["CU", "Curveball", "piCU%"], ["CH", "Changeup", "piCH%"],
    ["FS", "Splitter", "piFS%"],
  ];
  for (const [pitchType, pitchName, usageKey] of pitchMap) {
    const usage = asNumber(row[usageKey]);
    if (usage === null) continue;
    await pool.query(
      `INSERT INTO pitch_arsenal_features (research_snapshot_id, pitch_type, pitch_name, usage_percent, velocity, horizontal_movement, vertical_movement, sample_size, sample_status, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE', $9)`,
      [snapshot.rows[0].research_snapshot_id, pitchType, pitchName, usage, asNumber(row[`piv${pitchType}`]), asNumber(row[`pi${pitchType}-X`]), asNumber(row[`pi${pitchType}-Z`]), bf, { source: "FanGraphs", definition: "Pitch-type values from public leaderboard fields." }],
    );
  }
}

async function ingestStatcast(effectiveDate: string) {
  const started = Date.now();
  const ingestRunId = await startRun(STATCAST_SOURCE, "statcast_research", effectiveDate);
  let rowCount = 0;
  let normalized = 0;
  let rejected = 0;
  let quarantined = 0;
  let lastStatus = 200;
  try {
    for (const role of ["HITTER", "PITCHER"] as const) {
      const endpoint = csvUrl(role, Number(effectiveDate.slice(0, 4)));
      const response = await fetch(endpoint);
      const payload = await response.text();
      lastStatus = response.status;
      if (!response.ok) throw new Error(`Statcast ${role.toLowerCase()} request returned HTTP ${response.status}`);
      const rows = parseCsv(payload);
      rowCount += rows.length;
      const rawPayloadId = await storeRaw(ingestRunId, STATCAST_SOURCE, `statcast_${role.toLowerCase()}_season_csv`, effectiveDate, payload, endpoint, { role, window: "SEASON", requestedPlayerScope: "league-wide", effectiveRange: { from: `${effectiveDate.slice(0, 4)}-03-01`, to: effectiveDate } });
      for (const raw of rows) {
        const playerId = asNumber(raw.player_id);
        if (!playerId) {
          rejected += 1;
          continue;
        }
        normalized += 1;
        const canonical = await canonicalPlayer(playerId, effectiveDate, role);
        if (!canonical) {
          quarantined += 1;
          await quarantineResearchRow(ingestRunId, STATCAST_SOURCE, String(playerId), raw["last_name, first_name"] ?? null, "canonical_identity_or_current_eligibility_not_confirmed", raw);
          continue;
        }
        const scope = windowScope("SEASON", effectiveDate);
        if (role === "HITTER") await persistHitterSnapshot(playerId, STATCAST_SOURCE, ingestRunId, rawPayloadId, scope, raw);
        else await persistPitcherSnapshot(playerId, STATCAST_SOURCE, ingestRunId, rawPayloadId, scope, raw);
      }
    }
    await finishRun(ingestRunId, quarantined ? "PARTIAL" : "SUCCESS", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, metadata: { identityReviewRequired: quarantined, actualRejected: rejected } }, started);
  } catch (error) {
    await finishRun(ingestRunId, "FAILED", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, error: error instanceof Error ? error.message : String(error) }, started);
  }
  return { source: "Baseball Savant / Statcast", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, quarantinedRows: quarantined };
}

async function ingestFanGraphs(effectiveDate: string) {
  const started = Date.now();
  const ingestRunId = await startRun(FANGRAPHS_SOURCE, "fangraphs_research", effectiveDate);
  let rowCount = 0;
  let normalized = 0;
  let rejected = 0;
  let quarantined = 0;
  let lastStatus = 200;
  try {
    for (const window of ["SEASON", "ROLLING_7", "ROLLING_14", "ROLLING_30", "ROLLING_60"] as ResearchWindow[]) {
      const scope = windowScope(window, effectiveDate);
      for (const role of ["HITTER", "PITCHER"] as const) {
        const endpoint = fanGraphsUrl(role, scope);
        const response = await fetch(endpoint);
        lastStatus = response.status;
        const payload = await response.json() as JsonObject;
        if (!response.ok) throw new Error(`FanGraphs ${role.toLowerCase()} ${window} request returned HTTP ${response.status}`);
        const rows = Array.isArray(payload.data) ? payload.data.filter((row): row is JsonObject => Boolean(row) && typeof row === "object") : [];
        rowCount += rows.length;
        const rawPayloadId = await storeRaw(ingestRunId, FANGRAPHS_SOURCE, `fangraphs_${role.toLowerCase()}_${window.toLowerCase()}`, effectiveDate, payload, endpoint, { role, window, requestedPlayerScope: "league-wide", effectiveRange: { from: scope.from, to: scope.to } });
        for (const raw of rows) {
          const playerId = asNumber(raw.xMLBAMID);
          if (!playerId) {
            rejected += 1;
            continue;
          }
          normalized += 1;
          const canonical = await canonicalPlayer(playerId, effectiveDate, role);
          if (!canonical) {
            quarantined += 1;
            await quarantineResearchRow(ingestRunId, FANGRAPHS_SOURCE, String(playerId), typeof raw.Name === "string" ? raw.Name.replace(/<[^>]*>/g, "") : null, "canonical_identity_or_current_eligibility_not_confirmed", raw);
            continue;
          }
          if (role === "HITTER") await persistHitterSnapshot(playerId, FANGRAPHS_SOURCE, ingestRunId, rawPayloadId, scope, raw);
          else await persistPitcherSnapshot(playerId, FANGRAPHS_SOURCE, ingestRunId, rawPayloadId, scope, raw);
        }
      }
    }
    await finishRun(ingestRunId, quarantined ? "PARTIAL" : "SUCCESS", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, metadata: { identityReviewRequired: quarantined, actualRejected: rejected } }, started);
  } catch (error) {
    await finishRun(ingestRunId, "FAILED", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, error: error instanceof Error ? error.message : String(error) }, started);
  }
  return { source: "FanGraphs", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, quarantinedRows: quarantined };
}

export async function ingestResearch(effectiveDate: string) {
  await ensureResearchSources();
  const [statcast, fangraphs] = await Promise.all([ingestStatcast(effectiveDate), ingestFanGraphs(effectiveDate)]);
  return {
    status: statcast.rejectedRowCount || fangraphs.rejectedRowCount || statcast.quarantinedRows || fangraphs.quarantinedRows ? "PARTIAL" : "SUCCESS",
    sources: [
      { source: statcast.source, ingestRunId: statcast.ingestRunId, rowCount: statcast.rowCount, normalizedRowCount: statcast.normalizedRowCount, rejectedRowCount: statcast.rejectedRowCount },
      { source: fangraphs.source, ingestRunId: fangraphs.ingestRunId, rowCount: fangraphs.rowCount, normalizedRowCount: fangraphs.normalizedRowCount, rejectedRowCount: fangraphs.rejectedRowCount },
    ],
    quarantinedRows: statcast.quarantinedRows + fangraphs.quarantinedRows,
    notes: [
      "Raw source responses are preserved with retrieval scope, checksum, HTTP status, row counts, and ingest run ID.",
      "Identity uncertainty is quarantined from research views and is not counted as an ingest rejection.",
      "Park component factors remain NOT FOUND until a reproducible public component source is configured; no factor is estimated.",
    ],
  };
}

function metricPlaceholder(family: string, key: string, label: string, unit: string): MetricRow {
  return { key, label, value: null, unit, denominator: null, sampleSize: null, source: "NOT FOUND", definition: "No compatible source value is available for this snapshot.", transformation: "RAW", status: "NOT_FOUND", retrievedAt: "NOT FOUND" };
}

async function labProfile(role: ResearchRole, playerId: number | null, search: string, researchWindow: ResearchWindow, effectiveDate: string) {
  const table = role === "HITTER" ? "player_research_snapshots" : "pitcher_research_snapshots";
  const featureTable = role === "HITTER" ? "player_research_features" : "pitcher_research_features";
  const profileCount = await pool.query<{ player_id: number; full_name: string; abbreviation: string | null; primary_position: string | null }>(
    `SELECT DISTINCT ON (p.player_id) p.player_id, p.full_name, t.abbreviation, p.primary_position
     FROM ${table} rs JOIN players p ON p.player_id = rs.player_id LEFT JOIN teams t ON t.team_id = p.current_team_id
      WHERE p.full_name ILIKE $1 AND rs.effective_to <= $2
      ORDER BY p.player_id, rs.effective_to DESC, rs.retrieved_at DESC LIMIT 25`,
    [`%${search}%`, effectiveDate],
  );
  const selectedId = playerId ?? profileCount.rows[0]?.player_id ?? null;
  if (!selectedId) {
    const hasRequestedAsOfDate = effectiveDate !== dateOnly(new Date());
    return {
      sourceStatus: hasRequestedAsOfDate ? "NO SNAPSHOT FOR REQUESTED AS-OF DATE" : "WAITING FOR RESEARCH INGEST",
      searchResults: [],
      profile: null,
      notices: [hasRequestedAsOfDate
        ? "No eligible source snapshot exists on or before this as-of date. The view intentionally does not fall forward to newer evidence."
        : "Run the research ingest to retrieve public Statcast and FanGraphs evidence."],
    };
  }
  const identity = await pool.query<{ player_id: number; full_name: string; abbreviation: string | null; bats: string | null; throws: string | null; primary_position: string | null; status: string | null }>(
    `SELECT p.player_id, p.full_name, t.abbreviation, p.bats, p.throws, p.primary_position, pe.status
     FROM players p LEFT JOIN teams t ON t.team_id = p.current_team_id
     LEFT JOIN player_eligibility pe ON pe.player_id = p.player_id AND pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = $2
     WHERE p.player_id = $1 ORDER BY pe.observed_at DESC NULLS LAST LIMIT 1`,
    [selectedId, effectiveDate],
  );
  const snapshotRows = await pool.query<{ research_snapshot_id: string; source_id: string; effective_from: string; effective_to: string; retrieved_at: string; role: string | null }>(
    `SELECT DISTINCT ON (source_id) research_snapshot_id, source_id, effective_from, effective_to, retrieved_at, ${role === "PITCHER" ? "role" : "NULL::text AS role"}
     FROM ${table} WHERE player_id = $1 AND research_window = $2 AND effective_to <= $3
     ORDER BY source_id, effective_to DESC, retrieved_at DESC`,
    [selectedId, researchWindow, effectiveDate],
  );
  const features = snapshotRows.rows.length ? await pool.query<{
    family: string; metric_key: string; metric_label: string; value: string | null; unit: string | null; denominator: string | null;
    sample_size: number | null; transformation: MetricRow["transformation"]; sample_status: MetricRow["status"]; definition: string; source_id: string; retrieved_at: string;
  }>(
    `SELECT f.family, f.metric_key, f.metric_label, f.value, f.unit, f.denominator, f.sample_size, f.transformation, f.sample_status, f.definition, s.source_id, s.retrieved_at
     FROM ${featureTable} f JOIN ${table} s ON s.research_snapshot_id = f.research_snapshot_id
     WHERE f.research_snapshot_id = ANY($1) ORDER BY f.family, f.metric_label, s.source_id`,
    [snapshotRows.rows.map((row) => row.research_snapshot_id)],
  ) : { rows: [] };
  const values = features.rows.map((row) => ({
    family: row.family,
    metric: {
      key: row.metric_key,
      label: row.metric_label,
      value: row.value === null ? null : Number(row.value),
      unit: row.unit ?? "",
      denominator: row.denominator === null ? null : Number(row.denominator),
      sampleSize: row.sample_size,
      source: row.source_id === STATCAST_SOURCE ? "Baseball Savant / Statcast" : "FanGraphs",
      definition: row.definition,
      transformation: row.transformation,
      status: row.sample_status,
      retrievedAt: isoValue(row.retrieved_at),
    } satisfies MetricRow,
  }));
  const catalog = role === "HITTER" ? hitterCatalog : pitcherCatalog;
  const familyOrder = [...new Set(catalog.map(([family]) => family))];
  const panels = familyOrder.map((family) => {
    const available = values.filter((row) => row.family === family).map((row) => row.metric);
    const placeholders = catalog.filter(([candidate]) => candidate === family && !available.some((metric) => metric.key === candidate[1])).map(([, key, label, unit]) => metricPlaceholder(family, key, label, unit));
    return { title: family.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), metrics: [...available, ...placeholders] };
  });
  const arsenal = role === "PITCHER" && snapshotRows.rows.length ? (await pool.query<{
    pitch_type: string; pitch_name: string; usage_percent: string | null; velocity: string | null; horizontal_movement: string | null; vertical_movement: string | null; sample_size: number | null; sample_status: MetricRow["status"]; provenance: JsonObject;
  }>(
    `SELECT DISTINCT ON (pitch_type) pitch_type, pitch_name, usage_percent, velocity, horizontal_movement, vertical_movement, sample_size, sample_status, provenance
     FROM pitch_arsenal_features WHERE research_snapshot_id = ANY($1) ORDER BY pitch_type, arsenal_feature_id DESC`,
    [snapshotRows.rows.map((row) => row.research_snapshot_id)],
  )).rows.map((row) => ({
    key: row.pitch_type, label: `${row.pitch_name} usage`, value: row.usage_percent === null ? null : Number(row.usage_percent), unit: "%", denominator: null, sampleSize: row.sample_size,
    source: "FanGraphs", definition: "Pitch-type usage with source-provided velocity/movement available in provenance.", transformation: "NORMALIZED" as const, status: row.sample_status, retrievedAt: isoValue(snapshotRows.rows[0].retrieved_at),
  })) : [];
  const person = identity.rows[0];
  return {
    sourceStatus: snapshotRows.rows.length ? "RESEARCH EVIDENCE AVAILABLE" : "INSUFFICIENT SOURCE COVERAGE",
    searchResults: profileCount.rows.map((row) => ({ playerId: row.player_id, name: row.full_name, team: row.abbreviation ?? "NOT FOUND", position: row.primary_position ?? "NOT FOUND", role: role === "HITTER" ? "HITTER" : "PITCHER" })),
    profile: person ? {
      identity: { playerId: person.player_id, name: person.full_name, team: person.abbreviation ?? "NOT FOUND", bats: person.bats ?? "NOT FOUND", throws: person.throws ?? "NOT FOUND", position: person.primary_position ?? "NOT FOUND", rosterState: person.status ?? "UNKNOWN" },
      window: researchWindow,
      effectiveFrom: snapshotRows.rows[0] ? isoValue(snapshotRows.rows[0].effective_from) : effectiveDate,
      effectiveTo: snapshotRows.rows[0] ? isoValue(snapshotRows.rows[0].effective_to) : effectiveDate,
      freshness: snapshotRows.rows[0] ? isoValue(snapshotRows.rows[0].retrieved_at) : "NOT FOUND",
      role: snapshotRows.rows[0]?.role ?? (role === "HITTER" ? "HITTER" : "UNKNOWN"),
      panels,
      arsenal,
      notes: [
        "Every research value keeps source, definition, date range, retrieval time, denominator, sample size, and transformation status.",
        "XBH is derived only from doubles + triples + home runs. Singles are intentionally excluded.",
        role === "PITCHER" ? "Starter and reliever samples are labeled by source role; mixed-role source rows are never relabeled as starter-only." : "Pitch-type matchup interpretation is research-only and is not a prediction.",
      ],
    } : null,
    notices: snapshotRows.rows.length ? [] : ["No source snapshot exists for this player/window. The view intentionally does not fall back to another window."],
  };
}

export async function getPlayerLab(playerId: number | null, search: string, window: ResearchWindow, effectiveDate: string) {
  return labProfile("HITTER", playerId, search, window, effectiveDate);
}

export async function getPitcherLab(playerId: number | null, search: string, window: ResearchWindow, effectiveDate: string) {
  return labProfile("PITCHER", playerId, search, window, effectiveDate);
}

export async function researchHealth() {
  const result = await pool.query<{
    player_profiles: number; pitcher_profiles: number; arsenal_profiles: number; park_profiles: number; identity_quarantines: number;
    insufficient_samples: number; missing_arsenal: number; missing_handedness_splits: number; metric_definition_conflicts: number; stale_windows: number;
  }>(
    `SELECT
      (SELECT count(DISTINCT player_id)::int FROM player_research_snapshots) AS player_profiles,
      (SELECT count(DISTINCT player_id)::int FROM pitcher_research_snapshots) AS pitcher_profiles,
      (SELECT count(DISTINCT research_snapshot_id)::int FROM pitch_arsenal_features) AS arsenal_profiles,
      (SELECT count(DISTINCT venue_id)::int FROM park_research_snapshots) AS park_profiles,
      (SELECT count(*)::int FROM research_identity_quarantine) AS identity_quarantines,
      ((SELECT count(*) FROM player_research_features WHERE sample_status = 'INSUFFICIENT_SAMPLE') + (SELECT count(*) FROM pitcher_research_features WHERE sample_status = 'INSUFFICIENT_SAMPLE'))::int AS insufficient_samples,
      (SELECT count(*)::int FROM pitcher_research_snapshots ps WHERE NOT EXISTS (SELECT 1 FROM pitch_arsenal_features pa WHERE pa.research_snapshot_id = ps.research_snapshot_id)) AS missing_arsenal,
      0::int AS missing_handedness_splits,
      (SELECT count(*)::int FROM ingest_issues WHERE issue_type = 'METRIC_DEFINITION_CONFLICT' AND resolved_at IS NULL) AS metric_definition_conflicts,
      (SELECT count(*)::int FROM ingest_runs WHERE source_id IN ('STATCAST', 'FANGRAPHS') AND finished_at < now() - interval '2 days') AS stale_windows`,
  );
  const row = result.rows[0];
  return {
    playerProfiles: row?.player_profiles ?? 0,
    pitcherProfiles: row?.pitcher_profiles ?? 0,
    arsenalProfiles: row?.arsenal_profiles ?? 0,
    parkProfiles: row?.park_profiles ?? 0,
    identityQuarantines: row?.identity_quarantines ?? 0,
    insufficientSamples: row?.insufficient_samples ?? 0,
    missingArsenal: row?.missing_arsenal ?? 0,
    missingHandednessSplits: row?.missing_handedness_splits ?? 0,
    metricDefinitionConflicts: row?.metric_definition_conflicts ?? 0,
    staleWindows: row?.stale_windows ?? 0,
  };
}
