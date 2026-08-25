# MLB Analyst Platform

Ranked, source-backed research evidence for four MLB batter markets, plus honest
calibrated probabilities when and only when a validated model exists. It does
not price anything and it does not size anything.

## What this app produces

For each slate date the platform produces:

- **Market research candidates** for four markets: 2+ total bases (TB), 1+ extra
  base hit (XBH), batter walk (WALK) and home run (HR), each with an ordinal
  rank and the evidence behind it. A fifth research-only board, H+R+RBI, is
  derived from the TB board for Round Robin use.
- **A daily market board**, one persisted row per player-market-game, carrying
  the research rank plus, when a validated model is ACTIVE for that market, a
  calibrated probability and a confidence label.
- **Round Robin comparisons**, same-team two-leg constructions per game, with
  the losing side's alternatives retained and ties surfaced rather than
  collapsed.
- **Settlement**, the official post-game record every board candidate is graded
  against, which is also the training data for the modelling layer.

FIRE / HALF / HOLD / NONE are confidence labels. They are not stake sizes and
not recommendations.

## What this system does NOT do

Read this before adding anything.

- **No pricing.** No odds, prices, payouts, implied probability, expected value,
  closing line value, vig, stake sizing or bankroll management, anywhere in any
  code path. `settlement.ts` enforces this with `assertNoBettingData()` and
  `feature-store.ts` with its own recursive check, on both field names and
  string values. Those guards must not be weakened. Pricing is handled outside
  this system by the operator at the book.
- **No automatic model promotion.** A model reaches ACTIVE only through
  `POST /analyst/models/:versionId/promote`, initiated by a person. The
  orchestration pipeline trains and validates; it never promotes. Revisit only
  after at least two weeks of validation history exist.
- **No firing.** Every pair and parlay construction is surfaced to a human for a
  decision. The system ranks and discloses.

## Run and operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (`PORT` is required, there is no default)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run test:unit` — every test that needs no database and no running server
- `pnpm run test:all` — the full acceptance suite (needs `DATABASE_URL` and a running server)
- `pnpm run build` — typecheck plus build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — run pre-push migrations, push schema, then reapply immutability policy (dev only)
- Required env: `DATABASE_URL`, `PORT`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod, `drizzle-zod`
- API codegen: Orval, from the OpenAPI spec
- Build: esbuild

## Where things live

**Source of truth, by question:**

| Question | File |
| --- | --- |
| Database schema | `lib/db/src/schema/foundation.ts` |
| Database policy: triggers, roles, partial indexes | `lib/db/scripts/apply-immutability.mjs` |
| Migrations drizzle push cannot express, or that would make it prompt | `lib/db/scripts/pre-push-migrations.mjs` |
| Prohibited-betting vocabulary | `artifacts/api-server/src/services/betting-content-guard.ts` |
| One-off data repair | `lib/db/scripts/backfill-handedness.mjs` |
| API contract | `lib/api-spec/openapi.yaml` |
| Generated request/response types and hooks | `lib/api-zod/src/generated`, `lib/api-client-react/src/generated` |
| Selection eligibility rules | `lib/api-zod/src/market-research-eligibility.ts` |
| Frontend theme and styles | `artifacts/mlb-analyst/src/index.css` |

**Repo map:**

```
artifacts/api-server/src/
  routes/analyst.ts           every analyst HTTP route
  services/
    market-codes.ts           the ONE market vocabulary mapping
    model-math.ts             the ONE copy of the modelling arithmetic
    model-training.ts         fits a market model, writes CANDIDATE
    walk-forward-validation.ts validates a frozen artifact, fits deployment calibration
    model-promotion.ts        the ONLY path to ACTIVE, and the kill switch
    daily-market-board.ts     materializes the board and serves the probability
    tb-engine.ts              total bases research and ranking
    xbh-engine.ts / walk-engine.ts / hr-engine.ts / hrrbi-engine.ts
    round-robin-comparison.ts pure pair construction and comparison
    lineup-sources.ts         lineup source precedence and conflict detection
    bullpen-foundation.ts     reliever appearances, availability, leverage maps
    weather-foundation.ts     per-game forecast, wind relative to the park
    feature-store.ts          frozen pregame feature vectors
    settlement.ts             official MLB grading
    orchestration.ts          the daily pipeline and the nightly settlement job
artifacts/mlb-analyst/        the operator frontend
lib/db, lib/api-spec, lib/api-zod, lib/api-client-react
tests/                        acceptance suites; *.test.ts are database-free
```

## Hard rules

These are contracts, not preferences.

1. **No betting data.** See "What this system does NOT do".
2. **RANK, DON'T GATE.** The engines produce an ordinal rank with transparent
   evidence. A missing or stale third-order input is a disclosure on the
   surfaced row, not a veto that deletes it. The specific gate that was removed
   is the bullpen role path: it is a ranking term and a stated caveat, never an
   eligibility filter. Removing that one gate does not license adding new ones.
3. **Ties are surfaced, never collapsed.** Across sides, `decision()` returns
   VALID_TIE. Within a side, the winner records `tieBroken` and what it tied
   with. Do not add a cosmetic tiebreak to `compareConstruction`: that would
   make the cross-side tie unreachable and silently delete this contract.
4. **Contract-first changes.** Schema, then `openapi.yaml`, then codegen, then
   wire the routes, then typecheck both packages. In that order.
5. **No em dashes or en dashes in user-facing output.** Plain hyphens.
6. **Dates are YYYY-MM-DD, in America/New_York.**
7. **Nothing is settled as though a disagreement did not happen.** Where two
   sources disagree, the disagreement is recorded and surfaced.

## Append-only invariants

Four tables are append-only. A correction is a NEW row that references the row
it corrects through `correction_of`; the original is never updated.

| Table | Enforcement |
| --- | --- |
| `pregame_feature_snapshots` | database trigger |
| `historical_outcomes` | database trigger |
| `relief_appearance_log` | convention plus `ON CONFLICT DO NOTHING` on (game_pk, player_id). No trigger yet. |
| `role_change_log` | convention. No trigger yet. |

`market_postmortems`, `audit_events`, `ai_tool_call_log`, the batter-pitcher
snapshot tables and `game_weather_observations` are also trigger-protected.

The two rows in that table without a trigger are a known gap, not a decision.

## Architecture decisions a reader could not infer

- **The modelling arithmetic exists in exactly one place.** `model-math.ts`
  holds the feature flattener, the training-feature allowlist, the fitters, the
  artifact parser, the scoring transformation and the calibration
  transformation. The walk-forward validator and the daily market board call the
  same two functions on the same frozen artifact, which is the only reason the
  probability measured during validation is the probability served.
- **Walk-forward validation validates an ARTIFACT, not a procedure.** The
  artifact under validation is the artifact that gets deployed. Folds exist only
  to guarantee that the scores used for calibration and metrics are out-of-sample
  for the slate being scored. No fold refits the model.
- **A model may only see the three validated metric maps.** `hitterFeatures`,
  `pitcherFeatures` and `parkFeatures`. Everything else in the frozen vector is
  an identifier, an ordinal or a display container, and is excluded by an
  allowlist rather than a denylist.
- **The board is a materialized view with an invariant.** After every refresh,
  the set of (player, game, market) rows on `daily_market_board` must equal the
  set of non-BLOCKED candidates. The refresh fails loudly rather than leaving a
  stale row.
- **Today's slate is FantasyPros, not the MLB schedule.** The daily pipeline's
  only two required steps are `fantasypros_ingest` and `fantasypros_baseline`.
  `ingestMlbOfficial` is NOT a pipeline step: it runs from the operator refresh
  route, and inside `runNightlySettlement`, which refreshes the PRIOR slate
  before settling it. So official data arrives in time to settle yesterday, not
  to define today, and the `games` rows counted for today's slate come from
  `persistFantasyProsGames`, with a null `venue_id` and null `start_time_utc`.
  The readiness diagnostics naming FantasyPros are accurate. Tracked as audit
  S18, because the slate has no second source and no conflict detection, one
  layer above where task 2.7 put both for lineups.
- **There is no empty-slate state.** `officialEmptySlate` was removed in
  7b1171a, so a genuine published off-day reports `NO_INGEST_RUN` and a CRITICAL
  issue, which is exactly what a failed feed on a full slate reports. Audit S19.
- **Lineups have a documented source precedence and conflict detection.** A
  submitted MLB card outranks a FantasyPros report, which outranks a projection.
  Precedence supplies the roster; it never resolves a disagreement. A disputed
  player carries a blocking evidence gap.
- **Weather is forecast data, so observations are append-only.** A post-freeze
  weather change is a new observation, visible AS a change.
- **Park and weather are bounded second-order ranking terms.** Both caps sit
  strictly below the pitcher matchup term's maximum, so neither the venue nor
  the wind can outweigh the starting pitcher.

## Model lifecycle, and who may transition it

```
DRAFT ──train──▶ CANDIDATE ──validate──▶ CANDIDATE (PASS) ──promote──▶ ACTIVE
                     │                                                    │
                     └────────── validate (FAIL) ──▶ FAILED               └──demote──▶ RETIRED
```

- **Training** writes CANDIDATE. Automated, runs in the `model_training`
  pipeline step.
- **Validation** writes CANDIDATE on pass, CANDIDATE or FAILED on fail, and the
  accepted calibration parameters. Automated. Runs under the
  `mlb_walk_forward_validator` role.
- **Promotion** writes ACTIVE. **Operator-initiated only**, through
  `POST /analyst/models/:versionId/promote`. It refuses unless the version has a
  PASS walk-forward run with enough folds, an expected calibration error at or
  below threshold, the sharpness guard met, the benchmark margin met, and
  non-null calibration parameters. It retires the displaced model in the same
  transaction and writes an audit event.
- **Demotion** writes RETIRED. `POST /analyst/models/:versionId/demote` is the
  one-call kill switch: the next board refresh returns that market to
  RESEARCH_ONLY.

Exactly one ACTIVE model per market, enforced by the partial unique index
`model_versions_one_active_per_market_idx`, not only by application code.

## Gotchas

- **The `mlb_walk_forward_validator` role.** Any write that sets a model to
  ACTIVE, sets a walk-forward acceptance, changes calibration parameters, or
  moves a CANDIDATE to FAILED must run under
  `SET LOCAL ROLE mlb_walk_forward_validator`. The lifecycle trigger rejects it
  otherwise. `audit_events` is NOT writable by that role: release it with
  `RESET ROLE` before writing the audit row, still inside the transaction.
- **Run `pnpm --filter @workspace/db run push`, not `drizzle-kit push` directly.**
  Push alone skips the pre-push migrations and leaves the immutability policy
  unapplied.
- **`drizzle-kit push` EXITS 0 when it dies on an interactive prompt.** Verified
  against drizzle-kit 0.31.10: it prints the error, applies nothing, and still
  reports success, so `set -e` does not catch it and neither does checking the
  exit status. `scripts/post-merge.sh` matches the log text explicitly for this
  reason. If push ever appears to succeed while the schema does not move, this
  is why.
- **A dropped column and an added column on the same table make push prompt.**
  That is `promptColumnsConflicts`: push cannot tell a rename from a
  create-plus-drop and wants a human. There is no human in the postMerge hook,
  so it aborts the WHOLE diff, including every unrelated additive change in it.
  Write the change as explicit idempotent DDL in
  `lib/db/scripts/pre-push-migrations.mjs` instead. Pure additions never prompt.
- **A rejected lab parameter is a 400, and that is the only 400 the search
  path produces.** `app.ts` has one error middleware. It used to answer every
  uncaught error with `500 Internal server error`, and the lab routes hand all
  parameter failures to `next(error)`, so a mistyped `playerId` or an
  unsupported `window` reached the browser as a server fault. Parameter parsers
  in `routes/analyst/shared.ts` now throw `RequestValidationError`
  (`lib/http-errors.ts`), which the middleware answers with 400 and the error's
  own message. Anything else is still an opaque 500 with the detail confined to
  the log. If you add a parser, throw that type — a bare `Error` silently
  becomes a 500 again.
- **Outbound provider calls go through `upstreamFetch`, never bare `fetch`.**
  `lib/upstream-fetch.ts`. Bare `fetch` has no timeout: a provider that accepts
  the connection and then stops sending never settles, the ingest run stays
  RUNNING, and the refresh request holds until the proxy cuts it. Default 60s,
  `UPSTREAM_FETCH_TIMEOUT_MS`-overridable, clamped to 1s–300s.
- **The Player Lab answers the query it was given, or says it has none.** An
  empty search used to become `ILIKE '%%'` and then take the first row, which
  presented an arbitrary player as an answer. An explicit `playerId` used to
  bypass the eligibility join entirely, so a pitcher id answered on the hitter
  lab. Both gates are in `labProfile`; the reason for every empty state reaches
  the UI through `sourceStatus` and `notices`.
- **Codegen sets `clean: true`.** A failed `orval` run deletes every generated
  file before it fails. Recover with
  `git checkout -- lib/api-zod/src/generated lib/api-client-react/src/generated`,
  then fix the spec and re-run. Codegen is idempotent: a run with no spec change
  must leave no diff.
- **Handedness is NULL when unknown, never an empty string.** `players.bats` and
  `players.throws` feed the platoon layer, and an empty string is not null: it
  reads as a recorded value, `resolveBatterSide` returns null for a switch
  hitter, and every split metric silently falls back to the unsplit season line.
  Both player upserts guard on a non-empty excluded value, the same way
  `reliever_profiles.throws` does. `lib/db/scripts/backfill-handedness.mjs`
  re-hydrates gaps from the MLB people endpoint and never overwrites a known
  value.
- **Advisory lock keys in use**, all `hashtext(key)` unless noted:
  - `orchestration-launch:{date}`
  - `orchestration-execution:{runId}`
  - `orchestration-freeze:{runId}`
  - `settlement-automation:{date}`
  - `pg_advisory_xact_lock(gamePk, 4142)` for one game's settlement
- **The walk settlement definition is an assumption.** `WALK_SETTLEMENT_POLICY`
  in `settlement.ts` currently grades walks as MLB `baseOnBalls`, which includes
  intentional walks and excludes hit by pitch. This has NOT been confirmed
  against the operator's settlement rule. Walks, intentional walks and hit by
  pitch are each persisted separately, so changing the policy is two flags plus
  a historical re-grade, with no feed re-fetch.
- **A row settled without a frozen snapshot never trains.** It carries
  `settled_without_snapshot` and both training queries exclude it.
- **`missing_stale_evidence` is a blocking field.** Anything written into it
  makes the candidate non-selectable through
  `getMarketResearchSelectionEligibility`. Do not put disclosures there. Bullpen
  state in particular belongs on the bullpen evidence block.
- **Feature vectors are hashed for idempotency.** `capturedAt` is deliberately
  excluded from the hash and added after it is computed.
- **Tests ending in `.test.ts` are database-free** and run through
  `tests/helpers/bundle.ts`, which stubs the pool, the artifact storage client
  and the logger. Tests ending in `.test.mjs` need a live database and a running
  server. Exceptions exist: some `.test.mjs` files only read source text.
- **Every test file must appear in a package script.** Four did not, and two of
  them had been failing silently since routes/analyst.ts was split.
  `tests/test-suite-coverage.test.ts` fails if a test file is left out of every
  script. A test that never runs is worse than no test, because it reads as
  coverage.
- **Content from outside the system is fenced before it reaches a prompt.**
  `runAiAnalystChat` wraps tool output in `UNTRUSTED_TOOL_OUTPUT` markers, and
  the system prompt states that nothing inside them is an instruction. The
  markers are stripped from the payload first, so retrieved text cannot close
  the fence and continue as trusted input.
- **The prohibited-betting vocabulary lives in one place**,
  `services/betting-content-guard.ts`. `prohibitedBettingTerm` is for structured
  keys and identifiers; `prohibitedBettingTermInProse` is for free text written
  by a person and exempts only "over" and "under", which are ordinary English in
  a sentence and betting sides in a field name.

## Known open work

`docs/audit-extension-2026-08-24.md` holds the findings for every service the
original audit did not read, plus the frontend. Seventeen items are scheduled
there, with severity and with which earlier task each repeats. The one to read
first is S1: `players.throws` is overwritten with an empty string by the
game-feed player upsert, which silently degrades the platoon and split-metric
layer in every engine to unsplit season values.

`docs/repository-inventory.md` holds the repository hygiene assessment.

`docs/search-failure-risk-review-2026-08-25.md` verifies the 30-item Search
Failure Risk Report against the code and records what was fixed, what was
already fixed (S-19), what was overstated (S-22), and what remains open. The
finding worth reading even if the search is not your concern: an explicit
`playerId` used to bypass every eligibility gate, so a bookmark could return a
hitter profile for a pitcher, or a profile for a player held for identity
review.

**`pnpm run test:all` needs a provisioned database and a started API.** Five
`phase-*-acceptance` files throw `DATABASE_URL must be set` before they load and
the rest fail on ECONNREFUSED or `fetch failed`. That is 23 failures on a clean
checkout and none of them is breakage. `test:unit` is the suite that runs
anywhere; it is green and it is the one to trust for a quick check.

## Pointers

- See the `pnpm-workspace` skill for workspace structure and package details.
- `docs/operator-runbook.md` for day-to-day operation.
