# MLB Analyst Platform — Replit Continuation Prompt v3

Continue the existing MLB Analyst Platform from its current Replit state.

Before coding, read these files in this order:

1. `00_READ_ME_FIRST.md`
2. `02_CURRENT_PROJECT_RULES.md`
3. `03_DATA_SOURCE_PRECEDENCE.md`
4. `10_XBH_MARKET_SPEC.md`
5. `06_CANONICAL_PLAYER_IDENTITY_SPEC.md`
6. `12_PHASE1B_ACCEPTANCE_CHECKLIST.md`
7. `08_HISTORICAL_DATA_MANIFEST.md`
8. `09_HISTORICAL_RESEARCH_SEED.json`
9. Existing methodology under `knowledge/`
10. Latest Replit progress report under `reference/`

This prompt supersedes older Replit prompts wherever they conflict.

---

# CURRENT PRODUCT OBJECTIVE

Build an auditable MLB research operating system optimized for:

**prediction accuracy + baseball research quality**

Do not optimize the core decision system around sportsbook price.

The core platform must support FOUR independent hitter markets:

- `TOTAL_BASES_2_PLUS`
- `EXTRA_BASE_HIT`
- `BATTER_WALK`
- `HOME_RUN`

`EXTRA_BASE_HIT` means at least one double, triple or home run.

Two singles can satisfy 2+ TB but cannot satisfy XBH.

Never use one universal hitter score across the four markets.

---

# PRICE/ODDS RULE

Do not use any of these to select, rank, upgrade, downgrade or block a prediction:

- price
- odds
- implied probability
- price-based EV
- CLV

If old database tables or code already contain odds fields, they may remain only for backward compatibility if removal would destabilize migrations.

They must be OPTIONAL and disconnected from the core readiness, ranking and confidence workflows.

Do not restore old price gates from historical files.

---

# DO NOT WAIT FOR THE USER TO SEND PUBLIC DATA

The user-side package already contains the private/project-specific material.

For public information that you can obtain yourself, obtain it yourself.

Do NOT ask the user to manually upload:

- FantasyPros public API documentation
- MLB Stats API examples
- public Chadwick ID files
- public GitHub repositories listed in this package

See:

- `04_FANTASYPROS_LIVE_FIXTURE_TASKS.md`
- `05_MLB_STATS_API_FIXTURE_TASKS.md`
- `13_PUBLIC_REPO_SELF_FETCH.md`
- `15_DO_NOT_ASK_USER_FOR_PUBLIC_DATA.md`

The FantasyPros API key is already stored in Replit Secrets as:

`FANTASYPROS_API_KEY`

Use it only server-side.

Do not expose it in code, logs, API responses, screenshots or fixtures.

---

# CURRENT PHASE ONLY — DATA FOUNDATION

Do NOT build betting picks or validated market models yet.

Do NOT create fake probabilities.

Do NOT create a fake XBH heuristic.

Do NOT activate the AI Analyst yet.

The current task is to complete the data foundation and make the existing Today, Projection Center, Data Health and Settings surfaces real.

During this pre-model phase, use only:

- READY
- PARTIAL
- BLOCKED

Do not show FIRE/HALF/HOLD/PASS/PARKED until validated market-specific research/model engines exist.

---

# 1. DATABASE + PROVENANCE MUST BE BUILT WITH INGESTION

Do not build MLB ingestion first and retrofit provenance later.

Every production ingestion path must write through a persistent audit/provenance layer.

At minimum support:

- source registry
- ingest runs
- raw payload checksum/reference
- source retrieval timestamp
- effective date
- normalization status
- row/entity counts
- error/partial metadata

Time-varying evidence must preserve history.

Never overwrite an earlier FantasyPros projection or lineup snapshot with a later one.

---

# 2. CANONICAL PLAYER IDENTITY

Implement one internal canonical player identity.

Support external IDs for:

- MLBAM
- FantasyPros
- FanGraphs later
- Statcast/MLB
- Retrosheet later
- Baseball-Reference later

Use the requirements in:

- `06_CANONICAL_PLAYER_IDENTITY_SPEC.md`
- `07_PLAYER_IDENTITY_TEST_CASES.json`

Identity states:

- CONFIRMED
- HIGH_CONFIDENCE
- REVIEW_REQUIRED

Do not silently fuzzy-merge uncertain players.

Identity conflicts must appear in Data Health.

Use Chadwick Register as a public bootstrap/reference where appropriate, and record the version/commit inspected.

---

# 3. MLB OFFICIAL INGESTION

Implement the official MLB ingestion path.

For a requested date persist:

- MLB game ID/gamePk
- date
- first pitch
- teams
- venue
- official game state
- roster/player identity where needed
- probable pitchers
- official starters when supplied
- starter-state history
- official posted lineups
- batting order
- positions

Starter states must support:

- CONFIRMED
- PROBABLE
- TBD
- OPENER
- BULK
- UNKNOWN

Do not invent OPENER or BULK when the source does not establish it.

MLB official state owns posted lineups and official starter fields.

---

# 4. FANTASYPROS INGESTION

Use the configured secret and live API.

Replit must read the current official FantasyPros API documentation itself and generate sanitized fixtures itself.

Ingest available:

- hitter daily projections
- pitcher daily projections
- lineup evidence
- player metadata
- news

Store every pull as an immutable snapshot.

Preserve raw response plus normalized fields.

Preserve component stats individually, particularly fields relevant to future XBH research such as doubles, triples and HR when returned.

Do not derive a fake XBH probability.

If an endpoint is unavailable under the configured plan, record NOT ACCESSIBLE and continue.

---

# 5. FOUR-MARKET ARCHITECTURE NOW

Even though models are not active, database types, API contracts and future UI stubs must support:

- TOTAL_BASES_2_PLUS
- EXTRA_BASE_HIT
- BATTER_WALK
- HOME_RUN

No schema or enum may assume exactly three markets.

For XBH use `10_XBH_MARKET_SPEC.md`.

---

# 6. PROJECTION CENTER

Make Projection Center functional using real stored FantasyPros data.

Support filters for:

- date
- game
- team
- player
- hitter/pitcher
- projection snapshot time
- lineup state

Show real source fields only.

Add intraday snapshot comparison such as:

- morning
- midday
- afternoon
- latest

If internal market models are not active, show:

`NOT ACTIVE`

Do not populate fake comparison values.

---

# 7. TODAY DASHBOARD

Populate Today from real MLB state.

Each game should show:

- matchup
- first pitch ET
- venue
- starter names/states
- lineup states
- last MLB update
- FantasyPros availability
- blocking issues
- readiness status

Readiness states only:

- READY
- PARTIAL
- BLOCKED

---

# 8. DATA HEALTH

Expand Data Health into an operational control room.

For each source show:

- configured
- last attempt
- last success
- current freshness
- rows/entities received
- normalized
- rejected
- HTTP status
- duration
- most recent error
- next scheduled run when applicable

Issue queues must support:

- IDENTITY_CONFLICT
- GAME_STATE_CONFLICT
- STARTER_CONFLICT
- LINEUP_CONFLICT
- SOURCE_FAILURE
- STALE_SOURCE
- NORMALIZATION_FAILURE
- DUPLICATE_ENTITY
- MISSING_REQUIRED_FIELD

Issue records need severity, entity, first seen, latest seen, state and resolution note.

---

# 9. HISTORICAL MATERIAL

Read the historical seed and legacy files only as evidence.

See:

- `08_HISTORICAL_DATA_MANIFEST.md`
- `09_HISTORICAL_RESEARCH_SEED.json`
- `legacy_historical/README_LEGACY.md`

Do not let historical price requirements, old algorithms or old three-market assumptions override current rules.

Do not convert historical cards directly into training rows during this phase.

---

# 10. BULLPEN DATA PREPARATION

Do not build the full Bullpen Room yet unless it is already part of current work.

But ensure the schema can later support the append-only requirements in:

- `11_BULLPEN_REQUIREMENTS.md`
- `knowledge/04_BULLPEN_PROTOCOL.md`

Do not design one universal bullpen rating.

Future bullpen analysis must support separate TB/XBH/Walk/HR effects.

---

# 11. PUBLIC REPOSITORY RESEARCH

Inspect the repositories in `13_PUBLIC_REPO_SELF_FETCH.md` yourself.

For every repository materially used, record:

- URL
- commit SHA inspected
- license
- concept borrowed
- files/code reused, if any

Do not copy whole repositories into the application unnecessarily.

Public repo conventions never override current project rules.

---

# 12. TESTS REQUIRED

At minimum test:

## Idempotency
Running the same MLB ingest twice does not duplicate games/players.

## Snapshot immutability
A later FantasyPros pull cannot mutate an earlier snapshot.

## Identity
Stable IDs map correctly; ambiguous name-only cases enter review.

## Starter state
TBD stays TBD until evidence changes it.

## Lineup state
Projected does not become posted just because FantasyPros lists it.

## Security
`FANTASYPROS_API_KEY` never appears in client code, API payloads or committed fixtures.

## Missing data
Missing values remain NOT FOUND / NOT RUN / NOT ACTIVE as appropriate.

## Four-market support
The application accepts the four canonical market types and does not assume three.

## Price independence
Core readiness and research architecture do not depend on price/odds/EV/CLV.

---

# 13. ACCEPTANCE REPORT — STOP HERE

Use `12_PHASE1B_ACCEPTANCE_CHECKLIST.md` as the formal acceptance gate.

Do not proceed to Statcast, bullpen models, prediction engines, bettor intelligence or AI automatically.

Return an acceptance report with concrete evidence including:

1. Database tables created/changed.
2. Public/source adapters implemented.
3. Exact MLB endpoints used.
4. Exact FantasyPros endpoints used.
5. Real test-date row counts.
6. Player identity match rate.
7. Unresolved identity count and sample issues.
8. Projection snapshot count.
9. Lineup snapshot count.
10. Sanitized fixture list.
11. Idempotency test results.
12. Snapshot immutability test results.
13. Secret-leak/security test results.
14. Four-market enum/type proof.
15. Price-independent workflow proof.
16. Screenshot: Today.
17. Screenshot: Projection Center.
18. Screenshot: Data Health.
19. Screenshot: Settings.
20. Failed tests.
21. Known API limitations/plan restrictions.
22. Any deviation from this prompt.
23. Exact recommendation for Phase 2.

Stop after the acceptance report.
