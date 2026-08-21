# Phase 2A public research source register

This register documents the public research evidence accepted by the Phase 2A foundation. The application preserves the raw response metadata, endpoint, retrieval time, effective date range, checksum, HTTP status, row count, normalized count, actual rejection count, and source-specific definition alongside every normalized value.

| Source | Public endpoint family | Data retained | Research use | Important constraints |
| --- | --- | --- | --- | --- |
| Baseball Savant / Statcast | `https://baseballsavant.mlb.com/leaderboard/custom` with `csv=true` | MLBAM ID, season opportunity, batted-ball, expected-stat, contact, and pitcher evidence | Statcast-backed player and pitcher research panels | The public response can leave selected values blank. Blanks remain `NOT_FOUND`; they are never coerced to zero. MLBAM ID must resolve to the Phase 1C canonical player record. |
| FanGraphs | `https://www.fangraphs.com/api/leaders/major-league/data` | MLBAM bridge, batting/pitching leaderboards, plate-discipline, batted-ball, workload, and pitch-type evidence | Current season and rolling 7/14/30/60-day research snapshots; pitcher arsenal fields where supplied | Definitions are source-labeled and are not silently combined with Statcast definitions. Mixed starter/reliever rows stay `MIXED`. |
| Official MLB roster and identity state | Existing Phase 1C MLB Stats API ingestion | Canonical MLBAM identity, team/roster status, positions, throwing/batting hand | Eligibility gate for all research attachment | A research row cannot create a canonical identity. Unmatched or quarantined source rows are stored as raw evidence in the research identity quarantine. |
| Park component factors | `park_research_snapshots` / `park_research_features` storage contract | Venue, span, handedness, HR/2B/3B/XBH/TB components, source definition, provenance | Game/Park Lab context and future heuristic display | No reproducible public component endpoint is currently configured. Every unavailable factor is displayed as `NOT FOUND`; the system does not estimate a park factor or generate a matchup score. |

## Metric conventions

- Values have one of `RAW`, `NORMALIZED`, `DERIVED`, or `HEURISTIC` transformation labels.
- `XBH = doubles + triples + home runs`; singles are explicitly excluded.
- Derived values store their definition and denominator. No derived total is used as a prediction.
- Sample-bearing metrics are marked `INSUFFICIENT_SAMPLE` rather than hidden when the available sample is below the research threshold.
- A source retrieval may be `PARTIAL` because of identity quarantine while having **zero actual ingestion rejects**. These two counts are intentionally distinct.
- Player and Pitcher Labs accept an explicit as-of date. They select only snapshots valid on or before that date and report unavailable historical coverage rather than falling forward to newer evidence.

## Support matrix

| Research family | Source status |
| --- | --- |
| Hitter season evidence | Supported by Statcast and FanGraphs |
| Hitter rolling windows | Supported by FanGraphs |
| Pitcher season evidence | Supported by Statcast and FanGraphs |
| Pitcher rolling windows | Supported by FanGraphs |
| Pitch arsenal | Supported when FanGraphs exposes the pitch-type fields |
| Batter-side / pitcher-side splits | Storage is supported; public-source coverage is surfaced separately until a stable split endpoint is configured |
| Park components | Storage and UI are supported; data remains unavailable until a reproducible component source is added |
