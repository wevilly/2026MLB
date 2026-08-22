# Final acceptance report

Generated: 2026-08-22T10:24:33.546Z  
API target: http://127.0.0.1:8080/api  
Overall automated gate: **FAIL**

## Operational checks

| Check | Result | Duration |
|---|---:|---:|
| Live API health | PASS | 0.0s |
| Phase 2A live report | PASS | 3.6s |
| All phase behavioral gates | PASS | 48.6s |
| Warm read-performance SLA | PASS | 2.2s |
| Isolated restore lineage drill | FAIL | 0.5s |

Security scan status: **PASS**. Security scanning is run through the workspace security scanner and is recorded alongside this report rather than by this script.

## Phase-gate coverage

| Gate | Result | Evidence |
|---|---:|---|
| 2A identity and research foundation | PASS | `test:all`, `report:phase-2a` |
| 2B bullpen availability | PASS | `test:all` |
| 3 / 3A–3D four independent research engines | PASS | `test:all` |
| 4A feature integrity / 4B official settlement | PASS | `test:all` |
| 5A model artifacts / 5B walk-forward validation | PASS | `test:all` |
| 6 confidence board | PASS | `test:all` |
| 7A–7B bettor lineage and evaluation | PASS | `test:all` |
| 8A–8B AI constraints and human review | PASS | `test:all` |
| 9A orchestration / 9B settlement and exports | PASS | `test:all` |
| 10 hardening, cache, audit, restore contract | PASS | `test:all`, `test:load`, restore drill row above |

## Acceptance interpretation

The aggregate behavioral suite is the authoritative phase gate because it runs every existing phase acceptance test against the configured live database and API. A **PENDING** isolated restore drill is not treated as a pass: complete it only against a populated, non-production restored database and retain the output with this report. See the operator runbook for operational procedures and known limitations.

## Failure or pending details

- **Isolated restore lineage drill:** Error: Restore validation failed; required records are empty: pregameFeatureSnapshots, historicalOutcomes, marketPostmortems at validateRestoreSummary (file:///home/runner/workspace/lib/db/scripts/restore-verification.mjs:11:11) at file:///home/runner/workspace/lib/db/scripts/verify-restore-drill.mjs:33:30 at process.processTicksAndRejections (node:internal/process/task_queues:103:5) Node.js v24.13.0 ELIFECYCLE  Command failed with exit code 1.
