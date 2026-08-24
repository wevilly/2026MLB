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
| Migrations drizzle push cannot express | `lib/db/scripts/pre-push-migrations.mjs` |
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
  server.

## Known open work

`docs/MLB_Analyst_Next_Session_Plan_20260824.docx` is the starting point. It
sequences the deployment steps that have to run before the system produces
anything, the two decisions that need an operator answer, the measurements still
owed, and the audit backlog by severity.

Read it first, because the remediation is merged but not deployed: the
migrations have not been applied and no model has been retrained under the new
fitter, so the board still emits RESEARCH_ONLY for every row.

`docs/audit-extension-2026-08-24.md` holds the findings for every service the
original audit did not read, plus the frontend. Seventeen items are scheduled
there, with severity and with which earlier task each repeats. The one to read
first is S1: `players.throws` is overwritten with an empty string by the
game-feed player upsert, which silently degrades the platoon and split-metric
layer in every engine to unsplit season values.

`docs/repository-inventory.md` holds the repository hygiene assessment.

## Pointers

- See the `pnpm-workspace` skill for workspace structure and package details.
- `docs/operator-runbook.md` for day-to-day operation.
