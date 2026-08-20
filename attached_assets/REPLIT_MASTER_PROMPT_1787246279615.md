# Replit Agent Master Prompt - MLB Analyst Platform v2

Build the MLB Analyst Platform from the files in this project.

**Start in Plan mode. Do not build the entire product at once.**

Before writing code, inspect all top-level specification files and the `knowledge/` folder. In particular read:
- `README_START_HERE.md`
- `PRODUCT_ARCHITECTURE.md`
- `UI_UX_SPEC.md`
- `FANTASYPROS_INTEGRATION.md`
- `DATA_SOURCE_ARCHITECTURE.md`
- `DATABASE_SCHEMA.sql`
- `API_CONTRACTS.md`
- `AI_ANALYST_SYSTEM_PROMPT.md`
- `STRATEGY_RULES_2026-08-20.md`
- `GITHUB_SOURCE_MATRIX.md`
- `PHASE_ACCEPTANCE.md`
- the website references in `mockups/`

Then give me a phase-by-phase implementation plan. Begin **only Phase 1** after the plan is coherent.

## Product intent

This is not a generic picks website and not a single algorithm. It is a persistent MLB research operating system containing:
- current and historical baseball data
- persistent player/pitcher/bullpen/team knowledge
- FantasyPros forward projections and projection history
- separate engines for 2+ total bases, batter walks and home runs
- exact timestamped sportsbook prices
- structured research on other bettors and their mechanisms
- an AI analyst that queries internal data, searches the web and reads uploaded research
- sourcing/rejection/disagreement logs
- immutable pregame snapshots
- automated settlement, calibration, CLV and postmortem learning
- existing JSON/XLSX export compatibility

## Stack

Use:
- Python backend, FastAPI preferred
- Replit Database/Postgres as source of truth
- SQLAlchemy + Alembic or equivalent migrations
- modern React frontend suitable for Replit
- server-side API adapters
- Replit Secrets for credentials
- tests for ingestion, identity and validation

Use Replit's database via `DATABASE_URL`. Never depend on a deployment filesystem for persistent state.

## Security

Never hard-code secrets.

The following values must come from environment variables/Replit Secrets:
- `FANTASYPROS_API_KEY`
- `OPENAI_API_KEY`
- optional odds/weather/source credentials

Secret values must never be returned to the frontend. The Settings page may display only configured/not-configured status and safe metadata.

## Source rules

- Official MLB data owns official game state.
- FantasyPros is a Phase 1 primary forward-projection source plus lineup/news cross-check.
- Preserve every projection snapshot rather than overwriting older values.
- Projected lineups are valid but must remain labeled PROJECTED.
- TBD, OPENER and BULK states must be explicit.
- Missing data stays NOT FOUND/STALE; never fabricate it.
- Every source ingest records timestamp, status and freshness.

## Phase 1 scope

Build only these capabilities:

1. **Application shell and navigation** matching `UI_UX_SPEC.md`:
   Today, Game Lab, Player Lab, Pitcher Lab, Bullpen Room, Projection Center, Bettor Intelligence, Model Lab, AI Analyst, Results/Postmortem, Data Health, Settings.
   Pages outside Phase 1 may be clearly labeled future/stub pages, but do not populate them with fake betting data.

2. **Database/migrations** from `DATABASE_SCHEMA.sql`.

3. **Source registry + ingest audit** with Data Health UI.

4. **MLB official ingestion** for teams, players/rosters, schedule, game IDs, game state and probable/official pitchers/lineups where present.

5. **FantasyPros integration** using `FANTASYPROS_API_KEY` from environment only:
   - daily MLB hitter projections
   - daily MLB pitcher projections
   - MLB lineups including projected/non-projected state
   - MLB news/metadata used in the spec
   - immutable projection snapshots
   - FantasyPros external player-ID mapping
   - source health / failure logging

6. **Today Dashboard** using real ingested game/starter/lineup/source state. No fake model probabilities.

7. **Projection Center v1** showing FantasyPros current snapshot, prior same-day snapshots and clean placeholders for internal/market systems not yet built.

8. **Data Health** showing source last attempt, last success, freshness, errors, row counts and unresolved identity conflicts.

9. **Settings / API Connections** showing only safe connection status, not secret values.

10. **Upload storage/metadata** for research packets, including hash/effective date/tags.

11. **Export compatibility service** that maps frozen future DB records to the existing `slate.json`/workbook shape; at Phase 1 this can be a tested adapter/stub without inventing picks.

12. **Tests**:
    - idempotent ingest
    - duplicate identity prevention
    - projected vs posted lineup state
    - starter state changes create new snapshots
    - FantasyPros snapshots are immutable
    - unresolved external IDs enter Data Health
    - secrets never appear in frontend payloads

## UI requirement

Use `mockups/` as the visual target. The product should look like a professional baseball/trading research terminal: dark navy/graphite, dense readable data cards, restrained status colors and source/freshness visibility.

Do not convert it into a promotional sportsbook design.

## AI architecture preparation

Do not turn on live AI in Phase 1 unless explicitly requested. Create interfaces/configuration so Phase 7 can use the OpenAI Responses API with web search, file search and custom internal function tools. The LLM must never sit inside deterministic ingestion/settlement logic.

## GitHub repositories

Use `GITHUB_SOURCE_MATRIX.md` as a research registry. Do not install or copy every repo. Review licenses and upstream health. Start production ingestion with our own adapters around official/source APIs and selectively borrow architecture/feature ideas.

## Stop condition

After Phase 1, stop and produce an **Acceptance Report** against every Phase 1 item in `PHASE_ACCEPTANCE.md` containing:
- PASS / FAIL / PARTIAL
- test result
- screenshot or route where relevant
- source/API limitation
- database tables populated
- unresolved issues
- exact next work required

Do not begin Phase 2 until Phase 1 acceptance is reviewed.
