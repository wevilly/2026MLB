# MLB Analyst operator runbook

## Operating model

The MLB Analyst Platform is the official operational record. `slate.json` and
the Excel-compatible workbook are read-only derived exports and must never be
used to overwrite platform data.

All production write actions require a short-lived operator approval session.
Open **AI analyst**, unlock review with the workspace-managed operator
capability, then perform operational writes. The session uses a secure,
HTTP-only cookie and expires after 15 minutes.

## Daily operations

### Before the 08:00 Eastern refresh

1. Open **Data Health** and confirm the API health response is healthy, the
   correct slate date is selected, and the preceding slate's settlement queue
   is clear. Treat `BLOCKED`, `PARTIAL`, `NOT RUN`, identity gaps, or
   `phase2aReady: false` as a stop-and-investigate signal.
2. At 08:00 America/New_York, verify **Orchestration** shows the configured
   schedule policy and a new ledger row. A manual recovery run uses
   `POST /api/analyst/orchestration/run?date=YYYY-MM-DD`; it returns `202` and
   must be followed in the run ledger rather than assumed complete.
3. Confirm that MLB schedule/starters, research coverage, bullpen, and all four
   research engines complete in the ledger. The market board is usable only
   with its displayed research/lineup state; it is never a silent fallback.
4. Before the earliest first pitch, confirm the planned freeze time is **90
   minutes before that pitch**. After freeze, use **Scan late scratches**
   (`POST /api/analyst/orchestration/late-scratches?date=YYYY-MM-DD`) when
   lineup evidence changes. It creates immutable corrections and does not
   rewrite frozen snapshots.

### Day-one decision path

- **Fresh and complete:** review board context, then retain the ledger and
  audit evidence for the slate.
- **Source failure or stale badge:** follow [Stale source badges](#stale-source-badges);
  do not substitute invented values or bypass the eligibility gate.
- **Active run is unsafe:** use **Interrupt** for that run only. The current
  atomic action is recorded, later steps are cancelled, and a new run—not an
  edited historic row—must be started once the issue is resolved.

## Bullpen availability and overrides

The Bullpen Room displays the persisted heuristic state, usage history,
confidence, and any existing manager annotation. Manager confirmation always
outranks the heuristic in the read model.

**Current limitation:** this release has no authenticated write endpoint or UI
control for recording a new manager/beat-reporter override. Do not modify the
database or backdate an ingest record to simulate one. Record the confirmation
in the incident/change log, keep the board's existing state visible, and use a
new audited override feature once it is delivered. This protects the
append-only availability history and keeps the platform honest about what is
operator-entered versus source-observed.

## AI draft review

1. Open **AI Analyst** and unlock the short-lived operator review session.
2. Review the draft's sourcing-register claims one by one. Check source,
   retrieval context, and whether the claim is supported by the platform's
   current evidence.
3. Approve or reject each claim in the review queue, then approve the draft
   only if every required claim is accepted and the narrative remains within
   the supported evidence. Rejection leaves the draft and its audit lineage
   available for review; it is not deleted.
4. Approved research notes are human decisions. AI tools remain read-only for
   platform records and must never settle games, publish market rows, change
   models, or bypass operator approval.

## Model training, validation, and activation

1. Train a market-specific candidate with
   `POST /api/analyst/models/train?market=TB|XBH|WALK|HR`.
2. Run chronological validation with
   `POST /api/analyst/models/validate?modelVersionId=...`, then inspect
   `GET /api/analyst/models/validation`. A valid acceptance needs a `PASS`,
   at least two chronological folds, benchmark improvement, and calibration
   success.
3. Reconfirm the matching model version and acceptance ID through
   `GET /api/analyst/models`; retain both identifiers in the release record.
4. **Current limitation:** validation creates a calibrated `CANDIDATE`; this
   release intentionally has no controlled activation endpoint. Do not set
   `ACTIVE` directly in the database. The market board must remain
   `NONE`/`RESEARCH_ONLY` until a separately reviewed activation mechanism is
   available.

## Post-game settlement and exports

1. After MLB marks games final, use the normal date-level operation:
   `POST /api/analyst/settlements/automate?date=YYYY-MM-DD`. It uses official
   MLB outcomes, keeps incomplete work retryable, and creates missing
   postmortems.
2. For a targeted official-game retry, use
   `POST /api/analyst/settlements/{gamePk}` only after confirming the correct
   game ID and final status. Never settle from a third-party recap or manually
   alter an outcome.
3. Review `GET /api/analyst/settlements` and
   `GET /api/analyst/postmortems` before releasing any export.
4. Export only after verification:
   `GET /api/analyst/export/slate-json?date=YYYY-MM-DD` and
   `GET /api/analyst/export/workbook?date=YYYY-MM-DD`. Confirm the requested
   date and save the returned file with its slate date. These are read-only,
   derived outputs; the platform remains the official record.

## Incident response and recovery

### Stale or failed source

1. Locate the failing step in **Orchestration** and read its saved detail and
   request ID. Then inspect **Data Health** for source status, last attempt,
   normalized/rejected counts, HTTP status, and identity coverage.
2. Interpret badges precisely:
   - `FRESH` means the most recent source run succeeded.
   - `PARTIAL` means usable source evidence is incomplete; review the retained
     error and affected coverage before proceeding.
   - `BLOCKED` means the source did not provide usable evidence; do not treat
     it as a zero-valued statistical input.
   - `NOT RUN` means no ingest completed. `NOT CONFIGURED` means a credential
     or optional provider is absent; this is not a successful refresh.
3. For MLB Official, correct schedule/starter availability and rerun the slate.
   For FantasyPros, a projected lineup with no official lineup can legitimately
   remain partial; only MLB establishes a posted lineup. For FanGraphs, an
   explicit blocked state is visible and does not hide missing research
   coverage. For Statcast or Park Factors, require the relevant coverage gate
   to pass before treating the board as complete.
4. Resolve the upstream availability or identity issue, then start a **new**
   operator run. Do not edit historical run rows, raw evidence, or badges.
   Preserve the request ID and resolution in the incident record.

### Safe interruption

Use **Interrupt** only for a currently running slate sequence. The runner
finishes the current atomic action where possible, records cancellation, and
leaves subsequent steps as unexecuted/cancelled. Start a new run rather than
editing the old one.

### Database backup and restore drill

**Recovery targets:** retain daily backups for 30 days, restore the most recent
backup with an RPO of 24 hours, and complete the initial verified restore
assessment within four hours. Keep backup access restricted to deployment
operators and encrypt backups at rest in the managed backup provider.

1. Declare an incident and stop nonessential writes. Record the last known
   good backup, incident start time, desired RPO (24 hours), and desired
   initial assessment RTO (four hours).
2. Take a managed PostgreSQL backup before schema changes and record its
   timestamp, retention expiry, and the target RPO/RTO in the change log.
3. Restore only into a **populated, non-production** database first. Set
   `RESTORE_DATABASE_URL` to that isolated target. The verifier rejects a
   missing target and rejects the active `DATABASE_URL`.
4. Run `pnpm verify:restore-drill`. It requires non-empty orchestration,
   frozen snapshot, official outcome, postmortem, and audit records and checks
   snapshot→outcome plus postmortem→snapshot/outcome relationships.
5. Against the isolated target, run read-only health, market-board,
   feature-store, settlement, and export checks. Record command output, data
   counts, and elapsed restore time. Only then make a separately approved
   production recovery decision.
6. Redeploy the approved application version and its managed configuration
   through the deployment controls; do not copy secrets into tickets or chat.
   Verify health, read models, and audit history after cutover.
7. Never delete immutable records to resolve a restore discrepancy; create a
   documented correction or restore the proper backup instead.

### Read-performance verification

Run `pnpm test:load` against a warm API service before a production release.
It applies concurrent traffic to the health, slate, bullpen, market board, and
game-summary reads and fails if any endpoint reaches a p95 of 500 ms. Override
`API_BASE_URL`, `LOAD_TEST_REQUESTS`, or `LOAD_TEST_CONCURRENCY` only when
recording the reason and environment in the release log.

### Final acceptance release check

Run `pnpm accept:live` with the API workflow running. It checks live health,
regenerates the Phase 2A evidence report, runs every phase's behavioral gates,
runs the warmed read SLA check, and writes `docs/final-acceptance-report.md`.
Set `RESTORE_DATABASE_URL` only for an isolated restored database to include
the restore drill. A `PENDING` restore row is a required follow-up operational
action, not evidence of a passed drill.

## Known limitations

### Current operational constraints

- Schedule-triggered runs use the current process scheduler; deployment
  operators must ensure the API service remains continuously available.
- The compatibility workbook is Excel XML (`.xls`) rather than a native
  `.xlsx` package, so it stays dependency-light while remaining Excel-openable.
- Individual named operator identities are future scope; the current
  production approval capability records an operator-controlled system role.
- FanGraphs may return HTML instead of its expected data response. The failure
  is surfaced; verified Statcast split coverage can satisfy Phase 2A, but
  FanGraphs-dependent rolling and arsenal research remains unavailable.
- FantasyPros can remain `PARTIAL` before official lineups post. It does not
  establish official lineup state.
- A safe isolated restore drill requires a populated restore target supplied
  by deployment operations; this cannot be run against the active database.
- There is no operator write flow for a new bullpen manager override and no
  controlled model-activation endpoint. Both remain intentionally unavailable
  rather than permitting direct database mutation.

### Unresolved planning questions and recommended path

| Area | Open decision | Recommended next step |
|---|---|---|
| Bullpen | Fixed versus configurable heuristics; exact stale window; manual versus assisted manager confirmations | Define ownership, freshness threshold, and an audited human-confirmed override workflow. |
| Market research | Ordinal ranking versus uncalibrated score; tie policy; minimum sample rules | Keep ordinal transparent evidence until a written sample/tie policy is approved. |
| Modeling | Training seasons, 2026 eligibility, and benchmark to beat | Approve a data-horizon policy and market-specific benchmark before exposing activation. |
| Confidence | FIRE cap and HOLD semantics | Publish stable label definitions before any model becomes active. |
| Bettor intelligence | Priority sources, text retention, and account/person identity | Approve retention and identity policy before broad source expansion. |
| AI | Direct draft creation and allowed database writes | Maintain read-only platform access; permit only human-reviewed drafts if policy approves. |
| Automation | Intraday refresh cadence, final freeze, and late-scratch response | Convert the 08:00/90-minute baseline into an incident-tested schedule policy. |
| Exports | Seven-sheet workbook evolution and platform-of-record boundary | Keep exports derived/read-only; version any workbook specification change. |
| UX | Standalone Park Lab and provenance presentation | Validate with operators before adding navigation or source-detail UI. |