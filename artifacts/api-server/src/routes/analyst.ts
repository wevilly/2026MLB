import { Router, type IRouter } from "express";
import {
  GetAnalystDataHealthResponse,
  GetAnalystProjectionsResponse,
  GetAnalystSettingsResponse,
  GetAnalystTodayResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const fantasyProsConfigured = Boolean(process.env["FANTASYPROS_API_KEY"]);

const sources = [
  {
    name: "MLB Official",
    status: "NOT RUN",
    freshness: "No successful ingest",
    lastSuccess: null,
    rowCount: 0,
    detail: "Official schedule adapter has not run yet",
  },
  {
    name: "FantasyPros",
    status: fantasyProsConfigured ? "NOT RUN" : "NOT CONFIGURED",
    freshness: fantasyProsConfigured ? "No successful ingest" : "Credential not configured",
    lastSuccess: null,
    rowCount: 0,
    detail: fantasyProsConfigured
      ? "Credential present; daily adapter has not run yet"
      : "FantasyPros credential is required for projection ingestion",
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
  games: [],
  sources,
  alerts: [
    "No MLB official schedule ingest has completed",
    fantasyProsConfigured
      ? "FantasyPros credential is present, but no snapshots have been ingested"
      : "FantasyPros projections are unavailable until a credential is configured",
    "Weather source is not configured; park conditions remain NOT FOUND",
  ],
};

const projections = {
  snapshotLabel: fantasyProsConfigured
    ? "FantasyPros · waiting for first ingest"
    : "FantasyPros · credential required",
  currentAsOf: "NOT FOUND",
  priorAsOf: null,
  rows: [],
  systemNotes: [
    "No FantasyPros snapshots are stored yet, so no projection values are displayed.",
    "When ingested, every FantasyPros pull is immutable; current and prior views are never averaged together.",
    "Internal and market systems are intentionally unavailable in Phase 1.",
  ],
};

const dataHealth = {
  overall: "DEGRADED",
  sources,
  issues: [
    { label: "MLB official ingest", detail: "No completed schedule/game ingest exists yet.", severity: "BLOCKING" },
    { label: "FantasyPros ingest", detail: fantasyProsConfigured ? "Credential is present, but no snapshots are stored." : "Credential is not configured; no snapshots can be ingested.", severity: "BLOCKING" },
    { label: "Weather adapter", detail: "No provider configured. Park conditions remain NOT FOUND.", severity: "INFO" },
  ],
  lastRun: "No completed ingestion runs recorded",
};

const settings = {
  connections: [
    { name: "FantasyPros", configured: fantasyProsConfigured, detail: fantasyProsConfigured ? "Secret present · server-side only" : "Not configured" },
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