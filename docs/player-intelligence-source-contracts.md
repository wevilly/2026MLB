# Player intelligence source contracts

## Purpose

The player intelligence layer keeps source facts, derived profile values, and analyst interpretation distinct. A missing source is a visible coverage state, never a zero or a substitute signal.

## Ownership and boundaries

| Source | Owned fields and use | Acquisition and freshness | Failure behavior |
| --- | --- | --- | --- |
| MLB official game feeds | Official game identity, schedule, venue, status, posted lineups, starters, and settlement | Existing official ingest and postgame settlement refresh | Official fields remain unavailable or stale. FantasyPros never overwrites them. |
| FantasyPros | Expected daily player universe, projected lineup/order, supplied starter context, reference projections | Daily pregame ingest | The slate reports its actual readiness. FantasyPros values remain reference-only and never rank an independent market. |
| Baseball Savant / Statcast | Canonical-ID pitch and batted-ball observations, pitch shape, contact quality, and player skill features where retained | Documented public Statcast Search CSV, bounded canonical-ID source loads, and retained raw-payload references | A source-range receipt records completion or PARTIAL/FAILED status for each player, role, and requested range. Unknown IDs are rejected visibly; the system never claims complete history from event existence alone. |
| FanGraphs | Definition-labeled season, split, and plate-discipline enrichment where available | Public derived enrichment | An unavailable request leaves a provenance-backed missing state. It is not described as an official API. |
| Ballpark Pal | Supplemental structured context only after a documented field is verified against the configured server-side connection | Pending documented capability verification | No undocumented field is read or inferred. Credentials are never sent to the client or stored in provenance. |
| Retrosheet / Chadwick | Historical identity and play-by-play bootstrap when a deterministic source ID is available | Future bounded import | Ambiguous records enter identity quarantine. Names alone never become a canonical join. |
| Weather and park research | Shared game environment, wind relative to home plate, roof state, and component park context | Append-only weather observations and research snapshots | Missing weather and park enrichment remain a stated limitation. They do not become a ranking gate or a fake neutral value. |
| Bullpen foundation | Individual-arm history, role and current availability ledger | Existing availability refresh and append-only usage records | Current availability stays separate from permanent player skill. Stale or unknown availability is visible. |

## Historical materialization contract

`POST /analyst/refresh/historical-intelligence` is intentionally bounded to the configured 2024-2026 seed horizon. The API service also starts a resumable background worker: each five-minute step claims the earliest canonical player, role, and season range not yet backed by derived-profile lineage, loads one documented Statcast Search CSV response, and consumes that target's event cursor before advancing. A restart retries source-loaded ranges that lack derived profile lineage. The manual endpoint remains bounded for operator diagnostics; profile views do not trigger ingestion.

1. appends shared game context records;
2. appends normalized player observations linked to raw payload lineage;
3. derives denominator-aware hitter and pitcher features for season and rolling windows; and
4. reports READY, PARTIAL, or NOT FOUND coverage without joining by player name.

Every source-range receipt retains the requested bounds, source response status, raw-payload reference, and ingest run. A row within a range is never treated as proof that the whole range is covered. Empty source responses complete explicitly; malformed or unresolved canonical source rows retain PARTIAL receipts and retry safely without blocking the rest of the universe.

It is not in the daily orchestration critical path. The daily workflow reads what is already available and does not wait for a historical rebuild.

## Point-in-time and interpretation rules

- Historical source facts, contexts, observations, and derived intelligence features are append-only.
- A later source correction is a new revision. Frozen pregame records continue to reference their original inputs.
- Split dimensions, numerators, denominators, sample sizes, transformation version, and source-input counts are persisted with each derived feature.
- Day/night and handedness splits are descriptive context with sample caveats, not causal proof or a stand-alone selection gate.
- Market engines remain independent. This source layer does not produce a universal hitter score, probabilities, odds, prices, EV, CLV, or selections.