# Final acceptance report

Generated: 2026-08-22T04:54:31.305Z  
API target: http://127.0.0.1:8080/api  
Overall automated gate: **CONDITIONAL PASS — RESTORE DRILL PENDING**

## Operational checks

| Check | Result | Duration |
|---|---:|---:|
| Live API health | PASS | 0.0s |
| Phase 2A live report | PASS | 0.5s |
| All phase behavioral gates | PASS | 77.4s |
| Warm read-performance SLA | PASS | 2.5s |
| Isolated restore lineage drill | PENDING | 0.0s |

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
