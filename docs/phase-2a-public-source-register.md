# Phase 2A public research source register

This register documents the public research evidence accepted by the Phase 2A foundation. The application preserves the raw response metadata, endpoint, retrieval time, effective date range, checksum, HTTP status, row count, normalized count, actual rejection count, and source-specific definition alongside every normalized value.

| Source | Public endpoint family | Data retained | Research use | Important constraints |
| --- | --- | --- | --- | --- |
| Baseball Savant / Statcast | `https://baseballsavant.mlb.com/leaderboard/custom` with `csv=true` | MLBAM ID, season opportunity, batted-ball, expected-stat, contact, and pitcher evidence | Statcast-backed player and pitcher research panels | The public response can leave selected values blank. Blanks remain `NOT_FOUND`; they are never coerced to zero. MLBAM ID must resolve to the Phase 1C canonical player record. |
| FanGraphs | `https://www.fangraphs.com/api/leaders/major-league/data` and POST `https://www.fangraphs.com/api/leaders/splits/data` | MLBAM bridge, batting/pitching leaderboards, explicit opponent-handedness splits, plate-discipline, batted-ball, workload, and pitch-type evidence | Current season and rolling 7/14/30/60-day research snapshots; season vs-LHP/RHP hitter panels and vs-LHB/RHB pitcher cross-check panels | Split POST scope retains `position` (`B` or `P`), `statType=player`, and split ID: hitter `1/2` = vs LHP/RHP, pitcher `5/6` = vs LHB/RHB. A player’s own hand is never substituted for opponent-side evidence. |
| Official MLB roster and identity state | Existing Phase 1C MLB Stats API ingestion | Canonical MLBAM identity, team/roster status, positions, throwing/batting hand | Eligibility gate for all research attachment | A research row cannot create a canonical identity. Unmatched or quarantined source rows are stored as raw evidence in the research identity quarantine. |
| Baseball Savant Statcast Park Factors | `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors` | Venue, exposed year/span, batter-side field, and raw 1B/2B/3B/HR/hits Park component factors | Game/Park Lab context | Server-rendered public data is retained as a raw payload with parser provenance. If the page blocks or changes shape, that ingest run fails visibly and Game Lab shows `NOT FOUND`; no factor, XBH composite, or matchup score is estimated. |

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
| Hitter vs LHP/RHP | Currently unavailable: the public FanGraphs split endpoint returns HTTP 500 in the implementation environment. The refresh response is `PARTIAL`, source error metadata is preserved, and missing split coverage remains visible. |
| Pitcher vs LHB/RHB | Currently unavailable for the same public FanGraphs failure. The storage contract and explicit split request are ready; no pitcher hand is used as a substitute. |
| Park components | Supported by Baseball Savant Statcast Park Factors when the source's server-rendered data is available; source failure remains visible |
