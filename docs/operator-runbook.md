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

1. Open **Orchestration** and select the slate date.
2. Confirm the schedule policy: regular refresh begins at 08:00 Eastern and
   feature snapshots freeze 90 minutes before the earliest scheduled first
   pitch.
3. Start **Run slate** if an operator run is needed. Watch every step in the
   run ledger; failed steps retain their error detail for follow-up.
4. Review **Data health** before relying on a market board. Treat source
   freshness, identity gaps, and research coverage warnings as operational
   issues, not silent fallbacks.
5. Use **Scan late scratches** after the freeze when a lineup changes. The
   service creates immutable `LATE_SCRATCH` correction records and refreshes
   the affected board context; it never overwrites frozen snapshots.

## Post-game settlement and exports

1. After games are final, run the official settlement automation for the
   slate date using `POST /api/analyst/settlements/automate?date=YYYY-MM-DD`.
   It only uses MLB official results and creates any missing postmortems.
2. Download `slate.json` or the workbook from **Orchestration**. The workbook
   has a readme, games, TB, XBH, WALK, HR, and research-state sheets.
3. Confirm settlement/postmortem outcomes in the platform before sharing an
   export.

## Overrides and review

- Bullpen availability overrides must remain operator-authenticated and be
  documented through the resulting audit event.
- AI drafts are not official research. Review their sourced claims, approve or
  reject each claim, then approve a draft only when the supporting evidence is
  acceptable.
- Model activation remains gated by the existing walk-forward acceptance
  lifecycle; never use an export to infer model status.

## Incident response and recovery

### Stale or failed source

1. Locate the failing step in **Orchestration** and read its saved detail.
2. Review **Data health** for the matching source, freshness state, and
   identity coverage.
3. Resolve the upstream availability/identity issue, then start a new
   operator run. Do not edit historical run rows.

### Safe interruption

Use **Interrupt** only for a currently running slate sequence. The runner
finishes the current atomic action where possible, records cancellation, and
leaves subsequent steps as unexecuted/cancelled. Start a new run rather than
editing the old one.

### Database backup and restore drill

1. Take a managed PostgreSQL backup before schema changes and record the
   timestamp in the change log.
2. Restore only into a non-production database first.
3. Verify `orchestration_runs`, frozen snapshots, historical outcomes,
   market postmortems, and audit events are present and internally linked.
4. Run read-only health, market-board, feature-store, settlement, and export
   checks before considering a production restore.
5. Never delete immutable records to resolve a restore discrepancy; create a
   documented correction or restore the proper backup instead.

## Known limitations

- Schedule-triggered runs use the current process scheduler; deployment
  operators should ensure the API service remains continuously available.
- The compatibility workbook is Excel XML (`.xls`) rather than a native
  `.xlsx` package, so it stays dependency-light while remaining Excel-openable.
- Individual named operator identities are future scope; the current
  production approval capability records an operator-controlled system role.