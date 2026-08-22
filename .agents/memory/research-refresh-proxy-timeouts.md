---
name: Research refresh proxy timeouts
description: Long synchronous research refreshes can outlive proxied requests and degrade concurrent operational reads.
---

Do not launch duplicate synchronous full-universe research refreshes through the proxied API. A request can be aborted by the proxy while its server work continues, leaving active ingest records and enough concurrent work to delay Data Health reads.

**Why:** Raw-response retention and per-player Statcast split collection make the complete universe substantially longer than the interactive proxy window.

**How to apply:** Prefer the existing orchestration/background path for full-universe work, keep refresh initiation single-flight, and do not report readiness until persisted ingest runs finalize and date-scoped coverage passes.