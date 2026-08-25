---
name: Orchestration readiness record
description: How manual research outputs relate to the authoritative slate readiness state.
---

Manual market-engine refreshes may materialize valid, auditable research rows, but they must not make a current slate operationally usable when its latest persisted orchestration run is cancelled, failed, or incomplete.

**Why:** A completed orchestrator is the only ledger that proves all required gates ran in a documented sequence. Treating rows written by individual refreshes as a successful slate would hide skipped or interrupted source checks and allow Round Robin selection from a partial workflow.

**How to apply:** Keep individual market outputs visible as research evidence. Preserve their source lineage and caveats, but keep Round Robin selection and current-date readiness blocked until a non-cancelled run completes its health gate.