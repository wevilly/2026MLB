# Phase 2B - Bullpen Research and Availability Foundation

## Objective

Move bullpen memory from workbook-only logic into persistent platform state without losing the append-only ledger philosophy.

## Core data entities

### Reliever profile
- canonical player ID
- team / organization
- throws
- active roster state
- role: closer, primary setup, setup, middle, lefty specialist, long man, opener, swing
- role effective date
- role source
- season/current research metrics
- handedness splits
- arsenal and velocity trend

### Relief appearance log
Append-only.

Store:
- game ID
- date
- team
- pitcher
- opponent
- inning entered
- outs recorded / IP
- pitches
- batters faced
- hits
- walks
- strikeouts
- runs
- back-to-back flag
- days rest before appearance
- leverage if obtainable
- source

### Role change log
Append-only.

Store closer/setup promotions, demotions, option/call-up, IL, trade, opener usage, swing-role changes, and manager/beat-reporter overrides.

### Availability observation
Per reliever, per slate date:
- D-1 pitch count
- D-2 pitch count
- D-3 pitch count
- consecutive days used
- multi-inning flag
- days since last use
- heuristic availability
- manager override
- final state
- confidence
- source freshness

States:
AVAILABLE
LIKELY_AVAILABLE
DOUBTFUL
OUT
UNKNOWN
STALE

## Authority rules

Manager/club statement of unavailability outranks heuristic availability.

Heuristic availability must be clearly labeled HEURISTIC.

No team bullpen ERA may serve as the primary bullpen feature.

## Leverage map

For every team maintain:
- projected 9th
- projected 8th
- projected 7th
- highest-leverage lefty
- long man
- highest-walk reliever likely available
- lowest-walk reliever likely available
- role uncertainty

## Expected hitter-path preparation

Do not predict yet, but create a deterministic research view that can answer:
- if the starter exits after 5, which available arms are most likely to cover 6-9?
- what handedness is the likely relief sequence?
- which lineup slots are most likely to encounter each arm?

## Bullpen Room UI

Required:
- all 30 teams
- availability board
- D-1/D-2/D-3 usage
- role and role-change history
- individual-arm research panel
- projected leverage sequence
- stale badge
- override/source note
- current team coverage percentage

## Persistence compatibility

The existing Bullpen Ledger remains importable/exportable during transition. The database becomes operational truth only after reconciliation tests show parity with the workbook logic.

## Tests

- three straight days -> OUT heuristic
- two straight -> DOUBTFUL heuristic
- 35+ yesterday -> DOUBTFUL heuristic
- multi-inning yesterday -> DOUBTFUL/OUT heuristic according to rule configuration
- manager override wins
- usage log is append-only
- role changes do not rewrite prior role history
- stale ledger/source yields STALE
- bullpen metrics filter unavailable arms when building later market blocks

## Acceptance gate

Do not proceed until all 30 clubs have usable current bullpen state or explicit STALE/UNKNOWN states with source freshness.
