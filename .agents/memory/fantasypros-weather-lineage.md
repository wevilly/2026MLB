---
name: FantasyPros weather lineage
description: FantasyPros projected lineup payloads carry usable per-game weather context.
---

FantasyPros projected-lineup payloads provide `weather`, `temp`, `wind`, `wind_direction`, and `chance_rain` for each game. Treat these values as the preferred pregame weather lineage when they are present, with any other weather provider clearly identified as supplemental.

**Why:** A failed secondary forecast refresh must not make a slate appear to have no weather when the lineup authority already supplied it.

**How to apply:** Preserve FantasyPros values append-only with `FANTASYPROS` source lineage and use source precedence when retrieving weather. Do not turn this source context into a FantasyPros-derived player ranking.