---
name: Daily research source contract
description: Boundaries for active daily research data and retired-source audit evidence.
---

Use Ballpark Pal only for same-day simulated counting-stat averages and game-level park multipliers. Do not call its probability, odds-like, matchup, fantasy, pitch-level, or historical-projection endpoints; filter those field families before raw-payload retention. Statcast and FanGraphs records are immutable legacy audit evidence and cannot affect active daily ranks.

**Why:** Public direct retrieval was too unreliable for daily operations, and richer provider fields would violate the research-only product boundary.

**How to apply:** Assess daily research freshness and coverage through same-day Ballpark Pal runs. Explicitly mark BvP, arsenal, expected-stat, and handedness evidence unavailable rather than synthesizing replacements or reading stale legacy snapshots. Historical refreshes must not issue new direct-source requests.