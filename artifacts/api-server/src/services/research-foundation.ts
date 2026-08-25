import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { ingestBallparkPalResearch } from "./ballpark-pal";

const STATCAST_SOURCE = "STATCAST";
const FANGRAPHS_SOURCE = "FANGRAPHS";
const PARK_SOURCE = "PARK_FACTORS";

type JsonObject = Record<string, unknown>;
type ResearchWindow = "SEASON" | "CAREER" | "ROLLING_7" | "ROLLING_14" | "ROLLING_30" | "ROLLING_60";
type ResearchRole = "HITTER" | "PITCHER";
const LAB_SEARCH_RESULT_LIMIT = 100;
type MetricRow = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  denominator: number | null;
  sampleSize: number | null;
  source: string;
  definition: string;
  transformation: "RAW" | "NORMALIZED" | "DERIVED" | "DERIVED_FROM_STATCAST" | "HEURISTIC";
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
  // Operational profile eligibility is determined by MLB. Do not use the
  // public leaderboard qualification threshold to decide who receives a shell.
  return `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=${role === "HITTER" ? "batter" : "pitcher"}&filter=&sort=4&sortDir=desc&min=0&selections=${selections}&chart=false&x=x&csv=true`;
}

function statcastSearchUrl(role: ResearchRole, playerId: number, scope: ReturnType<typeof windowScope>) {
  const params = new URLSearchParams({
    all: "true",
    type: role === "HITTER" ? "batter" : "pitcher",
    player_type: role === "HITTER" ? "batter" : "pitcher",
    game_date_gt: scope.from,
    game_date_lt: scope.to,
    hfSea: `${scope.to.slice(0, 4)}|`,
  });
  params.append(role === "HITTER" ? "batters_lookup[]" : "pitchers_lookup[]", String(playerId));
  return `https://baseballsavant.mlb.com/statcast_search/csv?${params.toString()}`;
}

type StatcastPlate = Record<string, string>;

function terminalPlateAppearances(rows: StatcastPlate[]) {
  const byPlate = new Map<string, StatcastPlate>();
  for (const row of rows) {
    const gamePk = row.game_pk;
    const atBat = row.at_bat_number;
    if (!gamePk || !atBat) continue;
    const key = `${gamePk}:${atBat}`;
    const previous = byPlate.get(key);
    if (!previous || (asNumber(row.pitch_number) ?? 0) >= (asNumber(previous.pitch_number) ?? 0)) byPlate.set(key, row);
  }
  return [...byPlate.values()];
}

function percent(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function average(rows: StatcastPlate[], field: string) {
  const values = rows.map((row) => asNumber(row[field])).filter((value): value is number => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function statcastSplitRow(plates: StatcastPlate[], role: ResearchRole): JsonObject {
  const events = plates.map((row) => String(row.events ?? "").toLowerCase());
  const nonAtBats = new Set(["walk", "intent_walk", "hit_by_pitch", "sac_bunt", "sac_fly", "catcher_interf"]);
  const hits = new Set(["single", "double", "triple", "home_run"]);
  const pa = plates.length;
  const ab = events.filter((event) => !nonAtBats.has(event)).length;
  const count = (event: string) => events.filter((value) => value === event).length;
  const singles = count("single");
  const doubles = count("double");
  const triples = count("triple");
  const homers = count("home_run");
  const totalBases = singles + doubles * 2 + triples * 3 + homers * 4;
  const batted = plates.filter((row) => asNumber(row.launch_speed) !== null);
  const hardHits = batted.filter((row) => (asNumber(row.launch_speed) ?? 0) >= 95).length;
  const barrels = batted.filter((row) => asNumber(row.launch_speed_angle) === 6).length;
  const base = {
    G: new Set(plates.map((row) => row.game_pk)).size,
    PA: pa,
    AB: ab,
    "1B": singles,
    "2B": doubles,
    "3B": triples,
    HR: homers,
    AVG: ab ? (singles + doubles + triples + homers) / ab : null,
    OBP: pa ? (singles + doubles + triples + homers + count("walk") + count("intent_walk") + count("hit_by_pitch")) / pa : null,
    SLG: ab ? totalBases / ab : null,
    ISO: ab ? (totalBases - (singles + doubles + triples + homers)) / ab : null,
    xAVG: average(plates, "estimated_ba_using_speedangle"),
    xSLG: average(plates, "estimated_slg_using_speedangle"),
    xwOBA: average(plates, "estimated_woba_using_speedangle"),
    EV: average(batted, "launch_speed"),
    LA: average(batted, "launch_angle"),
    HardHit: percent(hardHits, batted.length),
    Barrels: barrels,
    BarrelRate: percent(barrels, batted.length),
    "K%": percent(count("strikeout") + count("strikeout_double_play"), pa),
    "BB%": percent(count("walk") + count("intent_walk"), pa),
    Pitches: plates.reduce((total, row) => total + (asNumber(row.pitch_number) ?? 0), 0),
  };
  return role === "HITTER"
    ? { ...base, OPS: base.OBP !== null && base.SLG !== null ? base.OBP + base.SLG : null, hard_hit_percent: base.HardHit, barrel_batted_rate: base.BarrelRate, barrel_pa: percent(barrels, pa), avg_hit_speed: base.EV, launch_angle: base.LA }
    : { ...base, BF: pa, xAVG: base.xAVG, xSLG: base.xSLG, estimated_woba: base.xwOBA, hard_hit_percent: base.HardHit, barrel_batted_rate: base.BarrelRate, doubles, triples, home_run: homers, k_percent: base["K%"], bb_percent: base["BB%"] };
}

function statcastDerivedMetrics(role: ResearchRole, row: JsonObject) {
  const source = "Baseball Savant / Statcast Search";
  const metrics = role === "HITTER" ? hitterMetrics(row, source) : pitcherMetrics(row, source);
  return metrics.map(({ family, metric }) => ({
    family,
    metric: {
      ...metric,
      transformation: "DERIVED_FROM_STATCAST" as const,
      definition: `${metric.definition} Derived from Statcast Search pitch/plate-appearance rows grouped by the opponent's recorded handedness.`,
    },
  }));
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

function fanGraphsSplitRequest(role: ResearchRole, scope: ReturnType<typeof windowScope>, splitId: number) {
  // Split IDs are documented by FanGraphs' public split-format endpoint:
  // hitter 1/2 = vs LHP/RHP; pitcher 5/6 = vs LHB/RHB.
  const body = {
    position: role === "HITTER" ? "B" : "P",
    statType: "player",
    type: "8",
    league: "all",
    team: "0",
    qual: "0",
    ind: "0",
    season: scope.to.slice(0, 4),
    season1: scope.from.slice(0, 4),
    startdate: "",
    enddate: "",
    split: String(splitId),
  };
  return {
    endpoint: "https://www.fangraphs.com/api/leaders/splits/data",
    init: {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    },
    scope: { ...scope, splitId, requestBody: body },
  };
}

async function ensureResearchSources() {
  await pool.query(
    `INSERT INTO source_registry (source_id, name, source_type, base_url, expected_freshness_minutes, notes)
     VALUES
      ($1, 'Baseball Savant / Statcast', 'RESEARCH', 'https://baseballsavant.mlb.com', 1440, 'Public Statcast leaderboard evidence. MLBAM IDs are required for attachment.'),
      ($2, 'FanGraphs', 'RESEARCH', 'https://www.fangraphs.com', 1440, 'Public leaderboard research evidence. Definition-specific metrics remain source-labeled.'),
       ($3, 'Baseball Savant Statcast Park Factors', 'RESEARCH', 'https://baseballsavant.mlb.com/leaderboard/statcast-park-factors', 10080, 'Public Statcast park-factor components. Raw values remain source-defined and are never converted into a matchup score.')
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

async function persistHitterSnapshot(playerId: number, sourceId: string, ingestRunId: string, rawPayloadId: string, scope: ReturnType<typeof windowScope>, row: JsonObject, pitcherSide: string | null = null, derivedFromStatcast = false) {
  const metrics = derivedFromStatcast ? statcastDerivedMetrics("HITTER", row) : hitterMetrics(row, sourceId === STATCAST_SOURCE ? "Baseball Savant / Statcast" : "FanGraphs");
  const pa = asNumber(row.PA ?? row.pa);
  const contentChecksum = hash({ sourceId, playerId, scope, pitcherSide, row });
  const previous = await pool.query<{ content_checksum: string }>(
    `SELECT content_checksum FROM player_research_snapshots WHERE player_id = $1 AND source_id = $2 AND research_window = $3
      ORDER BY retrieved_at DESC LIMIT 1`,
    [playerId, sourceId, scope.window],
  );
  const snapshot = await pool.query<{ research_snapshot_id: string }>(
    `INSERT INTO player_research_snapshots (player_id, source_id, ingest_run_id, raw_payload_id, research_window, effective_from, effective_to, sample_size, denominator_type, denominator, content_checksum, unchanged_from_prior, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PA', $9, $10, $11, $12) RETURNING research_snapshot_id`,
    [playerId, sourceId, ingestRunId, rawPayloadId, scope.window, scope.from, scope.to, pa, pa, contentChecksum, previous.rows[0]?.content_checksum === contentChecksum, { source: sourceId, externalPlayerId: playerId, scope, opponentPitcherSide: pitcherSide, derivation: derivedFromStatcast ? "Statcast Search terminal plate appearances grouped by p_throws" : null }],
  );
  for (const { family, metric } of metrics) {
    await pool.query(
      `INSERT INTO player_research_features (research_snapshot_id, family, metric_key, metric_label, value, unit, denominator, sample_size, pitcher_side, transformation, sample_status, definition, provenance)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
       [snapshot.rows[0].research_snapshot_id, family, metric.key, metric.label, metric.value, metric.unit, metric.denominator, metric.sampleSize, pitcherSide, metric.transformation, metric.status, metric.definition, { source: metric.source, retrievedAt: metric.retrievedAt, pitcherSide, derivation: derivedFromStatcast ? "Statcast Search p_throws" : null }],
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

async function persistPitcherSnapshot(playerId: number, sourceId: string, ingestRunId: string, rawPayloadId: string, scope: ReturnType<typeof windowScope>, row: JsonObject, batterSide: string | null = null, derivedFromStatcast = false) {
  const metrics = derivedFromStatcast ? statcastDerivedMetrics("PITCHER", row) : pitcherMetrics(row, sourceId === STATCAST_SOURCE ? "Baseball Savant / Statcast" : "FanGraphs");
  const bf = asNumber(row.BF ?? row.PA ?? row.pa);
  const contentChecksum = hash({ sourceId, playerId, scope, batterSide, row });
  const previous = await pool.query<{ content_checksum: string }>(
    `SELECT content_checksum FROM pitcher_research_snapshots WHERE player_id = $1 AND source_id = $2 AND research_window = $3
      ORDER BY retrieved_at DESC LIMIT 1`,
    [playerId, sourceId, scope.window],
  );
  const snapshot = await pool.query<{ research_snapshot_id: string }>(
    `INSERT INTO pitcher_research_snapshots (player_id, source_id, ingest_run_id, raw_payload_id, research_window, role, effective_from, effective_to, sample_size, denominator_type, denominator, content_checksum, unchanged_from_prior, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'BF', $10, $11, $12, $13) RETURNING research_snapshot_id`,
    [playerId, sourceId, ingestRunId, rawPayloadId, scope.window, pitcherRole(row), scope.from, scope.to, bf, bf, contentChecksum, previous.rows[0]?.content_checksum === contentChecksum, { source: sourceId, externalPlayerId: playerId, scope, opponentBatterSide: batterSide, derivation: derivedFromStatcast ? "Statcast Search terminal plate appearances grouped by stand" : null }],
  );
  for (const { family, metric } of metrics) {
    await pool.query(
      `INSERT INTO pitcher_research_features (research_snapshot_id, family, metric_key, metric_label, value, unit, denominator, sample_size, batter_side, transformation, sample_status, definition, provenance)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
       [snapshot.rows[0].research_snapshot_id, family, metric.key, metric.label, metric.value, metric.unit, metric.denominator, metric.sampleSize, batterSide, metric.transformation, metric.status, metric.definition, { source: metric.source, retrievedAt: metric.retrievedAt, batterSide, derivation: derivedFromStatcast ? "Statcast Search stand" : null }],
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
  let failure: string | null = null;
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
    failure = error instanceof Error ? error.message : String(error);
    await finishRun(ingestRunId, "FAILED", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, error: failure }, started);
  }
  return { source: "Baseball Savant / Statcast", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, quarantinedRows: quarantined, status: failure ? "FAILED" : quarantined || rejected ? "PARTIAL" : "SUCCESS", error: failure };
}

async function statcastSplitTargets(effectiveDate: string, scope: "GAME_DAY" | "FULL_UNIVERSE", batchSize = 24) {
  if (scope === "FULL_UNIVERSE") {
    const [hitters, pitchers] = await Promise.all([
      pool.query<{ player_id: number }>(
        `SELECT pe.player_id
         FROM player_eligibility pe JOIN players p ON p.player_id = pe.player_id
         WHERE pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = $1
           AND pe.eligible_today_research AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
           AND COALESCE(p.primary_position, '') <> 'P'
           AND NOT (
             EXISTS (SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = s.ingest_run_id WHERE s.player_id = pe.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.pitcher_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST')
             AND EXISTS (SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = s.ingest_run_id WHERE s.player_id = pe.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.pitcher_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST')
           )
         ORDER BY pe.player_id LIMIT $2`,
        [effectiveDate, batchSize],
      ),
      pool.query<{ player_id: number }>(
        `SELECT pe.player_id
         FROM player_eligibility pe JOIN players p ON p.player_id = pe.player_id
         WHERE pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = $1
           AND pe.eligible_pitcher_research AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
           AND p.primary_position = 'P'
           AND NOT (
             EXISTS (SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = s.ingest_run_id WHERE s.player_id = pe.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.batter_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST')
             AND EXISTS (SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = s.ingest_run_id WHERE s.player_id = pe.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.batter_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST')
           )
         ORDER BY pe.player_id LIMIT $2`,
        [effectiveDate, batchSize],
      ),
    ]);
    return { hitters: hitters.rows.map((row) => row.player_id), pitchers: pitchers.rows.map((row) => row.player_id) };
  }
  const [hitters, pitchers] = await Promise.all([
    pool.query<{ player_id: number }>(
      `WITH latest_projected AS (
         SELECT DISTINCT ON (ls.game_pk, ls.team_id) ls.lineup_snapshot_id
         FROM lineup_snapshots ls
         JOIN games g ON g.game_pk = ls.game_pk
         WHERE ls.source_id = 'FANTASYPROS' AND ls.state = 'PROJECTED' AND g.game_date = $1
         ORDER BY ls.game_pk, ls.team_id, ls.observed_at DESC
       )
       SELECT DISTINCT le.player_id
       FROM latest_projected lp
       JOIN lineup_entries le ON le.lineup_snapshot_id = lp.lineup_snapshot_id
       JOIN players p ON p.player_id = le.player_id
       JOIN player_eligibility pe ON pe.player_id = le.player_id
         AND pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = $1
         AND pe.eligible_today_research AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
       WHERE le.player_id IS NOT NULL AND COALESCE(p.primary_position, '') <> 'P'
         AND NOT (
            EXISTS (SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = s.ingest_run_id WHERE s.player_id = le.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.pitcher_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST')
            AND EXISTS (SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = s.ingest_run_id WHERE s.player_id = le.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.pitcher_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST')
         )
       ORDER BY le.player_id`,
      [effectiveDate],
    ),
    pool.query<{ player_id: number }>(
      `SELECT DISTINCT s.player_id
       FROM starters s
       JOIN games g ON g.game_pk = s.game_pk
       JOIN players p ON p.player_id = s.player_id
       JOIN player_eligibility pe ON pe.player_id = s.player_id
         AND pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = $1
         AND pe.eligible_pitcher_research AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
       WHERE s.source_id = 'MLB_OFFICIAL' AND g.game_date = $1 AND s.player_id IS NOT NULL AND p.primary_position = 'P'
         AND NOT (
            EXISTS (SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots ps ON ps.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = ps.ingest_run_id WHERE ps.player_id = s.player_id AND ps.source_id = 'STATCAST' AND ps.research_window = 'SEASON' AND ps.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.batter_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST')
            AND EXISTS (SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots ps ON ps.research_snapshot_id = f.research_snapshot_id JOIN ingest_runs ir ON ir.ingest_run_id = ps.ingest_run_id WHERE ps.player_id = s.player_id AND ps.source_id = 'STATCAST' AND ps.research_window = 'SEASON' AND ps.effective_to = $1 AND ir.job_name = 'statcast_search_handedness_fallback' AND ir.effective_date = $1 AND ir.status = 'SUCCESS' AND f.batter_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST')
         )
       ORDER BY s.player_id`,
      [effectiveDate],
    ),
  ]);
  return { hitters: hitters.rows.map((row) => row.player_id), pitchers: pitchers.rows.map((row) => row.player_id) };
}

export async function ingestStatcastHandednessFallback(effectiveDate: string, targetScope: "GAME_DAY" | "FULL_UNIVERSE" = "GAME_DAY", batchSize = 24) {
  const started = Date.now();
  const ingestRunId = await startRun(STATCAST_SOURCE, "statcast_search_handedness_fallback", effectiveDate);
  const scope = windowScope("SEASON", effectiveDate);
  let rowCount = 0;
  let normalized = 0;
  let rejected = 0;
  let lastStatus = 200;
  let failure: string | null = null;
  try {
    const targets = await statcastSplitTargets(effectiveDate, targetScope, batchSize);
    const work: Array<{ role: ResearchRole; playerId: number }> = [
      ...targets.hitters.map((playerId) => ({ role: "HITTER" as const, playerId })),
      ...targets.pitchers.map((playerId) => ({ role: "PITCHER" as const, playerId })),
    ];
    for (let offset = 0; offset < work.length; offset += batchSize) {
      await Promise.all(work.slice(offset, offset + batchSize).map(async ({ role, playerId }) => {
        const endpoint = statcastSearchUrl(role, playerId, scope);
        try {
          const response = await fetch(endpoint, { headers: { accept: "text/csv,text/plain", "user-agent": "Mozilla/5.0 (compatible; MLBAnalystResearch/1.0)" } });
          const payload = await response.text();
          lastStatus = response.status;
          if (!response.ok) throw new Error(`Statcast Search ${role.toLowerCase()} ${playerId} returned HTTP ${response.status}`);
          const rows = parseCsv(payload).filter((row) => asNumber(role === "HITTER" ? row.batter : row.pitcher) === playerId);
          rowCount += rows.length;
          const rawPayloadId = await storeRaw(
            ingestRunId,
            STATCAST_SOURCE,
            `statcast_search_${role.toLowerCase()}_${playerId}`,
            effectiveDate,
            payload,
            endpoint,
            { role, playerId, window: scope.window, effectiveRange: { from: scope.from, to: scope.to }, grouping: role === "HITTER" ? "p_throws" : "stand" },
          );
          const plates = terminalPlateAppearances(rows);
          for (const side of ["L", "R"] as const) {
            const sidePlates = plates.filter((row) => String(role === "HITTER" ? row.p_throws : row.stand).toUpperCase() === side);
            const derived = statcastSplitRow(sidePlates, role);
            normalized += 1;
            if (role === "HITTER") await persistHitterSnapshot(playerId, STATCAST_SOURCE, ingestRunId, rawPayloadId, scope, derived, side, true);
            else await persistPitcherSnapshot(playerId, STATCAST_SOURCE, ingestRunId, rawPayloadId, scope, derived, side, true);
          }
        } catch {
          rejected += 1;
        }
      }));
    }
    await finishRun(ingestRunId, rejected ? "PARTIAL" : "SUCCESS", {
      rows: rowCount, normalized, rejected, httpStatus: lastStatus,
       metadata: { targetHitters: targets.hitters.length, targetPitchers: targets.pitchers.length, targetScope, batchSize, identityGate: targetScope === "FULL_UNIVERSE" ? "all official eligible hitters and pitchers" : "projected lineup hitters and official/probable starters only", splitSource: "Statcast Search p_throws/stand" },
    }, started);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await finishRun(ingestRunId, "FAILED", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, error: failure }, started);
  }
  return { source: "Baseball Savant / Statcast Search splits", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, quarantinedRows: 0, status: failure ? "FAILED" : rejected ? "PARTIAL" : "SUCCESS", error: failure };
}

async function ingestFanGraphs(effectiveDate: string) {
  const started = Date.now();
  const ingestRunId = await startRun(FANGRAPHS_SOURCE, "fangraphs_research", effectiveDate);
  let rowCount = 0;
  let normalized = 0;
  let rejected = 0;
  let quarantined = 0;
  let lastStatus = 200;
  let failure: string | null = null;
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
    // Side splits are separately retrieved only for the season window. They
    // are opponent-handedness evidence, never inferred from the player's hand.
    const splitScope = windowScope("SEASON", effectiveDate);
    for (const role of ["HITTER", "PITCHER"] as const) {
      const splitDefinitions = role === "HITTER"
        ? [{ splitId: 1, side: "L" }, { splitId: 2, side: "R" }]
        : [{ splitId: 5, side: "L" }, { splitId: 6, side: "R" }];
      for (const { splitId, side } of splitDefinitions) {
        const request = fanGraphsSplitRequest(role, splitScope, splitId);
        const response = await fetch(request.endpoint, request.init);
        lastStatus = response.status;
        const payload = await response.json() as JsonObject;
        if (!response.ok) throw new Error(`FanGraphs ${role.toLowerCase()} split ${splitId} request returned HTTP ${response.status}`);
        const rows = Array.isArray(payload.data) ? payload.data.filter((row): row is JsonObject => Boolean(row) && typeof row === "object") : [];
        rowCount += rows.length;
        const rawPayloadId = await storeRaw(
          ingestRunId, FANGRAPHS_SOURCE, `fangraphs_${role.toLowerCase()}_vs_${side.toLowerCase()}_season`,
          effectiveDate, payload, request.endpoint,
          { ...request.scope, role, opponentSide: side, requestedPlayerScope: "league-wide" },
        );
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
          if (role === "HITTER") await persistHitterSnapshot(playerId, FANGRAPHS_SOURCE, ingestRunId, rawPayloadId, splitScope, raw, side);
          else await persistPitcherSnapshot(playerId, FANGRAPHS_SOURCE, ingestRunId, rawPayloadId, splitScope, raw, side);
        }
      }
    }
    await finishRun(ingestRunId, quarantined ? "PARTIAL" : "SUCCESS", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, metadata: { identityReviewRequired: quarantined, actualRejected: rejected } }, started);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await finishRun(ingestRunId, "FAILED", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, error: failure }, started);
  }
  return { source: "FanGraphs", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, quarantinedRows: quarantined, status: failure ? "FAILED" : quarantined || rejected ? "PARTIAL" : "SUCCESS", error: failure };
}

function extractEmbeddedArray(html: string): JsonObject[] {
  const match = html.match(/(?:var|const|let)\s+(?:data|parkData|park_data)\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.filter((row): row is JsonObject => Boolean(row) && typeof row === "object") : [];
  } catch {
    return [];
  }
}

function parkValue(row: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = asNumber(row[key]);
    if (value !== null) return value;
  }
  return null;
}

async function ingestParkFactorsLegacy(effectiveDate: string) {
  const started = Date.now();
  const ingestRunId = await startRun(PARK_SOURCE, "statcast_park_factors", effectiveDate);
  const endpoint = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=${effectiveDate.slice(0, 4)}&batSide=All`;
  let rowCount = 0;
  let normalized = 0;
  let rejected = 0;
  let failure: string | null = null;
  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; MLBAnalystResearch/1.0)",
      },
    });
    const payload = await response.text();
    if (!response.ok) throw new Error(`Statcast park factor request returned HTTP ${response.status}`);
    const rows = extractEmbeddedArray(payload);
    rowCount = rows.length;
    if (!rows.length) throw new Error("Statcast park factor page did not expose a parsable public data array");
    const rawPayloadId = await storeRaw(ingestRunId, PARK_SOURCE, "statcast_park_factors_html", effectiveDate, payload, endpoint, {
      season: Number(effectiveDate.slice(0, 4)),
      span: "year",
      batterSide: "All",
      parser: "server-rendered embedded array",
    });
    for (const row of rows) {
      const venueId = parkValue(row, ["venue_id", "venueId", "park_id", "parkId", "id"]);
      if (!venueId) {
        rejected += 1;
        continue;
      }
      const venueExists = await pool.query("SELECT 1 FROM venues WHERE venue_id = $1", [venueId]);
      if (!venueExists.rowCount) {
        rejected += 1;
        continue;
      }
      const sideValue = String(row.key_bat_side ?? row.batter_side ?? row.bat_side ?? row.hand ?? "All").toUpperCase();
      const batterSide = sideValue === "ALL" ? null : sideValue;
      const span = String(row.year_range ?? row.span ?? row.rolling ?? row.type ?? "NOT FOUND");
      const sourceFields: Array<[string, string, string[]]> = [
        ["singles_factor", "Singles component", ["index_1b", "1B", "1b", "single", "singles"]],
        ["doubles_factor", "Doubles component", ["index_2b", "2B", "2b", "double", "doubles"]],
        ["triples_factor", "Triples component", ["index_3b", "3B", "3b", "triple", "triples"]],
        ["hr_factor", "Home run component", ["index_hr", "HR", "hr", "home_run", "home_runs"]],
        ["hits_factor", "Hits component", ["index_hits", "H", "hits", "hit"]],
      ];
      const checksum = hash({ venueId, effectiveDate, span, batterSide, row });
      const snapshot = await pool.query<{ park_research_snapshot_id: string }>(
        `INSERT INTO park_research_snapshots (venue_id, source_id, ingest_run_id, raw_payload_id, season, span, content_checksum, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING park_research_snapshot_id`,
        [venueId, PARK_SOURCE, ingestRunId, rawPayloadId, Number(effectiveDate.slice(0, 4)), span, checksum, { source: "Baseball Savant Statcast Park Factors", endpoint, sourceYearRange: row.year_range ?? null, sourceBatterSide: row.key_bat_side ?? null, rawRow: row }],
      );
      for (const [key, label, fields] of sourceFields) {
        const value = parkValue(row, fields);
        await pool.query(
          `INSERT INTO park_research_features (park_research_snapshot_id, metric_key, metric_label, value, batter_side, transformation, sample_status, definition, provenance)
           VALUES ($1, $2, $3, $4, $5, 'RAW', $6, $7, $8)`,
          [snapshot.rows[0].park_research_snapshot_id, key, label, value, batterSide, value === null ? "NOT_FOUND" : "AVAILABLE", "Raw public Baseball Savant Statcast Park Factors component; no composite factor is inferred.", { source: "Baseball Savant Statcast Park Factors", rawFields: fields, span }],
        );
      }
      normalized += 1;
    }
    await finishRun(ingestRunId, rejected ? "PARTIAL" : "SUCCESS", { rows: rowCount, normalized, rejected, httpStatus: response.status }, started);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await finishRun(ingestRunId, "FAILED", { rows: rowCount, normalized, rejected, error: failure }, started);
  }
  return { source: "Baseball Savant Statcast Park Factors", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, quarantinedRows: 0, status: failure ? "FAILED" : rejected ? "PARTIAL" : "SUCCESS", error: failure };
}

async function persistStatcastParkSide(ingestRunId: string, effectiveDate: string, requestedSide: "All" | "L" | "R") {
  const endpoint = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=${effectiveDate.slice(0, 4)}&batSide=${requestedSide}`;
  const response = await fetch(endpoint, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; MLBAnalystResearch/1.0)" } });
  const payload = await response.text();
  if (!response.ok) throw new Error(`Statcast park factor ${requestedSide} request returned HTTP ${response.status}`);
  const rows = extractEmbeddedArray(payload);
  if (!rows.length) throw new Error(`Statcast park factor page did not expose a parsable ${requestedSide} data array`);
  const rawPayloadId = await storeRaw(ingestRunId, PARK_SOURCE, `statcast_park_factors_${requestedSide.toLowerCase()}_html`, effectiveDate, payload, endpoint, {
    season: Number(effectiveDate.slice(0, 4)), requestedBatterSide: requestedSide, parser: "server-rendered embedded array",
  });
  let normalized = 0;
  let rejected = 0;
  for (const row of rows) {
    const venueId = parkValue(row, ["venue_id", "venueId", "park_id", "parkId", "id"]);
    if (!venueId) {
      rejected += 1;
      continue;
    }
    await pool.query(
      `INSERT INTO venues (venue_id, name, metadata) VALUES ($1, $2, $3)
       ON CONFLICT (venue_id) DO UPDATE SET name = EXCLUDED.name, metadata = venues.metadata || EXCLUDED.metadata`,
      [venueId, String(row.venue_name ?? row.name ?? `Savant venue ${venueId}`), { source: "Baseball Savant Statcast Park Factors", mainTeamId: row.main_team_id ?? null }],
    );
    const sideValue = String(row.key_bat_side ?? requestedSide).toUpperCase();
    const batterSide = sideValue === "ALL" ? null : sideValue;
    const span = String(row.year_range ?? "NOT FOUND");
    const checksum = hash({ venueId, effectiveDate, span, batterSide, row });
    const snapshot = await pool.query<{ park_research_snapshot_id: string }>(
      `INSERT INTO park_research_snapshots (venue_id, source_id, ingest_run_id, raw_payload_id, season, span, content_checksum, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING park_research_snapshot_id`,
      [venueId, PARK_SOURCE, ingestRunId, rawPayloadId, Number(effectiveDate.slice(0, 4)), span, checksum, {
        source: "Baseball Savant Statcast Park Factors", endpoint, requestedBatterSide: requestedSide,
        sourceYearRange: row.year_range ?? null, sourceBatterSide: row.key_bat_side ?? null, rawRow: row,
      }],
    );
    const sourceFields: Array<[string, string, string]> = [
      ["singles_factor", "Singles component", "index_1b"],
      ["doubles_factor", "Doubles component", "index_2b"],
      ["triples_factor", "Triples component", "index_3b"],
      ["hr_factor", "Home run component", "index_hr"],
      ["hits_factor", "Hits component", "index_hits"],
    ];
    for (const [key, label, field] of sourceFields) {
      const value = asNumber(row[field]);
      await pool.query(
        `INSERT INTO park_research_features (park_research_snapshot_id, metric_key, metric_label, value, batter_side, transformation, sample_status, definition, provenance)
         VALUES ($1, $2, $3, $4, $5, 'RAW', $6, $7, $8)`,
        [snapshot.rows[0].park_research_snapshot_id, key, label, value, batterSide, value === null ? "NOT_FOUND" : "AVAILABLE",
          "Raw public Baseball Savant Statcast Park Factors component; no XBH composite is inferred.",
          { source: "Baseball Savant Statcast Park Factors", rawField: field, yearRange: span, batterSide }],
      );
    }
    normalized += 1;
  }
  return { rowCount: rows.length, normalized, rejected, httpStatus: response.status };
}

async function ingestParkFactors(effectiveDate: string) {
  const started = Date.now();
  const ingestRunId = await startRun(PARK_SOURCE, "statcast_park_factors", effectiveDate);
  let rowCount = 0;
  let normalized = 0;
  let rejected = 0;
  let lastStatus = 200;
  let failure: string | null = null;
  try {
    for (const side of ["All", "L", "R"] as const) {
      const result = await persistStatcastParkSide(ingestRunId, effectiveDate, side);
      rowCount += result.rowCount;
      normalized += result.normalized;
      rejected += result.rejected;
      lastStatus = result.httpStatus;
    }
    await finishRun(ingestRunId, rejected ? "PARTIAL" : "SUCCESS", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, metadata: { requestedBatterSides: ["All", "L", "R"], sourceRangesRetained: true } }, started);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await finishRun(ingestRunId, "FAILED", { rows: rowCount, normalized, rejected, httpStatus: lastStatus, error: failure }, started);
  }
  return { source: "Baseball Savant Statcast Park Factors", ingestRunId, rowCount, normalizedRowCount: normalized, rejectedRowCount: rejected, quarantinedRows: 0, status: failure ? "FAILED" : rejected ? "PARTIAL" : "SUCCESS", error: failure };
}

export async function ingestResearch(effectiveDate: string) {
  // Legacy Statcast/FanGraphs records remain immutable audit evidence. Daily
  // work deliberately uses only the supported API adapter below.
  return ingestBallparkPalResearch(effectiveDate);
}

function metricPlaceholder(family: string, key: string, label: string, unit: string): MetricRow {
  return { key, label, value: null, unit, denominator: null, sampleSize: null, source: "NOT FOUND", definition: "No compatible source value is available for this snapshot.", transformation: "RAW", status: "NOT_FOUND", retrievedAt: "NOT FOUND" };
}

async function labProfile(role: ResearchRole, playerId: number | null, search: string, researchWindow: ResearchWindow, effectiveDate: string) {
  const table = role === "HITTER" ? "player_research_snapshots" : "pitcher_research_snapshots";
  const featureTable = role === "HITTER" ? "player_research_features" : "pitcher_research_features";
  const shouldSearch = search.length > 0;
  const profileCount = await pool.query<{ player_id: number; full_name: string; abbreviation: string | null; primary_position: string | null }>(
    `SELECT DISTINCT ON (p.player_id) p.player_id, p.full_name, t.abbreviation, p.primary_position
     FROM players p
     JOIN player_eligibility pe ON pe.player_id = p.player_id
       AND pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = $2
       AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
       AND CASE WHEN $3 = 'HITTER' THEN pe.eligible_today_research ELSE pe.eligible_pitcher_research END
     LEFT JOIN teams t ON t.team_id = p.current_team_id
     WHERE p.full_name ILIKE $1
       AND CASE WHEN $3 = 'HITTER' THEN COALESCE(p.primary_position, '') <> 'P' ELSE p.primary_position = 'P' END
      ORDER BY p.player_id, p.full_name LIMIT $4`,
    [shouldSearch ? `%${search}%` : "\uFFFF", effectiveDate, role, LAB_SEARCH_RESULT_LIMIT + 1],
  );
  const searchResults = profileCount.rows.slice(0, LAB_SEARCH_RESULT_LIMIT).map((row) => ({
    playerId: row.player_id,
    name: row.full_name,
    team: row.abbreviation ?? "NOT FOUND",
    position: row.primary_position ?? "NOT FOUND",
    role: role === "HITTER" ? "HITTER" as const : "PITCHER" as const,
  }));
  const searchResultsTruncated = profileCount.rows.length > LAB_SEARCH_RESULT_LIMIT;
  // Name collision protection.
  //
  // Resolving a player by name alone silently picked the first row. There are
  // two players named Max Muncy on different clubs and more than one Fermin, so
  // "the first row" is a coin flip that looks like an answer. When the caller
  // supplied no playerId and the search names a player carried by more than one
  // club, the collision is raised rather than resolved.
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const exactNameMatches = profileCount.rows.filter(
    (row) => normalize(row.full_name) === normalize(search),
  );
  const collidingClubs = new Set(exactNameMatches.map((row) => row.abbreviation ?? "UNKNOWN"));
  if (playerId == null && exactNameMatches.length > 1 && collidingClubs.size > 1) {
    return {
      sourceStatus: "AMBIGUOUS PLAYER NAME",
      searchResults,
      searchResultLimit: LAB_SEARCH_RESULT_LIMIT,
      searchResultsTruncated,
      profile: null,
      notices: [
        `${exactNameMatches.length} players named "${search.trim()}" are carried by different clubs `
        + `(${[...collidingClubs].sort().join(", ")}). Select one by player id; this view will not guess.`,
      ],
    };
  }

  const selectedId = playerId;
  if (!selectedId) {
    return {
      sourceStatus: shouldSearch
        ? (searchResults.length ? "SELECT A SEARCH RESULT" : "NO ELIGIBLE MATCHES")
        : "SEARCH REQUIRED",
      searchResults,
      searchResultLimit: LAB_SEARCH_RESULT_LIMIT,
      searchResultsTruncated,
      profile: null,
      notices: shouldSearch
        ? (searchResults.length
          ? ["Select a matching eligible player to inspect the requested research window."]
          : [`No eligible ${role === "HITTER" ? "hitter" : "pitcher"} matched "${search}" for ${effectiveDate}. Check the exact date, role, and identity-review state.`])
        : [`Enter a ${role === "HITTER" ? "hitter" : "pitcher"} name to search current official eligibility for ${effectiveDate}.`],
    };
  }
  const selectedEligibility = await canonicalPlayer(selectedId, effectiveDate, role);
  const historicalProfile = await pool.query<{ available: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM player_intelligence_features
      WHERE player_id = $1
        AND dimensions->>'participantRole' = $2
        AND effective_to <= $3
    ) AS available`,
    [selectedId, role, effectiveDate],
  );
  const historicalOnly = !selectedEligibility && historicalProfile.rows[0]?.available;
  if (!selectedEligibility && !historicalOnly) {
    return {
      sourceStatus: "PLAYER NOT ELIGIBLE FOR THIS LAB",
      searchResults,
      searchResultLimit: LAB_SEARCH_RESULT_LIMIT,
      searchResultsTruncated,
      profile: null,
      notices: [`This player is not an eligible ${role.toLowerCase()} for ${effectiveDate}, or is blocked by identity review or research quarantine. The profile was intentionally not loaded.`],
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
    `SELECT DISTINCT ON (s.source_id, opponent_side) s.research_snapshot_id, s.source_id, s.effective_from, s.effective_to, s.retrieved_at, ${role === "PITCHER" ? "s.role" : "NULL::text AS role"}
      FROM ${table} s
      LEFT JOIN LATERAL (
        SELECT max(${role === "HITTER" ? "f.pitcher_side" : "f.batter_side"}) AS opponent_side
        FROM ${featureTable} f WHERE f.research_snapshot_id = s.research_snapshot_id
      ) split_dimension ON true
      WHERE s.player_id = $1 AND s.research_window = $2 AND s.effective_to <= $3
      ORDER BY s.source_id, opponent_side NULLS FIRST, s.effective_to DESC, s.retrieved_at DESC`,
    [selectedId, researchWindow, effectiveDate],
  );
  const features = snapshotRows.rows.length ? await pool.query<{
    family: string; metric_key: string; metric_label: string; value: string | null; unit: string | null; denominator: string | null;
    sample_size: number | null; opponent_side: string | null; transformation: MetricRow["transformation"]; sample_status: MetricRow["status"]; definition: string; source_id: string; retrieved_at: string;
  }>(
    `SELECT f.family, f.metric_key, f.metric_label, f.value, f.unit, f.denominator, f.sample_size,
      ${role === "HITTER" ? "f.pitcher_side" : "f.batter_side"} AS opponent_side,
      f.transformation, f.sample_status, f.definition, s.source_id, s.retrieved_at
     FROM ${featureTable} f JOIN ${table} s ON s.research_snapshot_id = f.research_snapshot_id
     WHERE f.research_snapshot_id = ANY($1) ORDER BY f.family, f.metric_label, s.source_id`,
    [snapshotRows.rows.map((row) => row.research_snapshot_id)],
  ) : { rows: [] };
  const values = features.rows.map((row) => ({
    family: row.family,
    opponentSide: row.opponent_side,
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
  const intelligence = await pool.query<{
    metric_key: string; metric_label: string; value: string | null; numerator: string | null; denominator: string | null;
    denominator_type: string; sample_size: number; sample_status: MetricRow["status"]; effective_from: string; effective_to: string; created_at: string;
  }>(
    `SELECT DISTINCT ON (f.metric_key, f.dimensions)
       f.metric_key, f.metric_label, f.value, f.numerator, f.denominator, f.denominator_type, f.sample_size,
       f.sample_status, f.effective_from::text, f.effective_to::text, f.created_at
     FROM player_intelligence_features f
     WHERE f.player_id = $1 AND f.research_window = $2 AND f.effective_to <= $3
       AND f.dimensions->>'participantRole' = $4
       AND f.dimensions->>'opponentSide' = 'ALL'
       AND f.dimensions->>'dayNight' = 'ALL'
     ORDER BY f.metric_key, f.dimensions, f.effective_to DESC, f.created_at DESC`,
    [selectedId, researchWindow, effectiveDate, role],
  );
  const intelligenceMetrics: MetricRow[] = intelligence.rows.map((row) => ({
    key: row.metric_key,
    label: row.metric_label,
    value: row.value === null ? null : Number(row.value),
    unit: row.denominator_type === "PA" || row.denominator_type === "BF" || row.denominator_type === "AB" ? "rate" : row.denominator_type,
    denominator: row.denominator === null ? null : Number(row.denominator),
    sampleSize: row.sample_size,
    source: "Baseball Savant / Statcast retained history",
    definition: "Reproducible historical intelligence derived from retained canonical-ID event observations. The denominator and sample size remain attached.",
    transformation: "DERIVED_FROM_STATCAST",
    status: row.sample_status,
    retrievedAt: isoValue(row.created_at),
  }));
  const catalog = role === "HITTER" ? hitterCatalog : pitcherCatalog;
  const familyOrder = [...new Set(catalog.map(([family]) => family))];
  const panels = familyOrder.map((family) => {
    const available = values.filter((row) => row.family === family && !row.opponentSide).map((row) => row.metric);
    const placeholders = catalog.filter(([candidate]) => candidate === family && !available.some((metric) => metric.key === candidate[1])).map(([, key, label, unit]) => metricPlaceholder(family, key, label, unit));
    return { title: family.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), metrics: [...available, ...placeholders] };
  });
  const splitPanels = ["L", "R"].flatMap((side) => {
    const splitMetrics = values.filter((row) => row.opponentSide === side).map((row) => row.metric);
    if (!splitMetrics.length) return [];
    return [{
      title: `Vs ${side}${role === "HITTER" ? "HP" : "HB"} · opponent-handedness`,
      metrics: splitMetrics,
    }];
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
     sourceStatus: snapshotRows.rows.length || intelligenceMetrics.length ? "RESEARCH EVIDENCE AVAILABLE" : "INSUFFICIENT SOURCE COVERAGE",
    searchResults,
    searchResultLimit: LAB_SEARCH_RESULT_LIMIT,
    searchResultsTruncated,
    profile: person ? {
      identity: { playerId: person.player_id, name: person.full_name, team: person.abbreviation ?? "NOT FOUND", bats: person.bats ?? "NOT FOUND", throws: person.throws ?? "NOT FOUND", position: person.primary_position ?? "NOT FOUND", rosterState: person.status ?? "UNKNOWN" },
      window: researchWindow,
       effectiveFrom: snapshotRows.rows[0] ? isoValue(snapshotRows.rows[0].effective_from) : intelligence.rows[0]?.effective_from ?? effectiveDate,
       effectiveTo: snapshotRows.rows[0] ? isoValue(snapshotRows.rows[0].effective_to) : intelligence.rows[0]?.effective_to ?? effectiveDate,
       freshness: snapshotRows.rows[0] ? isoValue(snapshotRows.rows[0].retrieved_at) : intelligence.rows[0] ? isoValue(intelligence.rows[0].created_at) : "NOT FOUND",
       role: snapshotRows.rows[0]?.role ?? (role === "HITTER" ? "HITTER" : "PITCHER"),
        panels: [
          ...panels,
          ...splitPanels,
          ...(intelligenceMetrics.length ? [{
            title: "Persistent historical intelligence · descriptive",
            metrics: intelligenceMetrics,
          }] : []),
        ],
      arsenal,
      notes: [
        "Every research value keeps source, definition, date range, retrieval time, denominator, sample size, and transformation status.",
        "XBH is derived only from doubles + triples + home runs. Singles are intentionally excluded.",
         role === "PITCHER"
           ? "Starter and reliever samples are labeled by source role; mixed-role source rows are never relabeled as starter-only. Vs-LHB/RHB panels use explicit batter-side evidence."
           : "Vs-LHP/RHP panels use explicit opposing-pitcher split evidence; the hitter's own batting hand is not used as a substitute.",
          ...(intelligenceMetrics.length ? ["Persistent historical intelligence is sourced from immutable canonical-ID observations; it is descriptive evidence, not a universal player score or prediction."] : []),
          ...(historicalOnly ? ["This is a historical-only profile: the player is not currently eligible for today’s operational research, so this evidence is not silently promoted into today’s slate."] : []),
      ],
    } : null,
    notices: snapshotRows.rows.length || intelligenceMetrics.length ? [] : ["NO MLB SAMPLE / SOURCE COVERAGE for this player and window. The operational shell is retained; the view intentionally does not fall back to another window."],
  };
}

export async function getPlayerLab(playerId: number | null, search: string, window: ResearchWindow, effectiveDate: string) {
  return labProfile("HITTER", playerId, search, window, effectiveDate);
}

export async function getPitcherLab(playerId: number | null, search: string, window: ResearchWindow, effectiveDate: string) {
  return labProfile("PITCHER", playerId, search, window, effectiveDate);
}

export async function researchHealth(effectiveDate: string) {
  const result = await pool.query<{
    player_profiles: number; pitcher_profiles: number; arsenal_profiles: number; park_profiles: number; identity_quarantines: number;
    insufficient_samples: number; missing_arsenal: number; missing_handedness_splits: number; metric_definition_conflicts: number; stale_windows: number;
    eligible_hitter_profiles: number; eligible_pitcher_profiles: number; hitter_profiles_missing_evidence: number; pitcher_profiles_missing_evidence: number;
     no_mlb_sample: number; source_threshold_or_unavailable: number; identity_or_eligibility_gaps: number; role_gaps: number;
     handedness_target_players: number; handedness_covered_players: number; handedness_ingest_status: string | null; park_required_venues: number; park_venue_coverage_gaps: number;
     lineup_hitters: number; lineup_hitters_missing_bats: number; slate_starters: number; slate_starters_missing_throws: number;
     players_total: number; players_missing_throws: number; players_missing_bats: number;
  }>(
    `WITH effective_day AS (
       SELECT $1::date AS effective_date
     ),
     eligible_hitters AS (
       SELECT DISTINCT pe.player_id FROM player_eligibility pe
       JOIN players p ON p.player_id = pe.player_id, effective_day d
       WHERE pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = d.effective_date
         AND pe.eligible_today_research AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
         AND COALESCE(p.primary_position, '') <> 'P'
     ),
     eligible_pitchers AS (
       SELECT DISTINCT pe.player_id FROM player_eligibility pe
       JOIN players p ON p.player_id = pe.player_id, effective_day d
       WHERE pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = d.effective_date
         AND pe.eligible_pitcher_research AND NOT pe.requires_identity_review AND NOT pe.quarantined_from_current_research
         AND p.primary_position = 'P'
      ),
      split_target_hitters AS (SELECT player_id FROM eligible_hitters),
      split_target_pitchers AS (SELECT player_id FROM eligible_pitchers),
      current_successful_split_runs AS (
        SELECT ingest_run_id FROM ingest_runs
        WHERE source_id = 'STATCAST' AND job_name = 'statcast_search_handedness_fallback'
          AND effective_date = (SELECT effective_date FROM effective_day) AND status = 'SUCCESS'
      ),
      latest_split_run AS (
        SELECT status FROM ingest_runs
        WHERE source_id = 'STATCAST' AND job_name = 'statcast_search_handedness_fallback'
          AND effective_date = (SELECT effective_date FROM effective_day)
        ORDER BY started_at DESC LIMIT 1
      ),
       -- Health reflects the current attempt for each research source/job,
       -- not every retry ever made on the slate date. Quarantine evidence
       -- remains append-only for audit; this scope prevents a safe retry from
       -- doubling the live warning count.
       latest_research_runs AS (
         SELECT DISTINCT ON (ir.source_id, ir.job_name)
           ir.ingest_run_id, ir.source_id, ir.job_name, ir.status
         FROM ingest_runs ir
          WHERE ir.effective_date = (SELECT effective_date FROM effective_day)
            AND ir.source_id = 'BALLPARK_PAL'
         ORDER BY ir.source_id, ir.job_name, ir.started_at DESC, ir.ingest_run_id DESC
       ),
      park_required_venues AS (
        SELECT DISTINCT venue_id FROM games
        WHERE game_date = (SELECT effective_date FROM effective_day) AND venue_id IS NOT NULL
      ),
      park_snapshot_quality AS (
        SELECT ps.venue_id, ps.park_research_snapshot_id, ps.season, ps.retrieved_at, f.batter_side,
          count(DISTINCT f.metric_key) FILTER (
            WHERE f.metric_key IN ('hits_factor', 'doubles_factor', 'hr_factor')
              AND f.value IS NOT NULL
          )::int AS component_count
        FROM park_research_snapshots ps
        JOIN park_research_features f ON f.park_research_snapshot_id = ps.park_research_snapshot_id
        JOIN ingest_runs ir ON ir.ingest_run_id = ps.ingest_run_id
         WHERE ps.source_id = 'BALLPARK_PAL' AND ir.effective_date = (SELECT effective_date FROM effective_day)
        GROUP BY ps.venue_id, ps.park_research_snapshot_id, ps.season, ps.retrieved_at, f.batter_side
      ),
      -- Audit S1. The platoon layer reads players.bats for the hitter and
      -- players.throws for the pitcher. Both were being overwritten with an
      -- empty string by the player upserts, and an empty string is not null:
      -- it reads as a recorded value, so resolveBatterSide returns no side and
      -- every split metric silently falls back to the unsplit season line.
      -- These are the population counters that make that visible instead.
      today_lineup_hitters AS (
        SELECT DISTINCT le.player_id
        FROM lineup_entries le
        JOIN lineup_snapshots ls ON ls.lineup_snapshot_id = le.lineup_snapshot_id
        JOIN games g ON g.game_pk = ls.game_pk
        WHERE g.game_date = (SELECT effective_date FROM effective_day)
      ),
      today_starters AS (
        SELECT DISTINCT s.player_id
        FROM starters s
        JOIN games g ON g.game_pk = s.game_pk
        WHERE g.game_date = (SELECT effective_date FROM effective_day)
          AND s.player_id IS NOT NULL
      ),
      latest_park_side AS (
        SELECT DISTINCT ON (venue_id, batter_side) venue_id, batter_side, season, component_count
        FROM park_snapshot_quality
        ORDER BY venue_id, batter_side NULLS FIRST, retrieved_at DESC
     )
     SELECT
        (SELECT count(DISTINCT player_id)::int FROM player_research_snapshots WHERE source_id = 'BALLPARK_PAL' AND effective_to = (SELECT effective_date FROM effective_day)) AS player_profiles,
        (SELECT count(DISTINCT player_id)::int FROM pitcher_research_snapshots WHERE source_id = 'BALLPARK_PAL' AND effective_to = (SELECT effective_date FROM effective_day)) AS pitcher_profiles,
        0::int AS arsenal_profiles,
        (SELECT count(DISTINCT ps.venue_id)::int FROM park_research_snapshots ps JOIN park_required_venues rv ON rv.venue_id = ps.venue_id JOIN ingest_runs ir ON ir.ingest_run_id = ps.ingest_run_id WHERE ps.source_id = 'BALLPARK_PAL' AND ir.effective_date = (SELECT effective_date FROM effective_day)) AS park_profiles,
        (SELECT count(*)::int FROM research_identity_quarantine q
          JOIN latest_research_runs lr ON lr.ingest_run_id = q.ingest_run_id) AS identity_quarantines,
       ((SELECT count(*) FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id WHERE s.effective_to = (SELECT effective_date FROM effective_day) AND f.sample_status = 'INSUFFICIENT_SAMPLE') + (SELECT count(*) FROM pitcher_research_features f JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id WHERE s.effective_to = (SELECT effective_date FROM effective_day) AND f.sample_status = 'INSUFFICIENT_SAMPLE'))::int AS insufficient_samples,
       0::int AS missing_arsenal,
      (
         (SELECT count(*) FROM split_target_hitters h WHERE NOT EXISTS (
          SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = h.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.pitcher_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST'
        ) OR NOT EXISTS (
          SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = h.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.pitcher_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST'
        ))
        +
         (SELECT count(*) FROM split_target_pitchers p WHERE NOT EXISTS (
          SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = p.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.batter_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST'
        ) OR NOT EXISTS (
          SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = p.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.batter_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST'
        ))
      )::int AS missing_handedness_splits,
       (SELECT count(*)::int FROM ingest_issues ii
          JOIN latest_research_runs lr ON lr.ingest_run_id = ii.ingest_run_id
          WHERE ii.issue_type = 'METRIC_DEFINITION_CONFLICT' AND ii.resolved_at IS NULL) AS metric_definition_conflicts,
        (SELECT count(*)::int FROM latest_research_runs WHERE status <> 'SUCCESS') AS stale_windows,
      (SELECT count(*)::int FROM eligible_hitters) AS eligible_hitter_profiles,
      (SELECT count(*)::int FROM eligible_pitchers) AS eligible_pitcher_profiles,
        (SELECT count(*)::int FROM eligible_hitters h WHERE NOT EXISTS (SELECT 1 FROM player_research_snapshots s WHERE s.player_id = h.player_id AND s.source_id = 'BALLPARK_PAL' AND s.effective_to = (SELECT effective_date FROM effective_day))) AS hitter_profiles_missing_evidence,
        (SELECT count(*)::int FROM eligible_pitchers p WHERE NOT EXISTS (SELECT 1 FROM pitcher_research_snapshots s WHERE s.player_id = p.player_id AND s.source_id = 'BALLPARK_PAL' AND s.effective_to = (SELECT effective_date FROM effective_day))) AS pitcher_profiles_missing_evidence,
      (
          0
      )::int AS no_mlb_sample,
      (
          (SELECT count(*) FROM eligible_hitters h WHERE NOT EXISTS (SELECT 1 FROM player_research_snapshots s WHERE s.player_id = h.player_id AND s.source_id = 'BALLPARK_PAL' AND s.effective_to = (SELECT effective_date FROM effective_day)))
          + (SELECT count(*) FROM eligible_pitchers p WHERE NOT EXISTS (SELECT 1 FROM pitcher_research_snapshots s WHERE s.player_id = p.player_id AND s.source_id = 'BALLPARK_PAL' AND s.effective_to = (SELECT effective_date FROM effective_day)))
      )::int AS source_threshold_or_unavailable,
      (SELECT count(*)::int FROM player_eligibility pe, effective_day d WHERE pe.source_id = 'MLB_OFFICIAL' AND pe.effective_date = d.effective_date AND (pe.requires_identity_review OR pe.quarantined_from_current_research)) AS identity_or_eligibility_gaps,
       0::int AS role_gaps,
       COALESCE((SELECT status::text FROM latest_split_run), 'NOT_RUN') AS handedness_ingest_status,
       ((SELECT count(*) FROM split_target_hitters) + (SELECT count(*) FROM split_target_pitchers))::int AS handedness_target_players,
       (
         (SELECT count(*) FROM split_target_hitters h WHERE EXISTS (
           SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = h.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.pitcher_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST'
         ) AND EXISTS (
           SELECT 1 FROM player_research_features f JOIN player_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = h.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.pitcher_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST'
         ))
         + (SELECT count(*) FROM split_target_pitchers p WHERE EXISTS (
           SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = p.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.batter_side = 'L' AND f.transformation = 'DERIVED_FROM_STATCAST'
         ) AND EXISTS (
           SELECT 1 FROM pitcher_research_features f JOIN pitcher_research_snapshots s ON s.research_snapshot_id = f.research_snapshot_id
           WHERE s.player_id = p.player_id AND s.source_id = 'STATCAST' AND s.research_window = 'SEASON' AND s.effective_to = (SELECT effective_date FROM effective_day) AND s.ingest_run_id IN (SELECT ingest_run_id FROM current_successful_split_runs) AND f.batter_side = 'R' AND f.transformation = 'DERIVED_FROM_STATCAST'
         ))
       )::int AS handedness_covered_players,
       (SELECT count(*)::int FROM park_required_venues) AS park_required_venues,
       (SELECT count(*)::int FROM park_required_venues v WHERE
         NOT EXISTS (SELECT 1 FROM latest_park_side p WHERE p.venue_id = v.venue_id AND p.batter_side IS NULL AND p.season = EXTRACT(YEAR FROM (SELECT effective_date FROM effective_day))::int AND p.component_count = 3)
       ) AS park_venue_coverage_gaps,
       -- Audit S1 population counters. Null and '' are counted together
       -- deliberately: both mean the handedness is not usable, and the whole
       -- point of the S1 fix is that the second should stop being written.
       (SELECT count(*)::int FROM today_lineup_hitters) AS lineup_hitters,
       (SELECT count(*)::int FROM today_lineup_hitters h JOIN players p ON p.player_id = h.player_id
         WHERE p.bats IS NULL OR btrim(p.bats) = '') AS lineup_hitters_missing_bats,
       (SELECT count(*)::int FROM today_starters) AS slate_starters,
       (SELECT count(*)::int FROM today_starters t JOIN players p ON p.player_id = t.player_id
         WHERE p.throws IS NULL OR btrim(p.throws) = '') AS slate_starters_missing_throws,
       -- The whole-table rate, which is the number the remediation plan asked
       -- for and which cannot be answered from code alone.
       (SELECT count(*)::int FROM players) AS players_total,
       (SELECT count(*)::int FROM players WHERE throws IS NULL OR btrim(throws) = '') AS players_missing_throws,
       (SELECT count(*)::int FROM players WHERE bats IS NULL OR btrim(bats) = '') AS players_missing_bats`,
    [effectiveDate],
  );
  const row = result.rows[0];
  return {
    playerProfiles: row?.player_profiles ?? 0,
    pitcherProfiles: row?.pitcher_profiles ?? 0,
    arsenalProfiles: row?.arsenal_profiles ?? 0,
    parkProfiles: row?.park_profiles ?? 0,
    identityQuarantines: row?.identity_quarantines ?? 0,
    insufficientSamples: row?.insufficient_samples ?? 0,
    missingArsenal: 0,
    missingHandednessSplits: 0,
    metricDefinitionConflicts: row?.metric_definition_conflicts ?? 0,
    staleWindows: row?.stale_windows ?? 0,
    eligibleHitterProfiles: row?.eligible_hitter_profiles ?? 0,
    eligiblePitcherProfiles: row?.eligible_pitcher_profiles ?? 0,
    hitterProfilesMissingEvidence: row?.hitter_profiles_missing_evidence ?? 0,
    pitcherProfilesMissingEvidence: row?.pitcher_profiles_missing_evidence ?? 0,
    noMlbSample: 0,
    sourceThresholdOrUnavailable: row?.source_threshold_or_unavailable ?? 0,
    identityOrEligibilityGaps: row?.identity_or_eligibility_gaps ?? 0,
    roleGaps: row?.role_gaps ?? 0,
    handednessCoverageScope: "FULL_ELIGIBLE_HITTER_AND_PITCHER_UNIVERSE",
    handednessIngestStatus: "NOT_RUN",
    handednessTargetPlayers: 0,
    handednessCoveredPlayers: 0,
    parkRequiredVenues: row?.park_required_venues ?? 0,
    parkVenueCoverageGaps: row?.park_venue_coverage_gaps ?? 0,
    handednessPopulationScope: "TODAY_LINEUP_HITTERS_AND_SLATE_STARTERS",
    lineupHitters: row?.lineup_hitters ?? 0,
    lineupHittersMissingBats: row?.lineup_hitters_missing_bats ?? 0,
    slateStarters: row?.slate_starters ?? 0,
    slateStartersMissingThrows: row?.slate_starters_missing_throws ?? 0,
    playersTotal: row?.players_total ?? 0,
    playersMissingThrows: row?.players_missing_throws ?? 0,
    playersMissingBats: row?.players_missing_bats ?? 0,
  };
}
