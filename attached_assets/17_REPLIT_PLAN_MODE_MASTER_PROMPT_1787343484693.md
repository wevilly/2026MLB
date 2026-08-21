# Replit Plan Mode Master Prompt

Use this only after the planning pack is approved.

---

Read the entire MLB Analyst Platform planning pack before proposing implementation work.

You are entering PLAN MODE. Do not write or modify product code during this planning pass.

The current product has completed the identity/data-foundation phases and is closing Phase 2A research-data acceptance. The approved future roadmap is documented in this pack.

Your job is to convert the roadmap into a multi-task execution plan that can be reviewed before implementation.

## Required planning output

Create discrete Replit tasks for:

1. Phase 2A final acceptance closeout, only if still required.
2. Phase 2B Bullpen Research and Availability Foundation.
3. Phase 3 shared market-research contract.
4. Phase 3A Total Bases research engine.
5. Phase 3B Extra Base Hit research engine.
6. Phase 3C Batter Walk research engine.
7. Phase 3D Home Run research engine.
8. Phase 4 historical pregame feature store.
9. Phase 4 official settlement and postmortem engine.
10. Phase 5 model training/versioning framework.
11. Phase 5 walk-forward validation and calibration by market.
12. Phase 6 daily market rankings and confidence board.
13. Phase 7 Bettor Intelligence ingestion and lineage.
14. Phase 7 Bettor Intelligence evaluation/dashboard.
15. Phase 8 AI Analyst read-only tool layer.
16. Phase 8 AI Analyst workflows and sourcing/rejection register.
17. Phase 9 daily ingestion/refresh orchestration.
18. Phase 9 settlement/postmortem automation and exports.
19. Phase 10 hardening, performance, security, and UX.
20. Final end-to-end acceptance and operator runbook.

## For every task specify

- task title
- purpose
- dependencies
- files/systems likely affected at a conceptual level
- data sources
- inputs
- outputs
- database/schema implications
- API/UI implications
- migration/backfill needs
- tests
- live validation evidence
- acceptance criteria
- blocking conditions
- tasks that may run safely in parallel
- explicit out-of-scope items

## Planning rules

Do not reintroduce sportsbook price, odds, implied probability, EV, or CLV into core selection/ranking/model logic.

The four independent future markets are:
- 2+ Total Bases
- 1+ Extra Base Hit
- Batter Walk
- Home Run

XBH means double, triple, or home run. Singles never count.

Do not merge the four markets into one hitter score or one universal target model.

Do not allow AI to become a source of official state or mutate frozen historical records.

Do not use FantasyPros to overwrite MLB official state.

Do not invent missing baseball data.

Do not begin coding in this planning pass.

## Dependency discipline

Identify the critical path and what can safely be parallelized.

Model tasks must depend on official historical target integrity.

Prediction-confidence tasks must depend on validated/calibrated models.

Bettor evaluation must distinguish independent sources from copied consensus.

AI must come after deterministic source/model/settlement workflows are trustworthy.

## Final plan output

Return:
1. master task list in dependency order;
2. critical path;
3. parallel workstreams;
4. phase gates;
5. biggest technical risks;
6. data-source risks;
7. migration/backfill risks;
8. proposed task acceptance evidence;
9. anything in the planning pack that is ambiguous or contradictory;
10. recommended edits to the planning pack before implementation.

Stop after the plan. Do not start any task until the plan is reviewed and approved.
