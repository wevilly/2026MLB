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

## Acceptance test run — Gate A closeout

Executed: 2026-08-21 (Gate A — Phase 2A formal closeout)
Command: `pnpm test:phase-2a`

```
✔ Phase 2A: eligible hitter and pitcher universe is non-trivial (46ms)
✔ Phase 2A: every eligible hitter has same-day vs-LHP and vs-RHP Statcast evidence (71ms)
✔ Phase 2A: every eligible pitcher has same-day vs-LHB and vs-RHB Statcast evidence (44ms)
✔ Phase 2A: covered hitter and pitcher counts exactly match eligible universe (24ms)
✔ Phase 2A: every current-game venue has All/L/R Statcast Park Factor components persisted (9ms)
✔ Phase 2A: current slate has at least one game with a known venue (2ms)
✔ Phase 2A: the dedicated Statcast Search split run for the effective date succeeded (6ms)
✔ Phase 2A: coverage gate rejects evidence from a different effective date (3ms)
✔ Phase 2A: FanGraphs source failure is recorded as a visible ingest-run status, not silently omitted (1ms)

✔ Phase 2A: /api/analyst/data-health reports phase2aReady: true (690ms)

tests 10 · pass 10 · fail 0
```

`/api/analyst/data-health` confirmed: `overall: "READY"`, `phase2aReady: true`, `missingHandednessSplits: 0`, `parkVenueCoverageGaps: 0`, blocking issues: 0.

## Gate A verdict — CLOSED ✅

All Phase 2A acceptance criteria are satisfied as of 2026-08-21. No OPEN items remain.

Downstream phases (Phase 2B and beyond) are unblocked. The dependency rule is in effect: no downstream phase may silently compensate for an upstream data defect.
