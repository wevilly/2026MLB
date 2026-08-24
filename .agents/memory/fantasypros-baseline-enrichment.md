---
name: FantasyPros baseline enrichment
description: Rules for retaining the pregame FantasyPros baseline while optional research completes.
---

The FantasyPros daily-projection baseline is the required pregame product. Optional research may add its own ordinal rank and evidence, but must retain the original baseline rank, snapshot lineage, lineup context, and source attribution alongside it.

**Why:** Optional sources can be delayed, partial, or unavailable. Replacing the baseline makes the initial auditable source evidence disappear and prevents an operator from seeing when research changed the ordinal order.

**How to apply:** Whenever a market candidate is refreshed after the baseline, preserve baseline data as a distinct evidence layer, expose both ranks to the UI, and leave selection blocked until the separate current bullpen role-path safety gate is satisfied.