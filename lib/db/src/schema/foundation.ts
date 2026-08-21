import {
  bigint,
  boolean,
  date,
  integer,
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

export const futureMarketPredictions = pgTable("future_market_predictions", {
  predictionId: uuid("prediction_id").primaryKey().defaultRandom(),
  gamePk: bigint("game_pk", { mode: "number" }).notNull().references(() => games.gamePk),
  playerId: integer("player_id").notNull().references(() => players.playerId),
  market: marketTypeEnum("market").notNull(),
  modelVersionId: text("model_version_id"),
  status: text("status"),
  predictedProbability: numeric("predicted_probability"),
  featureSnapshot: jsonb("feature_snapshot").notNull().default({}),
  lineupSnapshotId: uuid("lineup_snapshot_id").references(() => lineupSnapshots.lineupSnapshotId),
  sourceFreshness: jsonb("source_freshness").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  frozen: boolean("frozen").notNull().default(false),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
});

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