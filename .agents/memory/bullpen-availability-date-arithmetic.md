---
name: Bullpen availability date arithmetic
description: Safe handling of availability integer fields and rest-day offsets during bullpen refreshes.
---

Calculate rest-day offsets from persisted MLB game dates in PostgreSQL, and only write finite integer values to integer availability columns.

**Why:** Runtime parsing of database date-like values can yield `NaN`, which aborts the full slate orchestration at the bullpen step even when the official game-feed data is valid.

**How to apply:** Keep date-difference arithmetic in the availability query where possible, and validate derived pitch-count and rest-day values at the service boundary before inserting or updating bullpen observations.