# Current MLB Analyst Platform Rules

**Effective:** 2026-08-20

These rules override older documents when there is a conflict.

## Product objective

Rank and explain which player-market outcomes are most likely to hit using baseball data, matchup research, lineup opportunity, bullpen state, independent external research and validated model performance.

The platform is not currently optimized around sportsbook price.

## Retired from the core decision process

Do not use any of the following to select, rank, upgrade or downgrade a player:

- sportsbook price
- American or decimal odds
- implied probability
- expected value based on price
- closing-line value
- mandatory price gates

Existing legacy database fields may remain for compatibility, but they are optional and cannot block core workflows.

## Four independent markets

### TOTAL_BASES_2_PLUS
Outcome: player records at least 2 total bases.

Two singles count. One double counts. One triple counts. One home run counts.

### EXTRA_BASE_HIT
Outcome: player records at least one double, triple or home run.

Singles do not count.

### BATTER_WALK
Outcome: player records a qualifying batter walk according to the platform's settlement definition.

Store intentional and unintentional walks separately when source data allows.

### HOME_RUN
Outcome: player hits at least one home run.

## Market separation

Never create a single hitter score and reuse it for all markets.

A hitter can be excellent for TB and weak for XBH, excellent for XBH and only moderate for HR, or excellent for walks while being weak for damage markets.

## Data-state statuses before models exist

Use only:

- READY
- PARTIAL
- BLOCKED

Do not show FIRE/HALF/HOLD/PASS/PARKED before validated market research/model engines exist.

## Future prediction-confidence statuses

Once models and research engines are validated:

- FIRE
- HALF
- HOLD
- PASS
- PARKED

These are confidence/research-completeness labels, not betting-value labels.

## Evidence labels

Every research claim should support:

- VERIFIED — checked directly from a named source/current stored record
- SOURCED — sourced logic or carried-forward data with provenance
- INFERENCE — analyst/model reasoning rather than direct measurement
- NOT FOUND — unavailable or unresolved

## Data rules

- MLB official state owns official schedule/game/starter/posted-lineup fields.
- Projected lineups are allowed and must remain PROJECTED.
- FantasyPros is a first-class forward-projection source and cross-check, not the owner of official MLB state.
- Every time-varying feed should preserve historical snapshots.
- Never overwrite morning projections with later projections.
- Uncertain identity resolution goes to Data Health.
- Missing critical data stays missing.
- Bullpen state is individual-arm based and visibly STALE when stale.

## Model rules

When the modeling phase begins:

- separate models by market
- version every model and feature set
- use time-based/walk-forward validation
- measure calibration, Brier score, log loss, ranking performance and probability buckets
- freeze pregame prediction state
- never rewrite old predictions after results

## Postmortem rules

Every miss should be classifiable as:

1. DATA FAILURE
2. OPPORTUNITY FAILURE
3. PROBABILITY FAILURE
4. NORMAL VARIANCE

Also preserve:

- WON, BAD PROCESS
- LOST, CORRECT PROCESS

## External bettor research

External bettors are evidence, not votes.

Store the bettor/source, player, market, timestamp, stated mechanism, source URL and result when available.

Deduplicate copied/syndicated opinions.

Do not use odds/price as a required bettor-intelligence field.
