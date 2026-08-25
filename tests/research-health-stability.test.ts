import assert from "node:assert/strict";
import test from "node:test";
import { bundleService } from "./helpers/bundle.ts";

type HealthRow = {
  player_profiles: number;
  pitcher_profiles: number;
  arsenal_profiles: number;
  park_profiles: number;
  identity_quarantines: number;
  insufficient_samples: number;
  missing_arsenal: number;
  missing_handedness_splits: number;
  metric_definition_conflicts: number;
  stale_windows: number;
  eligible_hitter_profiles: number;
  eligible_pitcher_profiles: number;
  hitter_profiles_missing_evidence: number;
  pitcher_profiles_missing_evidence: number;
  no_mlb_sample: number;
  source_threshold_or_unavailable: number;
  identity_or_eligibility_gaps: number;
  role_gaps: number;
  handedness_target_players: number;
  handedness_covered_players: number;
  handedness_ingest_status: string;
  park_required_venues: number;
  park_venue_coverage_gaps: number;
  lineup_hitters: number;
  lineup_hitters_missing_bats: number;
  slate_starters: number;
  slate_starters_missing_throws: number;
  players_total: number;
  players_missing_throws: number;
  players_missing_bats: number;
};

declare global {
  // Test-only hook supplied by the bundled database stub.
  // eslint-disable-next-line no-var
  var __workspaceTestPoolQuery: ((sql: string, values?: unknown[]) => Promise<{ rows: HealthRow[] }>) | undefined;
}

test("research health stays stable across identical same-slate checks", async () => {
  const queries: string[] = [];
  const row: HealthRow = {
    player_profiles: 300, pitcher_profiles: 150, arsenal_profiles: 150, park_profiles: 15,
    identity_quarantines: 1715, insufficient_samples: 0, missing_arsenal: 0, missing_handedness_splits: 0,
    metric_definition_conflicts: 0, stale_windows: 2, eligible_hitter_profiles: 300, eligible_pitcher_profiles: 150,
    hitter_profiles_missing_evidence: 0, pitcher_profiles_missing_evidence: 0, no_mlb_sample: 0,
    source_threshold_or_unavailable: 0, identity_or_eligibility_gaps: 0, role_gaps: 0,
    handedness_target_players: 450, handedness_covered_players: 450, handedness_ingest_status: "SUCCESS",
    park_required_venues: 15, park_venue_coverage_gaps: 0, lineup_hitters: 270,
    lineup_hitters_missing_bats: 0, slate_starters: 30, slate_starters_missing_throws: 0,
    players_total: 1000, players_missing_throws: 0, players_missing_bats: 0,
  };
  globalThis.__workspaceTestPoolQuery = async (sql) => {
    queries.push(sql);
    return { rows: [row] };
  };

  try {
    const { researchHealth } = await bundleService("artifacts/api-server/src/services/research-foundation.ts") as {
      researchHealth: (effectiveDate: string) => Promise<{ identityQuarantines: number; staleWindows: number }>;
    };
    const first = await researchHealth("2026-08-25");
    const second = await researchHealth("2026-08-25");

    assert.deepEqual(second, first);
    assert.equal(first.identityQuarantines + first.staleWindows, 1717);
    assert.equal(queries.length, 2);
    for (const sql of queries) {
      assert.match(sql, /latest_research_runs AS/);
      assert.match(sql, /JOIN latest_research_runs lr ON lr\.ingest_run_id = q\.ingest_run_id/);
      assert.match(sql, /FROM latest_research_runs WHERE status <> 'SUCCESS'/);
    }
  } finally {
    globalThis.__workspaceTestPoolQuery = undefined;
  }
});