---
name: Orchestration freeze safety
description: Durable scheduling and freeze-gating rules for daily MLB orchestration.
---

Scheduled refreshes and feature freezes are operationally distinct. A run may
finish its refresh steps before the freeze cutoff, but it must remain queued
until the persisted earliest-first-pitch cutoff. Scheduled launches and freeze
execution require database advisory claims so multiple API replicas cannot
duplicate them.

**Why:** An in-process timer can fire twice across replicas or miss a cutoff
during downtime, and freezing a partial run would make incomplete data look
official and immutable.

**How to apply:** Gate feature snapshot capture on successful source ingest,
research, bullpen, all market engines, board refresh, and health checks. Keep
the run ledger pending until the cutoff, then acquire a database claim before
capturing snapshots. Recalculate the cutoff after official MLB ingest, reread
the run after acquiring the freeze claim, and fail the freeze if any individual
snapshot capture is incomplete. Treat interruption as terminal and preserve the
audit ledger with database-level UPDATE, DELETE, and TRUNCATE guards.