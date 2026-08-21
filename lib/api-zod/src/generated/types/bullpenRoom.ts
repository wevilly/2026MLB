/**
 * Phase 2B – Bullpen Room types.
 * Hand-authored to match the OpenAPI spec additions.
 */

export type BullpenArmAvailability = 'AVAILABLE' | 'LIKELY_AVAILABLE' | 'DOUBTFUL' | 'OUT' | 'UNKNOWN' | 'STALE';
export type BullpenConfidence = 'HEURISTIC' | 'MANAGER_OVERRIDE' | 'UNKNOWN';

export interface BullpenLeverageMap {
  projected9th: number | null;
  projected8th: number | null;
  projected7th: number | null;
  highestLeverageLefty: number | null;
  longMan: number | null;
  highestWalkReliever: number | null;
  lowestWalkReliever: number | null;
  roleUncertainty: boolean;
  notes: string | null;
  computedAt: string | null;
}

export interface BullpenArm {
  playerId: number;
  name: string;
  throws: string;
  role: string;
  availability: BullpenArmAvailability;
  confidence: BullpenConfidence;
  d1Pitches: number | null;
  d2Pitches: number | null;
  d3Pitches: number | null;
  consecutiveDays: number;
  multiInningYesterday: boolean;
  daysSinceLastUse: number | null;
  managerOverride: string | null;
  managerOverrideNote: string | null;
  staleBadge: boolean;
  sourceFreshness: string | null;
  computedAt: string | null;
}

export interface BullpenUsageEntry {
  playerId: number;
  name: string;
  pitches: number;
  ip: string;
  multiInning: boolean;
}

export interface BullpenUsage {
  d1: BullpenUsageEntry[];
  d2: BullpenUsageEntry[];
  d3: BullpenUsageEntry[];
}

export interface BullpenTeam {
  teamId: number;
  abbreviation: string;
  name: string;
  slateDate: string;
  leverageMap: BullpenLeverageMap;
  arms: BullpenArm[];
  usage: BullpenUsage;
  coveragePercentage: number;
  staleBadge: boolean;
  computedAt: string | null;
}

export interface BullpenRoomSummary {
  teamsWithData: number;
  teamsStale: number;
  totalArms: number;
  armsAvailable: number;
  armsLikelyAvailable: number;
  armsDoubtful: number;
  armsOut: number;
  armsUnknown: number;
}

export interface BullpenRoom {
  date: string;
  requestedTeam: string | null;
  staleFreshnessWindowSeconds: number;
  teams: BullpenTeam[];
  summary: BullpenRoomSummary;
}

export interface BullpenIngestResult {
  source: string;
  slateDate: string;
  gamesProcessed: number;
  appearancesNormalized: number;
  appearancesRejected: number;
  teamsComputed: number;
  error: string | null;
}

export interface GetAnalystBullpenRoomParams {
  date?: string;
  team?: string;
}

export interface RefreshBullpenParams {
  date?: string;
}
