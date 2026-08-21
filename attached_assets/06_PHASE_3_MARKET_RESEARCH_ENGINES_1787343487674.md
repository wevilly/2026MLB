# Phase 3 - Four Independent Market Research Engines

## Objective

Build transparent research/ranking engines before probability models. Each engine should identify candidates, mechanisms, counter-evidence, opportunity, and data quality without pretending to know a calibrated probability yet.

## Shared output contract

For each player-market candidate store:
- slate date
- game ID
- player ID
- market
- research rank
- opportunity evidence
- starter matchup evidence
- bullpen-path evidence
- park evidence
- recent-vs-season-vs-career context
- primary mechanism
- secondary mechanism
- counter-evidence
- missing/stale evidence
- source provenance
- research state: STRONG / POSITIVE / NEUTRAL / NEGATIVE / BLOCKED

Do not map these directly to FIRE/HALF/HOLD yet.

## 3A - Total Bases Research Engine

Primary mechanisms:
CONTACT_VOLUME
POWER_ROUTE
MULTI_PATH

Feature families:
- lineup slot / PA opportunity
- hit probability proxies
- contact, K, BIP, xBA
- SLG/xSLG/ISO
- doubles and HR support
- pitcher xSLG allowed by side
- pitcher K/contact profile
- arsenal matchup
- starter workload
- available bullpen contact profile
- TB park heuristic as context only

Required counter-evidence:
- high pitcher K/whiff
- likely low PA
- platoon risk
- strong available relief path
- insufficient pitch-type sample

## 3B - Extra Base Hit Research Engine

Primary mechanisms:
DOUBLE_ROUTE
TRIPLE_ROUTE
HOME_RUN_ROUTE
MULTI_PATH

Feature families:
- 2B/PA, 3B/PA, HR/PA, XBH/PA
- XBH share of hits
- LD/deep-line-drive profile
- hard-hit, 90th EV, barrel, sweet spot
- directional damage
- sprint speed for triples
- pitcher XBH/BF and XBH/BIP by side
- pitch-type damage matchup
- doubles/triples/HR park components independently
- bullpen XBH path

No final XBH park formula in this phase.

## 3C - Walk Research Engine

Primary mechanisms:
PATIENCE_VS_COMMAND
COUNT_CREATION
BULLPEN_WALK_PATH

Feature families:
- hitter BB/uBB, chase, zone-swing, first-pitch swing, pitches/PA
- pitcher BB/uBB, zone, F-strike, chase generated, pitches/BF
- batter/pitcher side splits
- umpire when available
- starter workload
- available bullpen command profile

Do not use power as a substitute for plate discipline.

## 3D - Home Run Research Engine

Primary mechanisms:
PULL_AIR
BARREL_POWER
PITCH_SHAPE_MISMATCH
PARK_ENVIRONMENT

Feature families:
- barrel/PA, rolling barrels
- 90th EV / max EV
- pull-air / pulled fly balls
- launch distribution
- supported HR/FB
- pitcher barrel, HH, FB, HR/BF by side
- pitch-type/location vulnerability
- HR park factor
- weather direction when configured
- available bullpen HR path

## Ranking rule

RANK, DO NOT GATE.

Avoid hard thresholds that imply a .432 and .428 are categorically different. Thresholds may flag data quality, not create fake baseball discontinuities.

## Acceptance gate

Each market must produce distinct rankings on historical/current research examples and explain why the same hitter can rank differently across TB, XBH, Walk, and HR.
