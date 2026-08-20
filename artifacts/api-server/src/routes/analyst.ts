import { Router, type IRouter } from "express";
import {
  GetAnalystDataHealthResponse,
  GetAnalystProjectionsResponse,
  GetAnalystSettingsResponse,
  GetAnalystTodayResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const sources = [
  {
    name: "MLB Official",
    status: "HEALTHY",
    freshness: "12 min ago",
    lastSuccess: "2026-08-20T19:38:00Z",
    rowCount: 240,
    detail: "Schedule, teams, starters and game state",
  },
  {
    name: "FantasyPros",
    status: "HEALTHY",
    freshness: "27 min ago",
    lastSuccess: "2026-08-20T19:23:00Z",
    rowCount: 1184,
    detail: "Daily hitter, pitcher and lineup snapshots",
  },
  {
    name: "Weather",
    status: "NOT CONFIGURED",
    freshness: "No provider",
    lastSuccess: null,
    rowCount: 0,
    detail: "Optional source; no weather credentials configured",
  },
];

const today = {
  date: "Thu, Aug 20, 2026",
  timezone: "America/New_York",
  games: [
    {
      id: "mlb-2026-08-20-nyy-bos",
      time: "1:05 PM",
      away: "NYY",
      home: "BOS",
      park: "Fenway Park",
      roof: "Open",
      weather: "NOT FOUND",
      awayStarter: { name: "M. Fried", hand: "L", state: "CONFIRMED", note: "Official" },
      homeStarter: { name: "T. Houck", hand: "R", state: "PROBABLE", note: "MLB probable" },
      lineupState: "PROJECTED",
      state: "FIRE",
      flag: "Home starter not official",
    },
    {
      id: "mlb-2026-08-20-lad-sd",
      time: "4:10 PM",
      away: "LAD",
      home: "SD",
      park: "Petco Park",
      roof: "Open",
      weather: "NOT FOUND",
      awayStarter: { name: "Y. Yamamoto", hand: "R", state: "CONFIRMED", note: "Official" },
      homeStarter: { name: "D. Cease", hand: "R", state: "CONFIRMED", note: "Official" },
      lineupState: "POSTED",
      state: "HALF",
      flag: null,
    },
    {
      id: "mlb-2026-08-20-ast-kc",
      time: "8:10 PM",
      away: "HOU",
      home: "KC",
      park: "Kauffman Stadium",
      roof: "Open",
      weather: "NOT FOUND",
      awayStarter: { name: "TBD", hand: "—", state: "TBD", note: "Awaiting official state" },
      homeStarter: { name: "S. Lugo", hand: "R", state: "PROBABLE", note: "MLB probable" },
      lineupState: "NOT FOUND",
      state: "HOLD",
      flag: "Starter and lineup block",
    },
  ],
  sources,
  alerts: [
    "3 projected lineups remain unposted",
    "Weather source is not configured; park conditions remain NOT FOUND",
    "1 starter identity is still unresolved",
  ],
};

const projections = {
  snapshotLabel: "FantasyPros · latest of 4 daily snapshots",
  currentAsOf: "Thu, Aug 20 · 2:40 PM ET",
  priorAsOf: "Thu, Aug 20 · 9:12 AM ET",
  rows: [
    { player: "Aaron Judge", team: "NYY", position: "OF", market: "HR", current: 0.34, prior: 0.31, asOf: "2:40 PM ET", movement: "UP" },
    { player: "Rafael Devers", team: "BOS", position: "3B", market: "2+ TB", current: 0.27, prior: 0.28, asOf: "2:40 PM ET", movement: "DOWN" },
    { player: "Fernando Tatis Jr.", team: "SD", position: "OF", market: "2+ TB", current: 0.29, prior: 0.25, asOf: "2:40 PM ET", movement: "UP" },
    { player: "Bobby Witt Jr.", team: "KC", position: "SS", market: "Walk", current: 0.18, prior: null, asOf: "2:40 PM ET", movement: "NEW" },
    { player: "Freddie Freeman", team: "LAD", position: "1B", market: "Walk", current: 0.22, prior: 0.22, asOf: "2:40 PM ET", movement: "FLAT" },
  ],
  systemNotes: [
    "Our baseline, research-adjusted and market-implied systems are not active in Phase 1.",
    "FantasyPros snapshots are immutable; current and prior views are never averaged together.",
    "No row below should be interpreted as a betting probability.",
  ],
};

const dataHealth = {
  overall: "DEGRADED",
  sources,
  issues: [
    { label: "Weather adapter", detail: "No provider configured. Park conditions remain NOT FOUND.", severity: "BLOCKING" },
    { label: "Identity review", detail: "1 external player ID requires manual resolution.", severity: "REVIEW" },
    { label: "Lineup state", detail: "3 games are still PROJECTED or NOT FOUND.", severity: "INFO" },
  ],
  lastRun: "Last ingest run · 2:40 PM ET · completed with warnings",
};

const settings = {
  connections: [
    { name: "FantasyPros", configured: true, detail: "Secret present · server-side only" },
    { name: "OpenAI", configured: false, detail: "Live AI disabled for Phase 1" },
    { name: "Odds provider", configured: false, detail: "Optional source not configured" },
    { name: "Weather provider", configured: false, detail: "Optional source not configured" },
  ],
  timezone: "America/New_York",
  defaultMarket: "2+ total bases",
  refreshCadence: "Every 30 minutes",
};

router.get("/analyst/today", (_req, res) => {
  res.json(GetAnalystTodayResponse.parse(today));
});

router.get("/analyst/projections", (_req, res) => {
  res.json(GetAnalystProjectionsResponse.parse(projections));
});

router.get("/analyst/data-health", (_req, res) => {
  res.json(GetAnalystDataHealthResponse.parse(dataHealth));
});

router.get("/analyst/settings", (_req, res) => {
  res.json(GetAnalystSettingsResponse.parse(settings));
});

export default router;