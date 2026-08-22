import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  integer,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const ingestStatusEnum = pgEnum("ingest_status", [
  "RUNNING",
  "SUCCESS",
  "PARTIAL",
  "FAILED",
]);

export const orchestrationTriggerEnum = pgEnum("orchestration_trigger", [
  "SCHEDULED",
  "OPERATOR",
]);

export const orchestrationStatusEnum = pgEnum("orchestration_status", [
  "RUNNING",
  "COMPLETE",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);

export const sourceTypeEnum = pgEnum("source_type", [
  "OFFICIAL",
  "PROJECTION",
  "NEWS",
  "WEATHER",
  "RESEARCH",
]);

export const starterStateEnum = pgEnum("starter_state", [
  "CONFIRMED",
  "PROBABLE",
  "TBD",
  "OPENER",
  "BULK",
  "UNKNOWN",
]);

export const lineupStateEnum = pgEnum("lineup_state", [
  "PROJECTED",
  "POSTED",
  "UPDATED",
  "SCRATCHED",
  "UNKNOWN",
]);

export const identityConfidenceEnum = pgEnum("identity_confidence", [
  "CONFIRMED",
  "HIGH_CONFIDENCE",
  "REVIEW_REQUIRED",
]);

export const playerEligibilityStatusEnum = pgEnum("player_eligibility_status", [
  "MLB_ACTIVE",
  "MLB_40_MAN",
  "MLB_IL",
  "MLB_OPTIONED",
  "MINOR_LEAGUE",
  "FREE_AGENT",
  "HISTORICAL",
  "RETIRED",
  "UNKNOWN",
]);

export const marketTypeEnum = pgEnum("market_type", [
  "TOTAL_BASES_2_PLUS",
  "EXTRA_BASE_HIT",
  "BATTER_WALK",
  "HOME_RUN",
]);

/**
 * Bettor evidence may only reference mechanisms already approved by the
 * Phase 3 research engines. This is intentionally a union: the API validates
 * market-specific meaning, while the database prevents free-form categories.
 */
export const bettorMechanismEnum = pgEnum("bettor_mechanism", [
  "CONTACT_VOLUME",
  "POWER_ROUTE",
  "MULTI_PATH",
  "DOUBLE_ROUTE",
  "TRIPLE_ROUTE",
  "HOME_RUN_ROUTE",
  "PATIENCE_VS_COMMAND",
  "COUNT_CREATION",
  "BULLPEN_WALK_PATH",
  "PULL_AIR",
  "BARREL_POWER",
  "PITCH_SHAPE_MISMATCH",
  "PARK_ENVIRONMENT",
]);

export const bettorPickDirectionEnum = pgEnum("bettor_pick_direction", [
  "YES",
  "NO",
]);

export const bettorDuplicationFlagEnum = pgEnum("bettor_duplication_flag", [
  "INDEPENDENT",
  "IS_LIKELY_COPY",
]);

/**
 * AI tools are a deliberately narrow read gateway. There is no write-capable
 * access level: the application must never grant an agent a mutation tool.
 */
export const aiToolAccessLevelEnum = pgEnum("ai_tool_access_level", [
  "READ_ONLY",
]);

export const aiToolCallStatusEnum = pgEnum("ai_tool_call_status", [
  "SUCCESS",
  "REJECTED",
  "ERROR",
]);

export const aiResearchDraftStatusEnum = pgEnum("ai_research_draft_status", [
  "DRAFT",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
]);

export const aiSourcingSourceTypeEnum = pgEnum("ai_sourcing_source_type", [
  "WEB",
  "INTERNAL_RESEARCH",
  "BETTOR_PICK",
]);

export const settlementStateEnum = pgEnum("settlement_state", [
  "PENDING",
  "SETTLED",
  "POSTPONED",
  "NO_ACTION",
  "DISPUTED",
]);

export const modelVersionStatusEnum = pgEnum("model_version_status", [
  "DRAFT",
  "CANDIDATE",
  "ACTIVE",
  "RETIRED",
  "FAILED",
]);

export const modelTrainingStatusEnum = pgEnum("model_training_status", [
  "RUNNING",
  "SUCCESS",
  "FAILED",
]);

export const walkForwardStatusEnum = pgEnum("walk_forward_status", [
  "PASS",
  "FAIL",
  "INCOMPLETE",
]);

export const confidenceLabelEnum = pgEnum("confidence_label", [
  "FIRE",
  "HALF",
  "HOLD",
  "NONE",
]);

export const confidenceBasisEnum = pgEnum("confidence_basis", [
  "RESEARCH_ONLY",
  "MODEL_CONFIRMED",
  "MODEL_REJECTED",
]);

export const researchWindowEnum = pgEnum("research_window", [
  "SEASON",
  "CAREER",
  "ROLLING_7",
  "ROLLING_14",
  "ROLLING_30",
  "ROLLING_60",
]);

export const researchTransformEnum = pgEnum("research_transform", [
  "RAW",
  "NORMALIZED",
  "DERIVED",
  "DERIVED_FROM_STATCAST",
  "HEURISTIC",
]);

export const researchSampleStatusEnum = pgEnum("research_sample_status", [
  "AVAILABLE",
  "INSUFFICIENT_SAMPLE",
  "NOT_FOUND",
  "QUARANTINED",
]);

export const pitcherRoleEnum = pgEnum("pitcher_research_role", [
  "STARTER",
  "RELIEVER",
  "MIXED",
  "UNKNOWN",
]);

export const sourceRegistry = pgTable("source_registry", {
  sourceId: text("source_id").primaryKey(),
  name: text("name").notNull(),
  sourceType: sourceTypeEnum("source_type").notNull(),
  baseUrl: text("base_url"),
  priority: integer("priority").notNull().default(100),
  active: boolean("active").notNull().default(true),
  expectedFreshnessMinutes: integer("expected_freshness_minutes"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A bettor/capper identity at the platform-account level. personIdentityKey
 * is an operator-supplied stable identity when the same person is identified
 * across multiple platforms; it is deliberately nullable when unknown.
 */
export const bettorSources = pgTable(
  "bettor_sources",
  {
    sourceId: uuid("source_id").primaryKey().defaultRandom(),
    platform: text("platform").notNull(),
    accountHandle: text("account_handle").notNull(),
    personIdentityKey: text("person_identity_key"),
    personLevelCrossPlatform: boolean("person_level_cross_platform").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platformAccountIdx: uniqueIndex("bettor_sources_platform_account_idx").on(
      table.platform,
      table.accountHandle,
    ),
    personIdentityIdx: index("bettor_sources_person_identity_idx").on(table.personIdentityKey),
    identityTextCheck: check(
      "bettor_sources_identity_text_check",
      sql`char_length(btrim(${table.platform})) BETWEEN 1 AND 160
        AND char_length(btrim(${table.accountHandle})) BETWEEN 1 AND 160
        AND (${table.personIdentityKey} IS NULL
          OR char_length(btrim(${table.personIdentityKey})) BETWEEN 1 AND 160)`,
    ),
  }),
);

export const ingestRuns = pgTable("ingest_runs", {
  ingestRunId: uuid("ingest_run_id").primaryKey().defaultRandom(),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  jobName: text("job_name").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: ingestStatusEnum("status").notNull(),
  effectiveDate: date("effective_date"),
  rowCount: integer("row_count"),
  normalizedRowCount: integer("normalized_row_count"),
  rejectedRowCount: integer("rejected_row_count"),
  httpStatus: integer("http_status"),
  durationMs: integer("duration_ms"),
  rawChecksum: text("raw_checksum"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata").notNull().default({}),
});

/**
 * The orchestration record is the operational ledger for a daily slate. Steps
 * are deliberately retained as JSON so a failed or interrupted run keeps its
 * exact timeline without mutating the individual source-run records.
 */
export const orchestrationRuns = pgTable("orchestration_runs", {
  runId: uuid("run_id").primaryKey().defaultRandom(),
  runDate: date("run_date").notNull(),
  triggeredBy: orchestrationTriggerEnum("triggered_by").notNull(),
  overallStatus: orchestrationStatusEnum("overall_status").notNull().default("RUNNING"),
  steps: jsonb("steps").notNull().default([]),
  schedule: jsonb("schedule").notNull().default({}),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => ({
  runDateIdx: index("orchestration_runs_run_date_idx").on(table.runDate, table.createdAt),
  activeRunIdx: index("orchestration_runs_active_idx").on(table.overallStatus, table.createdAt),
}));

/**
 * Durable scheduler state for the post-game official settlement job. A failed
 * run deliberately remains retryable so a process restart cannot silently
 * leave a prior slate unsettled.
 */
export const settlementAutomationRuns = pgTable("settlement_automation_runs", {
  slateDate: date("slate_date").primaryKey(),
  status: text("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  result: jsonb("result").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  statusCheck: check(
    "settlement_automation_runs_status_check",
    sql`${table.status} IN ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED')`,
  ),
  retryIdx: index("settlement_automation_runs_retry_idx").on(table.status, table.nextAttemptAt),
}));

/** Append-only, user-facing audit events for operational actions. */
export const auditEvents = pgTable("audit_events", {
  auditEventId: uuid("audit_event_id").primaryKey().defaultRandom(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  requestId: text("request_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  metadata: jsonb("metadata").notNull().default({}),
}, (table) => ({
  occurredAtIdx: index("audit_events_occurred_at_idx").on(table.occurredAt),
  resourceIdx: index("audit_events_resource_idx").on(table.resourceType, table.resourceId),
}));

export const ingestIssues = pgTable("ingest_issues", {
  issueId: uuid("issue_id").primaryKey().defaultRandom(),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  sourceId: text("source_id").references(() => sourceRegistry.sourceId),
  issueType: text("issue_type").notNull(),
  severity: text("severity").notNull(),
  entityType: text("entity_type"),
  entityKey: text("entity_key"),
  detail: text("detail").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  latestSeenAt: timestamp("latest_seen_at", { withTimezone: true }).notNull().defaultNow(),
  state: text("state").notNull().default("OPEN"),
  resolutionNote: text("resolution_note"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rawPayloads = pgTable("raw_payloads", {
  rawPayloadId: uuid("raw_payload_id").primaryKey().defaultRandom(),
  ingestRunId: uuid("ingest_run_id").notNull().references(() => ingestRuns.ingestRunId),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  payloadType: text("payload_type").notNull(),
  effectiveDate: date("effective_date"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  checksum: text("checksum").notNull(),
  objectPath: text("object_path"),
  byteCount: integer("byte_count"),
  metadata: jsonb("metadata").notNull().default({}),
});

export const teams = pgTable("teams", {
  teamId: integer("team_id").primaryKey(),
  abbreviation: text("abbreviation").notNull(),
  name: text("name").notNull(),
  league: text("league"),
  division: text("division"),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  playerId: integer("player_id").primaryKey(),
  fullName: text("full_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  bats: text("bats"),
  throws: text("throws"),
  primaryPosition: text("primary_position"),
  birthDate: date("birth_date"),
  active: boolean("active").notNull().default(true),
  currentTeamId: integer("current_team_id").references(() => teams.teamId),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playerAliases = pgTable(
  "player_aliases",
  {
    aliasId: uuid("alias_id").primaryKey().defaultRandom(),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    sourceId: text("source_id").references(() => sourceRegistry.sourceId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    normalizedAliasIdx: uniqueIndex("player_aliases_normalized_alias_idx").on(
      table.normalizedAlias,
      table.sourceId,
    ),
  }),
);

export const playerExternalIds = pgTable(
  "player_external_ids",
  {
    playerId: integer("player_id").notNull().references(() => players.playerId),
    sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
    externalPlayerId: text("external_player_id").notNull(),
    confidence: identityConfidenceEnum("confidence").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    provenance: jsonb("provenance").notNull().default({}),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalIdIdx: uniqueIndex("player_external_ids_source_external_idx").on(
      table.sourceId,
      table.externalPlayerId,
    ),
    playerSourcePk: primaryKey({ columns: [table.playerId, table.sourceId] }),
  }),
);

export const playerExternalIdAliases = pgTable(
  "player_external_id_aliases",
  {
    aliasLinkId: uuid("alias_link_id").primaryKey().defaultRandom(),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
    externalPlayerId: text("external_player_id").notNull(),
    linkType: text("link_type").notNull().default("ALIAS"),
    evidence: jsonb("evidence").notNull().default({}),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceExternalAliasIdx: uniqueIndex("player_external_id_aliases_source_external_idx").on(
      table.sourceId,
      table.externalPlayerId,
    ),
  }),
);

export const playerEligibility = pgTable(
  "player_eligibility",
  {
    eligibilityId: uuid("eligibility_id").primaryKey().defaultRandom(),
    playerId: integer("player_id").references(() => players.playerId),
    sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
    externalPlayerId: text("external_player_id").notNull(),
    sourceDisplayName: text("source_display_name"),
    status: playerEligibilityStatusEnum("status").notNull(),
    effectiveDate: date("effective_date").notNull(),
    currentTeamId: integer("current_team_id").references(() => teams.teamId),
    sourceTeamAbbreviation: text("source_team_abbreviation"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    evidence: jsonb("evidence").notNull().default({}),
    confidence: identityConfidenceEnum("confidence").notNull().default("REVIEW_REQUIRED"),
    eligibleTodayResearch: boolean("eligible_today_research").notNull().default(false),
    eligibleLineupProjection: boolean("eligible_lineup_projection").notNull().default(false),
    eligiblePitcherResearch: boolean("eligible_pitcher_research").notNull().default(false),
    requiresIdentityReview: boolean("requires_identity_review").notNull().default(false),
    quarantinedFromCurrentResearch: boolean("quarantined_from_current_research").notNull().default(false),
    quarantineReason: text("quarantine_reason"),
  },
  (table) => ({
    sourcePlayerDateIdx: uniqueIndex("player_eligibility_source_player_date_idx").on(
      table.sourceId,
      table.externalPlayerId,
      table.effectiveDate,
    ),
  }),
);

export const identityMatchEvents = pgTable("identity_match_events", {
  matchEventId: uuid("match_event_id").primaryKey().defaultRandom(),
  playerId: integer("player_id").references(() => players.playerId),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  externalPlayerId: text("external_player_id").notNull(),
  confidence: identityConfidenceEnum("confidence").notNull(),
  algorithmVersion: text("algorithm_version").notNull(),
  evidence: jsonb("evidence").notNull().default({}),
  reviewer: text("reviewer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const identityReviewQueue = pgTable("identity_review_queue", {
  reviewId: uuid("review_id").primaryKey().defaultRandom(),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  externalPlayerId: text("external_player_id").notNull(),
  rawName: text("raw_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  evidence: jsonb("evidence").notNull().default({}),
  state: text("state").notNull().default("OPEN"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const venues = pgTable("venues", {
  venueId: integer("venue_id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone"),
  orientation: text("orientation"),
  metadata: jsonb("metadata").notNull().default({}),
});

export const games = pgTable("games", {
  gamePk: bigint("game_pk", { mode: "number" }).primaryKey(),
  gameDate: date("game_date").notNull(),
  startTimeUtc: timestamp("start_time_utc", { withTimezone: true }),
  awayTeamId: integer("away_team_id").notNull().references(() => teams.teamId),
  homeTeamId: integer("home_team_id").notNull().references(() => teams.teamId),
  venueId: integer("venue_id").references(() => venues.venueId),
  gameStatus: text("game_status"),
  gameType: text("game_type"),
  doubleheaderCode: text("doubleheader_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rosters = pgTable(
  "rosters",
  {
    teamId: integer("team_id").notNull().references(() => teams.teamId),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    rosterDate: date("roster_date").notNull(),
    status: text("status"),
    position: text("position"),
    sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    rosterPk: primaryKey({ columns: [table.teamId, table.playerId, table.rosterDate, table.sourceId] }),
  }),
);

export const starters = pgTable(
  "starters",
  {
    gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
    teamId: integer("team_id").notNull().references(() => teams.teamId),
    playerId: integer("player_id").references(() => players.playerId),
    starterState: starterStateEnum("starter_state").notNull(),
    sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw").notNull().default({}),
  },
  (table) => ({
    starterPk: primaryKey({ columns: [table.gamePk, table.teamId, table.sourceId, table.observedAt] }),
  }),
);

export const lineupSnapshots = pgTable("lineup_snapshots", {
  lineupSnapshotId: uuid("lineup_snapshot_id").primaryKey().defaultRandom(),
  gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
  teamId: integer("team_id").notNull().references(() => teams.teamId),
  state: lineupStateEnum("state").notNull(),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  raw: jsonb("raw").notNull().default({}),
});

export const lineupEntries = pgTable(
  "lineup_entries",
  {
    lineupSnapshotId: uuid("lineup_snapshot_id").notNull().references(() => lineupSnapshots.lineupSnapshotId, { onDelete: "cascade" }),
    battingOrder: integer("batting_order").notNull(),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    position: text("position"),
  },
  (table) => ({
    lineupEntryPk: primaryKey({ columns: [table.lineupSnapshotId, table.battingOrder] }),
  }),
);

export const fantasyProsProjectionSnapshots = pgTable("fantasypros_projection_snapshots", {
  snapshotId: uuid("snapshot_id").primaryKey().defaultRandom(),
  effectiveDate: date("effective_date").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  snapshotLabel: text("snapshot_label"),
  rawPayloadId: uuid("raw_payload_id").references(() => rawPayloads.rawPayloadId),
  checksum: text("checksum").notNull(),
  contentChecksum: text("content_checksum").notNull().default(""),
  unchangedFromPrior: boolean("unchanged_from_prior").notNull().default(false),
});

export const fantasyProsProjectionRows = pgTable(
  "fantasypros_projection_rows",
  {
    rowId: uuid("row_id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id").notNull().references(() => fantasyProsProjectionSnapshots.snapshotId, { onDelete: "cascade" }),
    sourcePlayerId: text("source_player_id").notNull(),
    canonicalPlayerId: integer("canonical_player_id").references(() => players.playerId),
    teamAbbreviation: text("team_abbreviation"),
    position: text("position"),
    projectedStats: jsonb("projected_stats").notNull().default({}),
    normalizedStats: jsonb("normalized_stats").notNull().default({}),
    rawRow: jsonb("raw_row").notNull().default({}),
    identityConfidence: identityConfidenceEnum("identity_confidence").notNull().default("REVIEW_REQUIRED"),
  },
  (table) => ({
    snapshotSourcePlayerIdx: uniqueIndex("fp_projection_snapshot_source_player_idx").on(
      table.snapshotId,
      table.sourcePlayerId,
    ),
  }),
);

export const newsItems = pgTable("news_items", {
  newsItemId: uuid("news_item_id").primaryKey().defaultRandom(),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  sourceReference: text("source_reference"),
  playerId: integer("player_id").references(() => players.playerId),
  teamId: integer("team_id").references(() => teams.teamId),
  headline: text("headline").notNull(),
  body: text("body"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export const researchFiles = pgTable("research_files", {
  researchFileId: uuid("research_file_id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  contentType: text("content_type"),
  objectPath: text("object_path"),
  sha256: text("sha256").notNull(),
  effectiveDate: date("effective_date"),
  tags: jsonb("tags").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const researchIdentityQuarantine = pgTable("research_identity_quarantine", {
  quarantineId: uuid("quarantine_id").primaryKey().defaultRandom(),
  ingestRunId: uuid("ingest_run_id").notNull().references(() => ingestRuns.ingestRunId),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  externalPlayerId: text("external_player_id"),
  rawName: text("raw_name"),
  reason: text("reason").notNull(),
  rawEvidence: jsonb("raw_evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playerResearchSnapshots = pgTable("player_research_snapshots", {
  researchSnapshotId: uuid("research_snapshot_id").primaryKey().defaultRandom(),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  rawPayloadId: uuid("raw_payload_id").references(() => rawPayloads.rawPayloadId),
  researchWindow: researchWindowEnum("research_window").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  sampleSize: integer("sample_size"),
  denominatorType: text("denominator_type"),
  denominator: numeric("denominator"),
  contentChecksum: text("content_checksum").notNull(),
  unchangedFromPrior: boolean("unchanged_from_prior").notNull().default(false),
  provenance: jsonb("provenance").notNull().default({}),
});

export const playerResearchFeatures = pgTable("player_research_features", {
  playerResearchFeatureId: uuid("player_research_feature_id").primaryKey().defaultRandom(),
  researchSnapshotId: uuid("research_snapshot_id").notNull().references(() => playerResearchSnapshots.researchSnapshotId, { onDelete: "cascade" }),
  family: text("family").notNull(),
  metricKey: text("metric_key").notNull(),
  metricLabel: text("metric_label").notNull(),
  value: numeric("value"),
  unit: text("unit"),
  denominator: numeric("denominator"),
  sampleSize: integer("sample_size"),
  pitcherSide: text("pitcher_side"),
  transformation: researchTransformEnum("transformation").notNull().default("NORMALIZED"),
  sampleStatus: researchSampleStatusEnum("sample_status").notNull().default("AVAILABLE"),
  definition: text("definition").notNull(),
  provenance: jsonb("provenance").notNull().default({}),
}, (table) => ({
  snapshotMetricSideIdx: uniqueIndex("player_research_snapshot_metric_side_idx").on(table.researchSnapshotId, table.metricKey, table.pitcherSide),
}));

export const pitcherResearchSnapshots = pgTable("pitcher_research_snapshots", {
  researchSnapshotId: uuid("research_snapshot_id").primaryKey().defaultRandom(),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  rawPayloadId: uuid("raw_payload_id").references(() => rawPayloads.rawPayloadId),
  researchWindow: researchWindowEnum("research_window").notNull(),
  role: pitcherRoleEnum("role").notNull().default("UNKNOWN"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  sampleSize: integer("sample_size"),
  denominatorType: text("denominator_type"),
  denominator: numeric("denominator"),
  contentChecksum: text("content_checksum").notNull(),
  unchangedFromPrior: boolean("unchanged_from_prior").notNull().default(false),
  provenance: jsonb("provenance").notNull().default({}),
});

export const pitcherResearchFeatures = pgTable("pitcher_research_features", {
  pitcherResearchFeatureId: uuid("pitcher_research_feature_id").primaryKey().defaultRandom(),
  researchSnapshotId: uuid("research_snapshot_id").notNull().references(() => pitcherResearchSnapshots.researchSnapshotId, { onDelete: "cascade" }),
  family: text("family").notNull(),
  metricKey: text("metric_key").notNull(),
  metricLabel: text("metric_label").notNull(),
  value: numeric("value"),
  unit: text("unit"),
  denominator: numeric("denominator"),
  sampleSize: integer("sample_size"),
  batterSide: text("batter_side"),
  transformation: researchTransformEnum("transformation").notNull().default("NORMALIZED"),
  sampleStatus: researchSampleStatusEnum("sample_status").notNull().default("AVAILABLE"),
  definition: text("definition").notNull(),
  provenance: jsonb("provenance").notNull().default({}),
}, (table) => ({
  snapshotMetricSideIdx: uniqueIndex("pitcher_research_snapshot_metric_side_idx").on(table.researchSnapshotId, table.metricKey, table.batterSide),
}));

export const pitchArsenalFeatures = pgTable("pitch_arsenal_features", {
  arsenalFeatureId: uuid("arsenal_feature_id").primaryKey().defaultRandom(),
  researchSnapshotId: uuid("research_snapshot_id").notNull().references(() => pitcherResearchSnapshots.researchSnapshotId, { onDelete: "cascade" }),
  pitchType: text("pitch_type").notNull(),
  pitchName: text("pitch_name").notNull(),
  usagePercent: numeric("usage_percent"),
  velocity: numeric("velocity"),
  horizontalMovement: numeric("horizontal_movement"),
  verticalMovement: numeric("vertical_movement"),
  spinRate: numeric("spin_rate"),
  releaseHeight: numeric("release_height"),
  releaseSide: numeric("release_side"),
  extension: numeric("extension"),
  zonePercent: numeric("zone_percent"),
  whiffPercent: numeric("whiff_percent"),
  chasePercent: numeric("chase_percent"),
  xSlgAllowed: numeric("x_slg_allowed"),
  xWobaAllowed: numeric("x_woba_allowed"),
  hardHitPercent: numeric("hard_hit_percent"),
  barrelPercent: numeric("barrel_percent"),
  sampleSize: integer("sample_size"),
  sampleStatus: researchSampleStatusEnum("sample_status").notNull().default("NOT_FOUND"),
  provenance: jsonb("provenance").notNull().default({}),
}, (table) => ({
  snapshotPitchIdx: uniqueIndex("pitch_arsenal_snapshot_pitch_idx").on(table.researchSnapshotId, table.pitchType),
}));

export const parkResearchSnapshots = pgTable("park_research_snapshots", {
  parkResearchSnapshotId: uuid("park_research_snapshot_id").primaryKey().defaultRandom(),
  venueId: integer("venue_id").notNull().references(() => venues.venueId),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  rawPayloadId: uuid("raw_payload_id").references(() => rawPayloads.rawPayloadId),
  season: integer("season").notNull(),
  span: text("span").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  contentChecksum: text("content_checksum").notNull(),
  provenance: jsonb("provenance").notNull().default({}),
});

export const parkResearchFeatures = pgTable("park_research_features", {
  parkResearchFeatureId: uuid("park_research_feature_id").primaryKey().defaultRandom(),
  parkResearchSnapshotId: uuid("park_research_snapshot_id").notNull().references(() => parkResearchSnapshots.parkResearchSnapshotId, { onDelete: "cascade" }),
  metricKey: text("metric_key").notNull(),
  metricLabel: text("metric_label").notNull(),
  value: numeric("value"),
  batterSide: text("batter_side"),
  transformation: researchTransformEnum("transformation").notNull().default("RAW"),
  sampleStatus: researchSampleStatusEnum("sample_status").notNull().default("AVAILABLE"),
  definition: text("definition").notNull(),
  provenance: jsonb("provenance").notNull().default({}),
}, (table) => ({
  parkSnapshotMetricIdx: uniqueIndex("park_research_snapshot_metric_idx").on(table.parkResearchSnapshotId, table.metricKey, table.batterSide),
}));

// ─── Phase 2B – Bullpen Foundation ───────────────────────────────────────────

export const relieverRoleEnum = pgEnum("reliever_role", [
  "CLOSER",
  "PRIMARY_SETUP",
  "SETUP",
  "MIDDLE",
  "LEFTY_SPECIALIST",
  "LONG_MAN",
  "OPENER",
  "SWING",
  "UNKNOWN",
]);

export const bullpenAvailabilityStateEnum = pgEnum("bullpen_availability_state", [
  "AVAILABLE",
  "LIKELY_AVAILABLE",
  "DOUBTFUL",
  "OUT",
  "UNKNOWN",
  "STALE",
]);

export const bullpenConfidenceEnum = pgEnum("bullpen_confidence", [
  "HEURISTIC",
  "MANAGER_OVERRIDE",
  "UNKNOWN",
]);

/**
 * One row per reliever per team per season. Updated each bullpen refresh.
 * Role transitions are tracked in role_change_log (append-only).
 */
export const relieverProfiles = pgTable(
  "reliever_profiles",
  {
    profileId: uuid("profile_id").primaryKey().defaultRandom(),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    teamId: integer("team_id").notNull().references(() => teams.teamId),
    throws: text("throws"),
    role: relieverRoleEnum("role").notNull().default("UNKNOWN"),
    roleEffectiveDate: date("role_effective_date"),
    roleSource: text("role_source"),
    activeRoster: boolean("active_roster").notNull().default(true),
    season: integer("season").notNull(),
    seasonPitches: integer("season_pitches"),
    seasonAppearances: integer("season_appearances"),
    seasonInningsPitched: numeric("season_innings_pitched"),
    walkRatePercent: numeric("walk_rate_percent"),
    strikeoutRatePercent: numeric("strikeout_rate_percent"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    playerTeamSeasonIdx: uniqueIndex("reliever_profiles_player_team_season_idx").on(
      table.playerId,
      table.teamId,
      table.season,
    ),
  }),
);

/**
 * Append-only game-by-game pitching appearance log for relievers.
 * No updates or deletes — historical records are immutable once written.
 */
export const reliefAppearanceLog = pgTable(
  "relief_appearance_log",
  {
    appearanceId: uuid("appearance_id").primaryKey().defaultRandom(),
    gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
    gameDate: date("game_date").notNull(),
    teamId: integer("team_id").notNull().references(() => teams.teamId),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    opponentTeamId: integer("opponent_team_id").references(() => teams.teamId),
    inningEntered: integer("inning_entered"),
    outsRecorded: integer("outs_recorded"),
    inningsPitched: numeric("innings_pitched"),
    pitchCount: integer("pitch_count"),
    battersFaced: integer("batters_faced"),
    hitsAllowed: integer("hits_allowed"),
    walksAllowed: integer("walks_allowed"),
    strikeouts: integer("strikeouts"),
    runsAllowed: integer("runs_allowed"),
    isMultiInning: boolean("is_multi_inning").notNull().default(false),
    daysRest: integer("days_rest"),
    leverage: text("leverage"),
    sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    gamePlayerIdx: uniqueIndex("relief_appearance_log_game_player_idx").on(
      table.gamePk,
      table.playerId,
    ),
  }),
);

/**
 * Append-only role-change event log. Prior role assignments are never overwritten.
 * changeType values: PROMOTION | DEMOTION | IL | OPTION | CALL_UP | TRADE | OPENER |
 *                    SWING | MANAGER_OVERRIDE | CORRECTION
 */
export const roleChangeLog = pgTable("role_change_log", {
  changeId: uuid("change_id").primaryKey().defaultRandom(),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  teamId: integer("team_id").notNull().references(() => teams.teamId),
  previousRole: relieverRoleEnum("previous_role"),
  newRole: relieverRoleEnum("new_role").notNull(),
  changeType: text("change_type").notNull(),
  effectiveDate: date("effective_date").notNull(),
  source: text("source").notNull(),
  notes: text("notes"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-reliever per-slate-date availability observation.
 * Manager override wins unconditionally over heuristic.
 * finalState is always derived: managerOverride ?? heuristicAvailability.
 */
export const bullpenAvailabilityObservations = pgTable(
  "bullpen_availability_observations",
  {
    observationId: uuid("observation_id").primaryKey().defaultRandom(),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    teamId: integer("team_id").notNull().references(() => teams.teamId),
    slateDate: date("slate_date").notNull(),
    d1Pitches: integer("d1_pitches"),
    d2Pitches: integer("d2_pitches"),
    d3Pitches: integer("d3_pitches"),
    consecutiveDaysUsed: integer("consecutive_days_used").notNull().default(0),
    multiInningYesterday: boolean("multi_inning_yesterday").notNull().default(false),
    daysSinceLastUse: integer("days_since_last_use"),
    heuristicAvailability: bullpenAvailabilityStateEnum("heuristic_availability").notNull().default("UNKNOWN"),
    managerOverride: bullpenAvailabilityStateEnum("manager_override"),
    managerOverrideNote: text("manager_override_note"),
    finalState: bullpenAvailabilityStateEnum("final_state").notNull().default("UNKNOWN"),
    confidence: bullpenConfidenceEnum("confidence").notNull().default("UNKNOWN"),
    sourceFreshness: text("source_freshness"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    playerDateIdx: uniqueIndex("bullpen_availability_player_date_idx").on(
      table.playerId,
      table.slateDate,
    ),
  }),
);

/**
 * Per-team per-date projected leverage sequence.
 * Rebuilt on each bullpen refresh for the slate date.
 */
export const bullpenLeverageMaps = pgTable(
  "bullpen_leverage_maps",
  {
    mapId: uuid("map_id").primaryKey().defaultRandom(),
    teamId: integer("team_id").notNull().references(() => teams.teamId),
    slateDate: date("slate_date").notNull(),
    projected9th: integer("projected_9th").references(() => players.playerId),
    projected8th: integer("projected_8th").references(() => players.playerId),
    projected7th: integer("projected_7th").references(() => players.playerId),
    highestLeverageLefty: integer("highest_leverage_lefty").references(() => players.playerId),
    longMan: integer("long_man").references(() => players.playerId),
    highestWalkReliever: integer("highest_walk_reliever").references(() => players.playerId),
    lowestWalkReliever: integer("lowest_walk_reliever").references(() => players.playerId),
    roleUncertainty: boolean("role_uncertainty").notNull().default(false),
    notes: text("notes"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamDateIdx: uniqueIndex("bullpen_leverage_maps_team_date_idx").on(
      table.teamId,
      table.slateDate,
    ),
  }),
);

// ─── End Phase 2B ────────────────────────────────────────────────────────────

/**
 * PLACEHOLDER — extended by Phase 4A (Historical Pregame Feature Store) and Phase 5 (Model Training).
 *
 * Phase 4 extension contract:
 *   - `model_version_id` will reference a `model_versions.version_id` FK once Phase 5A creates that table.
 *   - `feature_snapshot` will be replaced or supplemented by a FK to `pregame_feature_snapshots` (Phase 4A).
 *   - `status` will be replaced by a typed enum (DRAFT / CANDIDATE / ACTIVE / RETIRED) once Phase 5A defines it.
 *   - `predicted_probability` must remain nullable; rows written before a calibrated model exists leave it NULL.
 *   - `frozen` / `frozen_at` establish the immutability boundary: once frozen=true, no field may be updated.
 *     Phase 4B (Settlement) enforces this at the application layer; a future migration may add a DB check.
 *   - Do NOT add sportsbook price, odds, implied probability, EV, or CLV columns to this table.
 *
 * Do not redefine this table's primary key or drop existing columns in downstream phases;
 * extend it with new nullable columns and a new FK to `model_versions` instead.
 */
export const futureMarketPredictions = pgTable("future_market_predictions", {
  predictionId: uuid("prediction_id").primaryKey().defaultRandom(),
  gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  market: marketTypeEnum("market").notNull(),
  modelVersionId: text("model_version_id").references(() => modelVersions.versionId),
  status: text("status"),
  predictedProbability: numeric("predicted_probability"),
  featureSnapshot: jsonb("feature_snapshot").notNull().default({}),
  lineupSnapshotId: uuid("lineup_snapshot_id").references(() => lineupSnapshots.lineupSnapshotId),
  sourceFreshness: jsonb("source_freshness").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  frozen: boolean("frozen").notNull().default(false),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
});

// ─── Phase 3 – Shared Market Research Contract ───────────────────────────────

/**
 * Research state taxonomy for market research candidates.
 *
 * RANK, DON'T GATE rule: engines assign an ordinal rank and a research state.
 * No state value removes a candidate from the board — all states remain visible
 * to the analyst. BLOCKED means evidence is structurally absent or contradictory,
 * not that the player should be excluded.
 *
 * Prohibited: No sportsbook price, odds, implied probability, EV, CLV, vig,
 * juice, kelly fraction, or edge-percent columns may appear in this schema or
 * in any derived output.
 */
export const researchStateEnum = pgEnum("research_state", [
  "STRONG",
  "POSITIVE",
  "NEUTRAL",
  "NEGATIVE",
  "BLOCKED",
]);

/**
 * Structured evidence block types used in market_research_evidence_blocks.
 * Each block represents one atomic research dimension from one source.
 */
export const evidenceBlockTypeEnum = pgEnum("evidence_block_type", [
  "OPPORTUNITY",
  "STARTER_MATCHUP",
  "BULLPEN_PATH",
  "PARK",
  "RECENT_VS_SEASON_VS_CAREER",
  "COUNTER",
  "MISSING_STALE",
]);

/**
 * One row per player-market-slate_date-game.
 *
 * Ranking semantics:
 *   research_rank is an ordinal integer (1 = highest-ranked candidate for this
 *   market+date). Ties are surfaced with the same integer value — they are never
 *   collapsed or hidden. The rank describes relative evidence quality only; it is
 *   NOT a gate, threshold, probability estimate, or recommendation.
 *
 * Prohibited columns (may NEVER be added): ev, clv, odds, implied_probability,
 *   vig, juice, kelly_fraction, edge_percent, expected_value, recommendation.
 */
export const marketResearchCandidates = pgTable(
  "market_research_candidates",
  {
    candidateId: uuid("candidate_id").primaryKey().defaultRandom(),
    slateDate: date("slate_date").notNull(),
    gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    market: marketTypeEnum("market").notNull(),
    researchRank: integer("research_rank"),
    researchState: researchStateEnum("research_state").notNull().default("NEUTRAL"),
    primaryMechanism: text("primary_mechanism"),
    secondaryMechanism: text("secondary_mechanism"),
    // Evidence containers — engines write JSON objects keyed by metric
    opportunityEvidence: jsonb("opportunity_evidence").notNull().default({}),
    starterMatchupEvidence: jsonb("starter_matchup_evidence").notNull().default({}),
    bullpenPathEvidence: jsonb("bullpen_path_evidence").notNull().default({}),
    parkEvidence: jsonb("park_evidence").notNull().default({}),
    recentVsSeasonVsCareer: jsonb("recent_vs_season_vs_career").notNull().default({}),
    counterEvidence: jsonb("counter_evidence").notNull().default({}),
    missingStaleEvidence: text("missing_stale_evidence"),
    // Durable annotation of ranking semantics — readable in every row
    rankSemantics: text("rank_semantics")
      .notNull()
      .default("RANK_DONT_GATE: ordinal rank with transparent feature evidence; ties surfaced not collapsed; no threshold or gate implied"),
    ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mrcUniqIdx: uniqueIndex("mrc_slate_market_player_game_idx").on(
      table.slateDate, table.market, table.playerId, table.gamePk,
    ),
  }),
);

/**
 * Structured evidence blocks for a candidate, keyed by block type and metric.
 * Each block is one atomic evidence item from one source.
 *
 * Prohibited: raw_evidence must never contain ev, clv, odds, implied_probability,
 * vig, juice, kelly_fraction, or edge_percent values.
 */
export const marketResearchEvidenceBlocks = pgTable(
  "market_research_evidence_blocks",
  {
    evidenceBlockId: uuid("evidence_block_id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id").notNull().references(() => marketResearchCandidates.candidateId, { onDelete: "cascade" }),
    blockType: evidenceBlockTypeEnum("block_type").notNull(),
    sourceId: text("source_id").references(() => sourceRegistry.sourceId),
    metricKey: text("metric_key"),
    metricLabel: text("metric_label"),
    value: numeric("value"),
    unit: text("unit"),
    sampleSize: integer("sample_size"),
    direction: text("direction"),
    strength: text("strength"),
    narrative: text("narrative"),
    rawEvidence: jsonb("raw_evidence").notNull().default({}),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mrebCandidateTypeMetricIdx: uniqueIndex("mreb_candidate_block_type_metric_idx").on(
      table.candidateId, table.blockType, table.metricKey,
    ),
  }),
);

/**
 * Source provenance for every evidence block.
 * Tracks ingest lineage for each atomic piece of research evidence.
 */
export const marketResearchProvenance = pgTable("market_research_provenance", {
  provenanceId: uuid("provenance_id").primaryKey().defaultRandom(),
  evidenceBlockId: uuid("evidence_block_id").notNull().references(() => marketResearchEvidenceBlocks.evidenceBlockId, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  sourceVersion: text("source_version"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  rawChecksum: text("raw_checksum"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A bettor's stated baseball pick. This table records evidence and lineage,
 * not price, odds, expected value, or a platform-derived recommendation.
 * Reasoning is normalized by the ingestion service to a bounded paraphrase.
 */
export const bettorPicks = pgTable(
  "bettor_picks",
  {
    pickId: uuid("pick_id").primaryKey().defaultRandom(),
    slateDate: date("slate_date").notNull(),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    market: marketTypeEnum("market").notNull(),
    pickDirection: bettorPickDirectionEnum("pick_direction").notNull(),
    mechanismTags: bettorMechanismEnum("mechanism_tags").array().notNull().default([]),
    reasoningParaphrase: text("reasoning_paraphrase").notNull(),
    originalTextRetainedFlag: boolean("original_text_retained_flag").notNull().default(false),
    sourceUrl: text("source_url"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    sourceId: uuid("source_id").notNull().references(() => bettorSources.sourceId),
    duplicationFlag: bettorDuplicationFlagEnum("duplication_flag").notNull().default("INDEPENDENT"),
  },
  (table) => ({
    sourcePickIdx: uniqueIndex("bettor_picks_source_date_player_market_idx").on(
      table.sourceId,
      table.slateDate,
      table.playerId,
      table.market,
    ),
    dateMarketIdx: index("bettor_picks_date_market_idx").on(table.slateDate, table.market),
    playerDateIdx: index("bettor_picks_player_date_idx").on(table.playerId, table.slateDate),
    reasoningLengthCheck: check(
      "bettor_picks_reasoning_length_check",
      sql`char_length(${table.reasoningParaphrase}) <= 500`,
    ),
    mechanismTagCountCheck: check(
      "bettor_picks_mechanism_tag_count_check",
      sql`cardinality(${table.mechanismTags}) BETWEEN 1 AND 6`,
    ),
  }),
);

/**
 * A directed, append-only edge from a newly ingested pick to an earlier pick
 * that it may duplicate. Multiple candidate predecessors are retained so the
 * operator can audit why a pick was flagged.
 */
export const pickDuplicationLineage = pgTable(
  "pick_duplication_lineage",
  {
    lineageId: uuid("lineage_id").primaryKey().defaultRandom(),
    pickId: uuid("pick_id").notNull().references(() => bettorPicks.pickId, { onDelete: "cascade" }),
    priorPickId: uuid("prior_pick_id").notNull().references(() => bettorPicks.pickId),
    confidence: numeric("confidence").notNull(),
    method: text("method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pickPriorUniqueIdx: uniqueIndex("pick_duplication_lineage_pick_prior_idx").on(
      table.pickId,
      table.priorPickId,
    ),
    priorPickIdx: index("pick_duplication_lineage_prior_pick_idx").on(table.priorPickId),
    confidenceRangeCheck: check(
      "pick_duplication_lineage_confidence_range_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    distinctPickCheck: check(
      "pick_duplication_lineage_distinct_picks_check",
      sql`${table.pickId} <> ${table.priorPickId}`,
    ),
  }),
);

/**
 * Persisted, observational performance rollup for one bettor source. These
 * rows are recalculated from bettor picks and official settlement outcomes;
 * they never feed model training or confidence-label logic.
 */
export const bettorPerformanceRecords = pgTable(
  "bettor_performance_records",
  {
    performanceRecordId: uuid("performance_record_id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").notNull().references(() => bettorSources.sourceId, { onDelete: "cascade" }),
    market: marketTypeEnum("market").notNull(),
    mechanism: bettorMechanismEnum("mechanism").notNull(),
    pickCount: integer("pick_count").notNull().default(0),
    settledPickCount: integer("settled_pick_count").notNull().default(0),
    outcomeRate: numeric("outcome_rate").notNull().default("0"),
    baseRateDelta: numeric("base_rate_delta").notNull().default("0"),
    duplicationAdjustedCount: numeric("duplication_adjusted_count").notNull().default("0"),
    independenceScore: numeric("independence_score").notNull().default("0"),
    evaluationWindow: text("evaluation_window").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceMarketMechanismWindowIdx: uniqueIndex("bettor_performance_source_market_mechanism_window_idx").on(
      table.sourceId,
      table.market,
      table.mechanism,
      table.evaluationWindow,
    ),
    countsCheck: check(
      "bettor_performance_counts_check",
      sql`${table.pickCount} >= 0 AND ${table.settledPickCount} >= 0 AND ${table.settledPickCount} <= ${table.pickCount}`,
    ),
    ratesCheck: check(
      "bettor_performance_rates_check",
      sql`${table.outcomeRate} >= 0 AND ${table.outcomeRate} <= 1
        AND ${table.independenceScore} >= 0 AND ${table.independenceScore} <= 1
        AND ${table.baseRateDelta} >= -1 AND ${table.baseRateDelta} <= 1
        AND ${table.duplicationAdjustedCount} >= 0
        AND ${table.duplicationAdjustedCount} <= ${table.settledPickCount}`,
    ),
    evaluationWindowCheck: check(
      "bettor_performance_evaluation_window_check",
      sql`char_length(btrim(${table.evaluationWindow})) BETWEEN 1 AND 80`,
    ),
  }),
);

/**
 * Documented allowlist for the AI Analyst gateway. Registry changes are
 * controlled server configuration, not AI-generated state.
 */
export const aiToolRegistry = pgTable(
  "ai_tool_registry",
  {
    toolName: text("tool_name").primaryKey(),
    description: text("description").notNull(),
    dataSource: text("data_source").notNull(),
    accessLevel: aiToolAccessLevelEnum("access_level").notNull().default("READ_ONLY"),
    prohibitedActions: jsonb("prohibited_actions").notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toolNameLengthCheck: check(
      "ai_tool_registry_tool_name_length_check",
      sql`char_length(btrim(${table.toolName})) BETWEEN 3 AND 100`,
    ),
  }),
);

/**
 * Append-only audit trail of every request that enters the AI tool gateway.
 * Rejected and failed calls are retained alongside successful reads.
 */
export const aiToolCallLog = pgTable(
  "ai_tool_call_log",
  {
    callId: uuid("call_id").primaryKey().defaultRandom(),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
    toolName: text("tool_name").notNull(),
    parameters: jsonb("parameters").notNull().default({}),
    responseSummary: jsonb("response_summary").notNull().default({}),
    toolDefinition: jsonb("tool_definition").notNull().default({}),
    /** Server-assigned request correlation; never supplied by the AI caller. */
    requestId: text("request_id").notNull().default("legacy-unattributed"),
    /** Session is caller correlation only, not authenticated actor attribution. */
    sessionId: text("session_id").notNull(),
    status: aiToolCallStatusEnum("status").notNull(),
    rejectionReason: text("rejection_reason"),
  },
  (table) => ({
    calledAtIdx: index("ai_tool_call_log_called_at_idx").on(table.calledAt),
    sessionCalledAtIdx: index("ai_tool_call_log_session_called_at_idx").on(
      table.sessionId,
      table.calledAt,
    ),
    sessionLengthCheck: check(
      "ai_tool_call_log_session_length_check",
      sql`char_length(btrim(${table.sessionId})) BETWEEN 1 AND 160`,
    ),
  }),
);

/**
 * AI-authored notes remain outside the official research tables until a human
 * reviewer explicitly approves them. The draft itself is append-only in spirit
 * except for its controlled review transition.
 */
export const aiResearchDrafts = pgTable(
  "ai_research_drafts",
  {
    draftId: uuid("draft_id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    playerId: integer("player_id").references(() => players.playerId),
    market: marketTypeEnum("market"),
    draftContent: text("draft_content").notNull(),
    status: aiResearchDraftStatusEnum("status").notNull().default("DRAFT"),
    sourceClaimIds: jsonb("source_claim_ids").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
  },
  (table) => ({
    sessionCreatedIdx: index("ai_research_drafts_session_created_idx").on(table.sessionId, table.createdAt),
    statusCreatedIdx: index("ai_research_drafts_status_created_idx").on(table.status, table.createdAt),
    sessionLengthCheck: check(
      "ai_research_drafts_session_length_check",
      sql`char_length(btrim(${table.sessionId})) BETWEEN 1 AND 160`,
    ),
    contentLengthCheck: check(
      "ai_research_drafts_content_length_check",
      sql`char_length(btrim(${table.draftContent})) BETWEEN 1 AND 12000`,
    ),
    reviewConsistencyCheck: check(
      "ai_research_drafts_review_consistency_check",
      sql`(${table.status} = 'DRAFT' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL)
        OR (${table.status} = 'APPROVED' AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)
        OR (${table.status} IN ('REJECTED', 'WITHDRAWN') AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * Approved AI notes are a distinct, additive research stream. They never
 * overwrite or masquerade as frozen source-backed research.
 */
export const researchNotes = pgTable(
  "research_notes",
  {
    noteId: uuid("note_id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull().references(() => aiResearchDrafts.draftId),
    sessionId: text("session_id").notNull(),
    playerId: integer("player_id").references(() => players.playerId),
    market: marketTypeEnum("market"),
    noteContent: text("note_content").notNull(),
    sourceType: text("source_type").notNull().default("AI_APPROVED"),
    sourceClaimIds: jsonb("source_claim_ids").notNull().default([]),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    draftUniqueIdx: uniqueIndex("research_notes_draft_unique_idx").on(table.draftId),
    playerCreatedIdx: index("research_notes_player_created_idx").on(table.playerId, table.createdAt),
    contentLengthCheck: check(
      "research_notes_content_length_check",
      sql`char_length(btrim(${table.noteContent})) BETWEEN 1 AND 12000`,
    ),
  }),
);

/**
 * Every web claim surfaced by the AI is reviewable independently from a draft.
 * accepted=NULL means the operator has not decided yet.
 */
export const aiSourcingRegister = pgTable(
  "ai_sourcing_register",
  {
    claimId: uuid("claim_id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    toolCallId: uuid("tool_call_id").references(() => aiToolCallLog.callId),
    claimText: text("claim_text").notNull(),
    sourceUrlOrDescription: text("source_url_or_description").notNull(),
    sourceType: aiSourcingSourceTypeEnum("source_type").notNull(),
    accepted: boolean("accepted"),
    rejectionReason: text("rejection_reason"),
    operatorNote: text("operator_note"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index("ai_sourcing_register_session_created_idx").on(table.sessionId, table.createdAt),
    sourceTypeIdx: index("ai_sourcing_register_source_type_idx").on(table.sourceType),
    claimLengthCheck: check(
      "ai_sourcing_register_claim_length_check",
      sql`char_length(btrim(${table.claimText})) BETWEEN 1 AND 4000
        AND char_length(btrim(${table.sourceUrlOrDescription})) BETWEEN 1 AND 2048`,
    ),
    decisionConsistencyCheck: check(
      "ai_sourcing_register_decision_consistency_check",
      sql`(${table.accepted} IS NULL AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL)
        OR (${table.accepted} IS NOT NULL AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * PLACEHOLDER — extended by Phase 4B (Official Settlement and Postmortem Engine).
 *
 * Phase 4 extension contract:
 *   - `source_id` must always reference the MLB official source ('MLB_OFFICIAL').
 *     FantasyPros or any projection source must NEVER be written here as a settlement source.
 *   - XBH = doubles + triples + home_runs; singles are explicitly excluded from XBH market settlement.
 *     The `singles` column is retained for TB computation only (TB = 1B + 2×2B + 3×3B + 4×HR).
 *   - Phase 4B will add: `settlement_state` enum (SETTLED / POSTPONED / NO_ACTION / DISPUTED / PENDING),
 *     `settled_at` timestamp, `correction_of` UUID self-reference, and `process_error_taxonomy` text.
 *   - Once `settlement_state = 'SETTLED'`, the row must not be updated. Phase 4B enforces this at the
 *     application layer. Corrections create a new row with `correction_of` pointing to the original.
 *   - AI must not write to this table. The application layer must enforce this in Phase 8A's tool registry.
 *   - The current primary key (game_pk, player_id) will be relaxed in Phase 4B to allow correction rows;
 *     Phase 4B will replace it with a surrogate UUID PK and add a unique partial index on
 *     (game_pk, player_id) WHERE settlement_state = 'SETTLED' AND correction_of IS NULL.
 *
 * Do not add odds, price, EV, CLV, or implied-probability columns to this table.
 */
// ─── Phase 4A – Historical Pregame Feature Store ─────────────────────────────

/**
 * Taxonomy of process-error reasons for snapshot corrections.
 * Required whenever a snapshot is corrected (correction_of IS NOT NULL).
 *
 * LATE_SCRATCH       — player was scratched after pregame-freeze
 * LINEUP_ERROR       — incorrect lineup entry was frozen
 * DATA_INGEST_FAILURE — upstream source data was corrupt or missing at freeze time
 * IDENTITY_ERROR     — wrong player ID was used in the snapshot
 * SOURCE_UNAVAILABLE — a required source was unavailable at freeze time
 * HUMAN_CORRECTION   — operator-initiated correction with explicit note
 */
export const snapshotCorrectionReasonEnum = pgEnum("snapshot_correction_reason", [
  "LATE_SCRATCH",
  "LINEUP_ERROR",
  "DATA_INGEST_FAILURE",
  "IDENTITY_ERROR",
  "SOURCE_UNAVAILABLE",
  "HUMAN_CORRECTION",
]);

/**
 * One row per player-market-game-date, frozen at pregame-freeze time.
 *
 * Immutability contract: NO UPDATE is ever issued to this table.
 * Corrections create a new row pointing to the original via correction_of.
 * correction_reason is required (not null) when correction_of is not null.
 *
 * The feature vector in `features` is the complete set of research metrics
 * available at freeze time for the given market. Each market has independent
 * feature columns; no merged hitter score is stored.
 */
export const pregameFeatureSnapshots = pgTable("pregame_feature_snapshots", {
  snapshotId: uuid("snapshot_id").primaryKey().defaultRandom(),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
  slateDate: date("slate_date").notNull(),
  market: marketTypeEnum("market").notNull(),
  frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
  /** Complete feature vector for this market at freeze time (JSONB). */
  features: jsonb("features").notNull().default({}),
  /** SHA-256 of the features JSON — used for idempotency checking. */
  featureHash: text("feature_hash").notNull(),
  /** Ordinal rank from the market research engine at freeze time. */
  researchRank: integer("research_rank"),
  /** Research state from the market research engine at freeze time. */
  researchState: text("research_state"),
  /** Primary evidence mechanism name from the market research engine. */
  primaryMechanism: text("primary_mechanism"),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  /** Self-referential FK to the snapshot this row corrects. NULL for original (non-correction) rows. */
  correctionOf: uuid("correction_of").references((): AnyPgColumn => pregameFeatureSnapshots.snapshotId),
  /** Required when correction_of IS NOT NULL; must be a valid taxonomy code. */
  correctionReason: snapshotCorrectionReasonEnum("correction_reason"),
  correctionNote: text("correction_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  /**
   * Partial unique index: ensures at-most-one original (non-correction) row
   * per (player_id, game_pk, market, feature_hash) combination.
   * Correction rows (correction_of IS NOT NULL) are excluded so the same hash
   * can be used in a correction without conflicting with the original.
   */
  originalUniqueHashIdx: uniqueIndex("pfs_original_unique_hash_idx")
    .on(table.playerId, table.gamePk, table.market, table.featureHash)
    .where(sql`correction_of IS NULL`),
}));

/**
 * Per-source provenance for each pregame feature snapshot.
 * Documents which sources contributed metrics to the feature vector.
 */
export const featureSnapshotProvenance = pgTable("feature_snapshot_provenance", {
  provenanceId: uuid("provenance_id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => pregameFeatureSnapshots.snapshotId, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  metricFamilies: text("metric_families").array().notNull().default([]),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Official settled results per player-game-market. Append-only.
 *
 * Each row is the authoritative outcome for a player-game-market pair.
 * No UPDATE or DELETE is ever issued to this table.
 * Multiple rows for the same (player_id, game_pk, market) are theoretically
 * possible under concurrent writes but are treated as idempotent via
 * application-layer deduplication.
 *
 * market threshold rules (for outcome_hit):
 *   TOTAL_BASES_2_PLUS — total_bases >= 2
 *   EXTRA_BASE_HIT     — (doubles + triples + home_runs) >= 1
 *   BATTER_WALK        — walks >= 1
 *   HOME_RUN           — home_runs >= 1
 *
 * Do not add odds, price, EV, CLV, or implied-probability columns.
 */
export const historicalOutcomes = pgTable("historical_outcomes", {
  outcomeId: uuid("outcome_id").primaryKey().defaultRandom(),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
  slateDate: date("slate_date").notNull(),
  market: marketTypeEnum("market").notNull(),
  /** Raw outcome value (TB count, XBH count, walk count, or HR count). */
  outcomeValue: numeric("outcome_value").notNull(),
  /** Did the player achieve the market threshold? */
  outcomeHit: boolean("outcome_hit").notNull(),
  plateAppearances: integer("plate_appearances"),
  atBats: integer("at_bats"),
  singles: integer("singles"),
  doubles: integer("doubles"),
  triples: integer("triples"),
  homeRuns: integer("home_runs"),
  walks: integer("walks"),
  settlementState: settlementStateEnum("settlement_state").notNull().default("PENDING"),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
  ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.ingestRunId),
  /** Official MLB response identity and calculation evidence; never betting data. */
  officialSourceMetadata: jsonb("official_source_metadata").notNull().default({}),
  /** Self-reference for a corrected settled outcome. The original is never updated. */
  correctionOf: uuid("correction_of").references((): AnyPgColumn => historicalOutcomes.outcomeId),
  /** Reuses the Phase 4A approved process-error taxonomy for settlement corrections. */
  processErrorTaxonomy: snapshotCorrectionReasonEnum("process_error_taxonomy"),
  correctionNote: text("correction_note"),
  raw: jsonb("raw").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  settledOriginalUniqueIdx: uniqueIndex("historical_outcomes_settled_original_idx")
    .on(table.playerId, table.gamePk, table.market)
    .where(sql`settlement_state IN ('SETTLED', 'POSTPONED', 'NO_ACTION', 'DISPUTED') AND correction_of IS NULL`),
}));

/**
 * Immutable, operator-readable comparison of frozen pregame research against
 * one official settled result. This table intentionally has no pricing,
 * odds, probability, EV, or sportsbook fields.
 */
export const marketPostmortems = pgTable("market_postmortems", {
  postmortemId: uuid("postmortem_id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => pregameFeatureSnapshots.snapshotId),
  outcomeId: uuid("outcome_id").notNull().references(() => historicalOutcomes.outcomeId),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
  market: marketTypeEnum("market").notNull(),
  snapshotFeatureHash: text("snapshot_feature_hash").notNull(),
  outcomeValue: numeric("outcome_value").notNull(),
  outcomeHit: boolean("outcome_hit").notNull(),
  researchRank: integer("research_rank"),
  researchState: text("research_state"),
  primaryMechanism: text("primary_mechanism"),
  notes: text("notes"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  snapshotOutcomeUniqueIdx: uniqueIndex("market_postmortems_snapshot_outcome_idx")
    .on(table.snapshotId, table.outcomeId),
}));

/**
 * A versioned, market-specific trained artifact. Activation is deliberately
 * guarded by the Phase 5B walk-forward acceptance record.
 */
export const modelVersions = pgTable("model_versions", {
  versionId: text("version_id").primaryKey(),
  market: marketTypeEnum("market").notNull(),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  trainingSeasons: jsonb("training_seasons").notNull().default([]),
  featureSetHash: text("feature_set_hash").notNull(),
  algorithm: text("algorithm").notNull(),
  hyperparameters: jsonb("hyperparameters").notNull().default({}),
  trainingSampleCount: integer("training_sample_count").notNull(),
  status: modelVersionStatusEnum("status").notNull().default("DRAFT"),
  artifactKey: text("artifact_key").notNull(),
  artifactGeneration: text("artifact_generation").notNull(),
  artifactContentHash: text("artifact_content_hash").notNull(),
  // Phase 5B stores the passing walk_forward_runs.run_id here.
  walkForwardAcceptanceId: uuid("walk_forward_acceptance_id"),
  /** Accepted deployment calibration derived from fold-local validation fits. */
  calibrationMethod: text("calibration_method"),
  calibrationSlope: numeric("calibration_slope"),
  calibrationIntercept: numeric("calibration_intercept"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  marketStatusIdx: index("model_versions_market_status_idx").on(table.market, table.status),
}));

/**
 * Server-computed daily confidence rows are kept separate from mutable research
 * candidates so each displayed output retains its frozen snapshot and model
 * identity. FIRE/HALF/HOLD/NONE are approved confidence states, not betting
 * recommendations. No sportsbook, odds, EV, CLV, or recommendation field belongs here.
 */
export const dailyMarketBoard = pgTable("daily_market_board", {
  boardId: uuid("board_id").primaryKey().defaultRandom(),
  slateDate: date("slate_date").notNull(),
  gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  market: marketTypeEnum("market").notNull(),
  researchRank: integer("research_rank"),
  researchState: researchStateEnum("research_state").notNull(),
  primaryMechanism: text("primary_mechanism"),
  snapshotId: uuid("snapshot_id").references(() => pregameFeatureSnapshots.snapshotId),
  modelVersionId: text("model_version_id").references(() => modelVersions.versionId),
  modelPrediction: numeric("model_prediction"),
  confidenceLabel: confidenceLabelEnum("confidence_label").notNull().default("NONE"),
  confidenceBasis: confidenceBasisEnum("confidence_basis").notNull().default("RESEARCH_ONLY"),
  calibratedProbability: numeric("calibrated_probability"),
  boardFrozenAt: timestamp("board_frozen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  dailyBoardUniqueIdx: uniqueIndex("daily_market_board_slate_market_player_game_idx").on(
    table.slateDate, table.market, table.playerId, table.gamePk,
  ),
  slateMarketIdx: index("daily_market_board_slate_market_idx").on(table.slateDate, table.market),
}));

export const walkForwardRuns = pgTable("walk_forward_runs", {
  walkForwardRunId: uuid("walk_forward_run_id").primaryKey().defaultRandom(),
  modelVersionId: text("model_version_id").notNull().references(() => modelVersions.versionId),
  market: marketTypeEnum("market").notNull(),
  foldCount: integer("fold_count").notNull().default(0),
  foldResults: jsonb("fold_results").notNull().default([]),
  overallMetric: numeric("overall_metric"),
  benchmarkMetric: numeric("benchmark_metric"),
  benchmarkBeat: boolean("benchmark_beat").notNull().default(false),
  benchmarkMethod: text("benchmark_method").notNull(),
  calibrationMethod: text("calibration_method").notNull(),
  calibrationCurve: jsonb("calibration_curve").notNull().default([]),
  calibrationError: numeric("calibration_error"),
  calibrationPassed: boolean("calibration_passed").notNull().default(false),
  /** Weighted fold-local calibration parameters for downstream inference. */
  calibrationSlope: numeric("calibration_slope"),
  calibrationIntercept: numeric("calibration_intercept"),
  status: walkForwardStatusEnum("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  errorMessage: text("error_message"),
}, (table) => ({
  modelVersionIdx: index("walk_forward_runs_model_version_idx").on(table.modelVersionId, table.startedAt),
}));

/**
 * Training attempts are retained independently from the version they produce,
 * including failed attempts with a diagnostic error.
 */
export const modelTrainingRuns = pgTable("model_training_runs", {
  trainingRunId: uuid("training_run_id").primaryKey().defaultRandom(),
  modelVersionId: text("model_version_id").references(() => modelVersions.versionId),
  market: marketTypeEnum("market").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: modelTrainingStatusEnum("status").notNull(),
  trainingSeasons: jsonb("training_seasons").notNull().default([]),
  featureSetHash: text("feature_set_hash"),
  algorithm: text("algorithm"),
  hyperparameters: jsonb("hyperparameters").notNull().default({}),
  trainingSampleCount: integer("training_sample_count"),
  featureImportance: jsonb("feature_importance").notNull().default({}),
  artifactContentHash: text("artifact_content_hash"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata").notNull().default({}),
});

/**
 * Phase 5B writes an acceptance row here before requesting ACTIVE status.
 * Keeping this table now lets the database enforce the lifecycle boundary.
 */
export const modelWalkForwardAcceptances = pgTable("model_walk_forward_acceptances", {
  acceptanceId: uuid("acceptance_id").primaryKey().defaultRandom(),
  modelVersionId: text("model_version_id").notNull().references(() => modelVersions.versionId),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  validationRunId: text("validation_run_id"),
  metrics: jsonb("metrics").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  modelVersionUniqueIdx: uniqueIndex("model_walk_forward_acceptances_model_version_idx").on(table.modelVersionId),
}));

// ─── End Phase 4A ─────────────────────────────────────────────────────────────

export const marketSettlementOutcomes = pgTable(
  "market_settlement_outcomes",
  {
    gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
    playerId: integer("player_id").notNull().references(() => players.playerId),
    singles: integer("singles").notNull().default(0),
    doubles: integer("doubles").notNull().default(0),
    triples: integer("triples").notNull().default(0),
    homeRuns: integer("home_runs").notNull().default(0),
    totalBases: integer("total_bases").notNull().default(0),
    walks: integer("walks").notNull().default(0),
    sourceId: text("source_id").notNull().references(() => sourceRegistry.sourceId),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    settlementPk: primaryKey({ columns: [table.gamePk, table.playerId] }),
  }),
);