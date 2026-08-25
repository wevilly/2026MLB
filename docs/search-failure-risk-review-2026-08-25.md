# Search Failure Risk Report: verification and remediation

The report `MLB_Analyst_Search_Failure_Risk_Report.docx` registered 30 risks
(S-01 to S-30) against the Player Lab and Pitcher Lab search path. This document
records what each one looks like against the code as it stands, and what this
change set did about it.

Format follows `docs/audit-extension-2026-08-24.md`: nothing was fixed silently,
and nothing was marked fixed that was not verified.

Verdicts:

- **CONFIRMED** — the behaviour is in the code as the report describes it.
- **CONFIRMED, FIXED HERE** — confirmed, and this change set closes it.
- **ALREADY FIXED** — the report describes a state the code has moved past.
- **OVERSTATED** — the mechanism is real but the effect is narrower than stated.
- **NOT REPRODUCED** — an operational risk that repository evidence cannot settle.

The report's own severities are kept.

---

## 1. What the report got right, and the one thing it missed

The central claim holds: a Player Lab search could return nothing for at least
six materially different reasons, and the operator could not tell them apart
without reading the API log. That is the finding, and it is correct.

The report did not identify **why** the log was the only place to look. It is
not only that the UI renders generic panels (S-30). It is that
`artifacts/api-server/src/app.ts` had exactly one error handler, and it answered
every uncaught error with `500 Internal server error`. The lab routes hand all
parameter failures to `next(error)`. So a mistyped `playerId`, an unsupported
`window`, and a malformed `date` were all reported to the browser as server
faults with no detail.

That makes two of the report's own recommendations unreachable as written. The
triage guide's row **"Search returns 400 or a generic error immediately"** could
not fire, because the lab endpoints had no code path that produced a 400. And
S-16's remediation — "publish typed 400 responses in OpenAPI" — would have
published a response the API never sent. The 400 had to exist before it could be
documented. It does now.

---

## 2. The register, item by item

### Availability and deployment

| ID | Severity | Verdict | Evidence |
|----|----------|---------|----------|
| S-01 | Critical | **CONFIRMED** | `index.ts` throws before `app.listen` when `PORT` is absent or non-numeric. Correct behaviour — a mis-configured service should refuse to start rather than bind somewhere unexpected. No change. |
| S-02 | Critical | **CONFIRMED** | `routes/health.ts` returns 503 when `SELECT 1`, the `ingest_runs` probe, or the `model_versions` probe throws. Working as intended. No change. |
| S-03 | Critical | **CONFIRMED** | Operational, not code. The post-merge hook is in place as of `20035d9`. No change. |
| S-04 | Critical | **NOT REPRODUCED** | Platform routing. The client's `baseUrl` is `/api` (`lib/api-spec/orval.config.ts`). The UI now names this case explicitly instead of showing a generic error — see S-30. |
| S-05 | High | **NOT REPRODUCED** | Release process. No code change can settle it. |
| S-06 | High | **CONFIRMED** | `orval.config.ts` sets `clean: true` on both outputs, so an interrupted run leaves the generated directories deleted. Reproduced accidentally during this work: one bad `openapi.yaml` edit removed every generated file before failing. Recovery is `git checkout -- lib/api-zod/src/generated lib/api-client-react/src/generated`, then re-run codegen. Worth adding to the runbook. |
| S-07 | High | **NOT REPRODUCED** | Vite port configuration; environment-dependent. |

### Data eligibility and search correctness

| ID | Severity | Verdict | Evidence |
|----|----------|---------|----------|
| S-08 | High | **CONFIRMED** | `labProfile` joins `player_eligibility` on `source_id = 'MLB_OFFICIAL' AND effective_date = $2` — an exact-date match with no tolerance. Intentional. The gap was that the reason never reached the operator; fixed under S-30. |
| S-09 | High | **CONFIRMED** | Same join requires `NOT requires_identity_review AND NOT quarantined_from_current_research`. Reason now surfaced — S-30. |
| S-10 | High | **CONFIRMED** | Snapshot selection is `effective_to <= $3` with no fall-forward, and `research_window = $2` with no fall-back. Both deliberate. Notice text now names the window and the date. |
| S-11 | High | **CONFIRMED, FIXED HERE** | `handleSelect` sets `playerId` and leaves `search` in the URL. Clearing the search would discard the list the operator is picking from, so instead the list states whose query it answers and flags that the profile shows the selected row only. |
| S-12 | High | **CONFIRMED, FIXED HERE** | `useState(search \|\| '')` seeded the input once, at mount. Back/forward moved the results without moving the box. A `useEffect` on `search` now keeps them together. |
| S-13 | High | **CONFIRMED, FIXED HERE — and worse than reported.** | The report says a malformed parameter "can produce a client-visible error". It produced a **500**. Three separate defects: the client sent `parseInt('12x') === 12`, silently answering for a player nobody asked for; `?playerId=` and `?playerId=null` were treated as bad requests rather than as "no player selected"; and every parser threw a bare `Error`. All three closed. |
| S-14 | High | **CONFIRMED, FIXED HERE** | `requestedDate` pattern-matched only. `2026-02-31` reached SQL. Notably the codebase already had the correct check twice — `requestedBoardDate` and `requestedBettorDate` — and the shared parser the labs use did not. The check now lives in `requestedDate`; both callers inherit it and `requestedBoardDate` no longer carries its own copy. |
| S-15 | High | **CONFIRMED** | `GetAnalystPlayerLabResponse` pins `transformation` and `status` to closed enums; an unexpected DB value fails response parsing and returns 500. Not changed: loosening the enum would let unvalidated metric provenance through, which this codebase deliberately refuses. The 500 is now distinguishable from an unreachable API in the UI, which was the diagnostic half of the problem. |
| S-16 | Medium | **CONFIRMED, FIXED HERE** | Neither lab operation documented a non-2xx response. Both now document 400 and 500; the generated React Query hooks carry `ErrorType<BadRequestResponse \| InternalErrorResponse>` instead of `ErrorType<unknown>`. |
| S-17 | Medium | **CONFIRMED, FIXED HERE** | `LIMIT 100` with no indication that anything was dropped. The query now asks for 101 rows purely to detect truncation and says so in `notices`. |
| S-18 | Medium | **CONFIRMED, FIXED HERE** | An empty search became `ILIKE '%%'`, and `profileCount.rows[0]` then picked whichever player Postgres ordered first — an arbitrary player presented as an answer. With no query and no id, the view now returns `NO SEARCH SUBMITTED`. |

### Refresh and upstream research

| ID | Severity | Verdict | Evidence |
|----|----------|---------|----------|
| S-19 | Medium | **ALREADY FIXED** | The report states a refresh does not invalidate the lab cache and that stale results persist up to 60 seconds. It does. `app.ts` registers a `res.on("finish")` hook that calls `invalidateCache("")` after any successful non-GET, and every refresh route is a POST. The whole cache is dropped, not just the lab keys. This item can be closed. |
| S-20 | High | **CONFIRMED** | Refresh is still a synchronous POST that runs the full ingest inline. Making it single-flight background work is a design change beyond this change set. The per-request bound added for S-21 reduces the worst case but does not remove it. |
| S-21 | High | **CONFIRMED, FIXED HERE** | Fourteen provider calls across research-, data- and weather-foundation used bare `fetch`. Bare `fetch` has no timeout: a provider that accepts the connection and then stops sending never settles, so the ingest run stays `RUNNING` and the request holds until the proxy cuts it — which is the mechanism behind S-20. Only `ai-tool-gateway.ts` bounded its own call. All fourteen now go through `upstreamFetch`, default 60s, `UPSTREAM_FETCH_TIMEOUT_MS`-overridable, clamped to 1s–300s. |
| S-22 | High | **OVERSTATED, PARTLY FIXED HERE** | The claim is that partial ingest can report SUCCESS. In the paths checked it does not: `ingestStatcastHandednessFallback` and `ingestFanGraphs` both downgrade to `PARTIAL` on any rejected or quarantined row. The real defect is narrower and still real — the `catch` in the split fallback swallowed the error object entirely, so the count said how many players failed and nothing said why. It now logs per player. |
| S-23 | High | **CONFIRMED** | Schedule-source concentration. Architectural; out of scope here. |
| S-24 | High | **NOT REPRODUCED** | Requires live database access. The dates cited are recent and specific; treat as standing. |
| S-25 | Medium | **CONFIRMED** | Off-day modelling. Out of scope here. |
| S-26 | Medium | **CONFIRMED** | Handedness completeness. Audit S1 (commit `397238a`) addressed the overwrite; residual coverage gaps stand. |
| S-27 | High | **NOT REPRODUCED** | Storage policy decision. |

### Configuration and presentation

| ID | Severity | Verdict | Evidence |
|----|----------|---------|----------|
| S-28 | Medium | **CONFIRMED** | `app.ts` gates non-GET on an HMAC approval cookie under production or `REQUIRE_OPERATOR_APPROVAL=true`. Search is GET and unaffected, exactly as the report says. Working as designed. |
| S-29 | Medium | **CONFIRMED** | `startOrchestrationScheduler` returns early unless `NODE_ENV=production` or `ENABLE_ORCHESTRATION_SCHEDULER=true`. Working as designed. |
| S-30 | Medium | **CONFIRMED, FIXED HERE** | The API returned `sourceStatus` and `notices` on every response and the UI rendered neither. Both now reach the empty state, and `describeQueryError` tells apart a rejected request, a missing `/api` mount, a database-unavailable 503, and an unreachable API. |

---

## 3. Found during verification, not in the register

### 3.1 An explicit `playerId` bypassed every eligibility gate — HIGH

`labProfile` resolved the subject as `playerId ?? profileCount.rows[0]?.player_id`.
The search results pass an eligibility join — official record for the exact date,
correct role, no identity quarantine. A supplied `playerId` passed none of it.

So a link, a bookmark, or a hand-edited URL could return a hitter profile for a
pitcher, or a profile for a player held for identity review — a player the search
itself would never list. The report's prevention item 4 asks for "hitter/pitcher
role matching for explicit player IDs"; this is that, plus the eligibility and
quarantine gates it did not mention.

Fixed: a supplied id is now held to the same gate, and a rejected one is told
apart from a wrong-role one in the response.

### 3.2 The as-of comparison used UTC against an Eastern default — MEDIUM

`labProfile` decided whether the caller had back-dated the request with
`effectiveDate !== dateOnly(new Date())`, which is UTC. Every default date on the
request side comes from `currentEasternDate()`. Between 20:00 ET and midnight the
two disagree, so a plain "today" search was labelled
`NO SNAPSHOT FOR REQUESTED AS-OF DATE` and told the operator the view would not
fall forward — for the current day. Four hours a night, in the window that
matters most for a slate. Fixed by comparing against the same clock.

### 3.3 `pnpm run test:all` has 31 failing tests on `main` — HIGH

Not a search risk, but it undercuts every guarantee in the report. On a clean
checkout of `main`, `test:all` is 300 tests / 210 pass / **31 fail**; `test:unit`
is fully green. The failures are concentrated in the `phase-*-acceptance` files
and assert against source text that has since moved (for example
`AND ls.source_id = 'FANTASYPROS'`, which the lineup-source refactor replaced
with the shared precedence filter).

The failure set is byte-identical before and after this change set — verified by
diffing the two runs — so nothing here caused or fixed any of them. But
`tests/test-suite-coverage.test.ts` exists precisely because "a test that never
runs is worse than no test, because it reads as coverage". Thirty-one tests that
run and fail read the same way. They should be repaired or retired.

---

## 4. What this change set does not address

Named so they are not mistaken for closed:

- **S-20**, refresh as long synchronous work. Bounded, not restructured.
- **S-23**, FantasyPros as the only current-slate schedule source.
- **S-24**, venue and start-time completeness.
- **S-25**, off-days modelled as failed ingest.
- **S-27**, raw payload retention.
- **S-15**, response-enum strictness — diagnosis improved, contract deliberately unchanged.
- The 31 pre-existing test failures in §3.3.

## 5. Verification

- `pnpm run typecheck` — clean.
- `pnpm run test:unit` — 221/221 pass (was 197/197; +24 from `tests/search-failure-remediation.test.ts`).
- `pnpm run test:all` — 234 pass / 31 fail, against a baseline of 210 pass / 31 fail. Identical failure set.
- `pnpm --filter @workspace/api-spec run codegen` — regenerated; verified idempotent before and after the spec edit.

No live database or running API was available in this environment, so the SQL
changes are verified by review and by the shape of the query, not by execution.
