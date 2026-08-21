# Phase 2A Acceptance Report

Generated: 2026-08-21T19:49:28.443Z  
Effective date: 2026-08-21 (max MLB_OFFICIAL eligibility date)  
Season: 2026

## Overall verdict: ✅ READY

| Criterion | Required | Actual | Pass |
|---|---|---|---|
| Eligible hitter coverage | 100% (0 missing) | 486/486 | ✅ |
| Eligible pitcher coverage | 100% (0 missing) | 568/568 | ✅ |
| Total eligible coverage | 1054/1054 | 1054/1054 | ✅ |
| Missing splits | 0 | 0 | ✅ |
| Coverage scope | FULL_ELIGIBLE_HITTER_AND_PITCHER_UNIVERSE | FULL_ELIGIBLE_HITTER_AND_PITCHER_UNIVERSE | ✅ |
| Split ingest run status | SUCCESS | SUCCESS | ✅ |
| Park venues required | ≥1, 0 gaps | 15 venues, 0 gaps | ✅ |

## Handedness split evidence

- **Scope**: Full official eligible hitter and pitcher universe (not game-day matchups only)
- **Eligible hitters**: 486
- **Covered hitters** (both L+R same-day DERIVED_FROM_STATCAST): **486**
- **Eligible pitchers**: 568
- **Covered pitchers** (both L+R same-day DERIVED_FROM_STATCAST): **568**
- **Missing splits**: **0**
- **Coverage gap**: 0 hitters, 0 pitchers

### Latest dedicated split ingest run (statcast_search_handedness_fallback)

- Status: **SUCCESS**
- Target scope: FULL_UNIVERSE
- Target hitters in this batch: 0
- Target pitchers in this batch: 0
- Normalized rows: 0
- Started: Fri Aug 21 2026 19:48:19 GMT+0000 (Coordinated Universal Time)
- Finished: Fri Aug 21 2026 19:48:19 GMT+0000 (Coordinated Universal Time)

**How the backfill works**: The `/api/analyst/refresh/research/splits-full` endpoint calls
`ingestStatcastHandednessFallback(date, "FULL_UNIVERSE", 24)`. The target query selects every
`player_eligibility` row where `eligible_today_research` (hitters) or
`eligible_pitcher_research` (pitchers) is true, `requires_identity_review` is false, and
`quarantined_from_current_research` is false — minus players who already have both L and R
side snapshots from a same-day SUCCESS run. This filter makes the backfill idempotent:
repeated calls process only uncovered players, and the MLB Analyst Full-Universe Split
Backfill workflow loops until `normalizedRowCount === 0`.

## Park Factor evidence

- **Required current-game venues**: 15
- **Park venue coverage gaps**: **0**
- **Components verified per side**: singles_factor, doubles_factor, triples_factor, hits_factor, hr_factor (5 of 5)
- **Sides required per venue**: All (null), L (LHB), R (RHB)

## Known non-blocking source issues

| Source | Status | Why non-blocking |
|---|---|---|
| FanGraphs | BLOCKED (returns HTML) | Full Statcast Search fallback covers the same split panels. FanGraphs failure is visible in Data Health; it does not mask missing evidence. |
| FantasyPros | PARTIAL | No official lineups posted yet (N/A is the expected state pre-lineup). Identity and split coverage are not derived from FantasyPros. |

## Reproducibility

Run `pnpm report:phase-2a` at any time to regenerate this report from live database state.
Run `pnpm test:phase-2a` to execute the behavioral acceptance test suite (9 assertions against the live DB).

The queries in this report are identical to those in `researchHealth()` in
`artifacts/api-server/src/services/research-foundation.ts` and in
`tests/phase-2a-acceptance.test.mjs`.
