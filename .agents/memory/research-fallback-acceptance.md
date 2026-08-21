---
name: Research fallback acceptance
description: When Phase 2A can accept an unavailable preferred research source.
---

FanGraphs is preferred for handedness splits but is not required for Phase 2A acceptance when MLBAM-verified Statcast Search produces both opponent-hand panels for every matchup-relevant player and raw Baseball Savant Park Factors are persisted for all requested batter sides.

**Why:** Public FanGraphs endpoints can return HTML rather than the documented data response. Treating that source outage as a global research failure hides valid, independently verifiable source evidence.

**How to apply:** Keep the FanGraphs outage visible at source level. Determine Phase 2A readiness from a successful same-day Statcast Search split run, complete projected-hitter/current-starter coverage, explicit insufficient-sample states where appropriate, and persisted All/L/R raw park components for every current-game venue. Never substitute the player's own handedness for opponent-side evidence.