import { Router, type IRouter } from "express";
import {
  GetAnalystDataHealthResponse,
  GetAnalystProjectionsResponse,
  GetAnalystSettingsResponse,
  GetAnalystTodayResponse,
} from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { ingestFantasyPros, ingestMlbOfficial } from "../services/data-foundation";

const router: IRouter = Router();
const fantasyProsConfigured = Boolean(process.env.FANTASYPROS_API_KEY);

function requestedDate(value: unknown) {
  const date = typeof value === "string" ? value : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");
  return date;
}

function displayTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(value))
    : "TBD";
}

function isoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

async function sourceBadges() {
  const runs = await pool.query<{
    source_id: string;
    status: string;
    finished_at: string | null;
    row_count: number | null;
    normalized_row_count: number | null;
    rejected_row_count: number | null;
     http_status: number | null;
     duration_ms: number | null;
    error_message: string | null;
  }>(
    `SELECT DISTINCT ON (source_id) source_id, status, finished_at, row_count, normalized_row_count, rejected_row_count, http_status, duration_ms, error_message
     FROM ingest_runs
     WHERE source_id IN ('MLB_OFFICIAL', 'FANTASYPROS')
     ORDER BY source_id, started_at DESC`,
  );
  const bySource = new Map(runs.rows.map((row) => [row.source_id, row]));
  const makeBadge = (sourceId: string, name: string, configured: boolean) => {
    const run = bySource.get(sourceId);
    if (!configured) return { name, status: "NOT CONFIGURED", freshness: "Credential missing", lastSuccess: null, rowCount: 0, detail: "A server-side credential is required." };
    if (!run) return { name, status: "NOT RUN", freshness: "No successful ingest", lastSuccess: null, rowCount: 0, detail: "No ingestion run has completed." };
    const status = run.status === "SUCCESS" ? "FRESH" : run.status === "PARTIAL" ? "PARTIAL" : "BLOCKED";
    const detail = run.error_message
      ? run.error_message
      : `${run.normalized_row_count ?? 0} normalized · ${run.rejected_row_count ?? 0} rejected${run.http_status ? ` · HTTP ${run.http_status}` : ""}${run.duration_ms ? ` · ${run.duration_ms}ms` : ""}`;
    return {
      name,
      status,
      freshness: run.finished_at ? `Last attempt ${new Date(run.finished_at).toLocaleString("en-US", { timeZone: "America/New_York" })}` : "In progress",
      lastSuccess: run.status === "SUCCESS" || run.status === "PARTIAL" ? isoString(run.finished_at) : null,
      rowCount: run.row_count ?? 0,
      detail,
    };
  };
  return [
    makeBadge("MLB_OFFICIAL", "MLB Official", true),
    makeBadge("FANTASYPROS", "FantasyPros", fantasyProsConfigured),
    { name: "Weather", status: "NOT CONFIGURED", freshness: "No provider", lastSuccess: null, rowCount: 0, detail: "Optional source; no weather credential is configured." },
  ];
}

router.get("/analyst/today", async (req, res, next) => {
  try {
    const date = requestedDate(req.query.date);
    const [gameResult, sources] = await Promise.all([
      pool.query<{
        game_pk: number; start_time_utc: string | null; away: string; home: string; park: string | null;
         away_starter: string | null; home_starter: string | null; away_hand: string | null; home_hand: string | null;
         away_state: string | null; home_state: string | null; posted_lineup_teams: number; projected_lineup_teams: number;
      }>(
        `SELECT g.game_pk, g.start_time_utc, away.abbreviation AS away, home.abbreviation AS home, v.name AS park,
          away_start.full_name AS away_starter, home_start.full_name AS home_starter,
          away_start.throws AS away_hand, home_start.throws AS home_hand,
          away_start.starter_state AS away_state, home_start.starter_state AS home_state,
          COALESCE(lineups.posted_lineup_teams, 0) AS posted_lineup_teams,
          COALESCE(lineups.projected_lineup_teams, 0) AS projected_lineup_teams
         FROM games g
         JOIN teams away ON away.team_id = g.away_team_id
         JOIN teams home ON home.team_id = g.home_team_id
         LEFT JOIN venues v ON v.venue_id = g.venue_id
         LEFT JOIN LATERAL (
            SELECT s.starter_state, p.full_name, p.throws FROM starters s LEFT JOIN players p ON p.player_id = s.player_id
           WHERE s.game_pk = g.game_pk AND s.team_id = g.away_team_id ORDER BY s.observed_at DESC LIMIT 1
         ) away_start ON true
         LEFT JOIN LATERAL (
            SELECT s.starter_state, p.full_name, p.throws FROM starters s LEFT JOIN players p ON p.player_id = s.player_id
           WHERE s.game_pk = g.game_pk AND s.team_id = g.home_team_id ORDER BY s.observed_at DESC LIMIT 1
         ) home_start ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(DISTINCT team_id) FILTER (WHERE state = 'POSTED')::int AS posted_lineup_teams,
                   COUNT(DISTINCT team_id) FILTER (WHERE state = 'PROJECTED')::int AS projected_lineup_teams
            FROM lineup_snapshots WHERE game_pk = g.game_pk
          ) lineups ON true
         WHERE g.game_date = $1 ORDER BY g.start_time_utc NULLS LAST`,
        [date],
      ),
      sourceBadges(),
    ]);
    const games = gameResult.rows.map((game) => ({
      id: String(game.game_pk),
      time: displayTime(game.start_time_utc),
      away: game.away,
      home: game.home,
      park: game.park ?? "NOT FOUND",
      roof: "NOT FOUND",
      weather: "NOT FOUND",
      awayStarter: { name: game.away_starter ?? "TBD", hand: game.away_hand || "NOT FOUND", state: game.away_state ?? "TBD", note: "" },
      homeStarter: { name: game.home_starter ?? "TBD", hand: game.home_hand || "NOT FOUND", state: game.home_state ?? "TBD", note: "" },
      lineupState: game.posted_lineup_teams === 2 ? "POSTED" : game.projected_lineup_teams > 0 ? "PROJECTED" : "UNKNOWN",
      state: game.posted_lineup_teams === 2 && game.away_state === "CONFIRMED" && game.home_state === "CONFIRMED"
        ? "READY"
        : "PARTIAL",
      flag: game.posted_lineup_teams === 2
        ? "Official posted lineups persisted"
        : game.projected_lineup_teams > 0
          ? "FantasyPros projected lineup evidence"
          : "No lineup evidence found",
    }));
    const today = {
      date: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date(`${date}T12:00:00Z`)),
      timezone: "America/New_York",
      games,
      sources,
      alerts: [
        "Pre-model slate status uses READY, PARTIAL, and BLOCKED only.",
        "No forecast, price, odds, implied probability, EV, or CLV data is used in this workflow.",
        games.length ? "Official schedule and starter observations are persisted." : "No official schedule records have been ingested for this date.",
      ],
    };
    res.json(GetAnalystTodayResponse.parse(today));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/projections", async (req, res, next) => {
  try {
    const snapshots = await pool.query<{ snapshot_id: string; retrieved_at: string; snapshot_label: string | null }>(
      `SELECT DISTINCT ON (snapshot_label) snapshot_id, retrieved_at, snapshot_label FROM fantasypros_projection_snapshots
       ORDER BY snapshot_label, retrieved_at DESC`,
    );
    const currentAsOf = snapshots.rows.reduce<string | null>((latest, snapshot) => !latest || snapshot.retrieved_at > latest ? snapshot.retrieved_at : latest, null);
    type ProjectionDbRow = {
      source_player_id: string;
      team_abbreviation: string | null;
      position: string | null;
      projected_stats: Record<string, unknown>;
      raw_row: Record<string, unknown>;
    };
    const rows: ProjectionDbRow[] = snapshots.rows.length
      ? (await pool.query<ProjectionDbRow>(
        `SELECT source_player_id, team_abbreviation, position, projected_stats, raw_row
         FROM fantasypros_projection_rows WHERE snapshot_id = ANY($1) ORDER BY team_abbreviation, source_player_id LIMIT 500`,
        [snapshots.rows.map((snapshot) => snapshot.snapshot_id)],
      )).rows
      : [];
    const playerFilter = String(req.query.player ?? "").trim().toLowerCase();
    const teamFilter = String(req.query.team ?? "").trim().toLowerCase();
    const roleFilter = String(req.query.role ?? "").trim().toLowerCase();
    const projectionRows = rows.filter((row) => {
      const player = String(row.raw_row?.player_name ?? row.raw_row?.name ?? row.source_player_id).toLowerCase();
      return (!playerFilter || player.includes(playerFilter))
        && (!teamFilter || String(row.team_abbreviation ?? "").toLowerCase() === teamFilter)
        && (!roleFilter || String(row.position ?? "").toLowerCase() === roleFilter);
    }).flatMap((row) => {
      const stats = row.projected_stats ?? {};
      const player = String(row.raw_row?.player_name ?? row.raw_row?.name ?? row.source_player_id);
      const base = { player, team: row.team_abbreviation ?? "—", position: row.position ?? "—", prior: null, asOf: isoString(currentAsOf) ?? "NOT FOUND", movement: "No prior snapshot" };
      return [
        { ...base, market: "2+ Total Bases", current: null, movement: "Model not built" },
        { ...base, market: "1+ XBH", current: null, movement: "Components only · no derivation" },
        { ...base, market: "Batter Walk", current: typeof stats.bb === "number" ? stats.bb : null, movement: "Source component" },
        { ...base, market: "Home Run", current: typeof stats.hrs === "number" ? stats.hrs : null, movement: "Source component" },
      ];
    });
    res.json(GetAnalystProjectionsResponse.parse({
      snapshotLabel: snapshots.rows.length ? "FantasyPros · current hitter and pitcher snapshots" : (fantasyProsConfigured ? "FantasyPros · waiting for first ingest" : "FantasyPros · credential required"),
      currentAsOf: isoString(currentAsOf) ?? "NOT FOUND",
      priorAsOf: null,
      rows: projectionRows,
      systemNotes: [
        "Each FantasyPros response is stored as an immutable snapshot with raw payload metadata and checksum.",
        "Walk and home run cells are source components, not predicted market probabilities.",
        "2+ Total Bases and 1+ XBH remain explicitly unmodeled until validated research engines exist.",
      ],
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/data-health", async (_req, res, next) => {
  try {
    const [sources, issueResult, lastRun] = await Promise.all([
      sourceBadges(),
      pool.query<{ issue_type: string; detail: string; severity: string }>(
        `SELECT issue_type, detail, severity FROM ingest_issues WHERE resolved_at IS NULL
         UNION ALL
         SELECT 'IDENTITY_REVIEW' AS issue_type, CONCAT(raw_name, ' (FantasyPros ID ', external_player_id, ') requires review') AS detail, 'REVIEW' AS severity
         FROM identity_review_queue WHERE state = 'OPEN'
         ORDER BY issue_type LIMIT 50`,
      ),
      pool.query<{ finished_at: string | null }>("SELECT max(finished_at) AS finished_at FROM ingest_runs"),
    ]);
    const sourceStatus = sources.some((source) => source.status === "BLOCKED" || source.status === "NOT RUN") ? "BLOCKED"
      : sources.some((source) => source.status === "PARTIAL" || source.status === "NOT CONFIGURED") ? "PARTIAL"
        : "READY";
    res.json(GetAnalystDataHealthResponse.parse({
      overall: sourceStatus,
      sources,
      issues: issueResult.rows.map((issue) => ({ label: issue.issue_type.replaceAll("_", " "), detail: issue.detail, severity: issue.severity })),
      lastRun: isoString(lastRun.rows[0]?.finished_at) ?? "No completed ingestion runs recorded",
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/analyst/settings", (_req, res) => {
  res.json(GetAnalystSettingsResponse.parse({
    connections: [
      { name: "FantasyPros", configured: fantasyProsConfigured, detail: fantasyProsConfigured ? "Secret present · server-side only" : "Not configured" },
      { name: "MLB Official", configured: true, detail: "Public official Stats API adapter" },
      { name: "Weather", configured: false, detail: "Optional source not configured" },
    ],
    timezone: "America/New_York",
    defaultMarket: "2+ total bases",
    refreshCadence: "Manual refresh during data foundation",
  }));
});

router.post("/analyst/refresh/mlb", async (req, res, next) => {
  try {
    res.status(201).json(await ingestMlbOfficial(requestedDate(req.query.date)));
  } catch (error) {
    next(error);
  }
});

router.post("/analyst/refresh/fantasypros", async (req, res, next) => {
  try {
    res.status(201).json(await ingestFantasyPros(requestedDate(req.query.date)));
  } catch (error) {
    next(error);
  }
});

export default router;