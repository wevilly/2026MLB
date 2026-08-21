# Historical Data Manifest and Supersession Rules

## Purpose

The historical files are included to teach the platform:

- schema ideas
- provenance
- research mechanisms
- blocking failures
- lineup/starter handling
- postmortem classifications
- calibration discipline
- mistakes that should not recur

They are not equal-priority current instructions.

## Current direction always wins

If a historical file says a pick requires sportsbook price, price edge, EV, CLV or a price gate, that rule is **SUPERSEDED**.

If a historical file assumes only TB/Walk/HR, the current architecture adds XBH as a fourth independent market.

If a historical file uses an older algorithm, treat its outputs as historical evidence only.

## Files physically included in this pack

### `legacy_historical/10.txt`
August 10 postmortem/regrade material.

Useful for:
- structural pair validation
- correlation-sample caution
- anchor-shift correction
- walk-handedness completeness
- calibration discipline

Ignore as current rule:
- price/SGP/EV requirements

### `legacy_historical/11 Card Build.txt`
August 11 audit/settlement lessons.

Useful for:
- sample confidence on pitchers
- lineup rescrub necessity
- preserving confidence layers
- both-starter/both-lineup research
- avoiding tiny-sample correlation overreaction

Ignore as current rule:
- price-related sleeper/pair conclusions

### `legacy_historical/MLB Walk Prediction Model.txt`
Historical walk-model design reference.

Useful for:
- walk-specific features
- market separation
- command/discipline research ideas

Current walk rules in `02_CURRENT_PROJECT_RULES.md` override any conflict.

### `legacy_historical/File Upload Process.txt`
Historical workflow/process reference.

Use only for operational ideas that do not conflict with the current architecture.

## Historical artifacts represented in the structured seed

`09_HISTORICAL_RESEARCH_SEED.json` contains a compact structured summary of additional recent slates and postmortems that may not be physically present in this handoff directory.

It is intentionally enough for the current data-foundation phase. Raw historical workbooks can be imported later for settlement/model backtesting, but Replit should not block Phase 1B waiting for them.

## Historical status

Historical outcome files are **evidence**, not training labels for a model until:

- the exact pregame prediction is frozen and identified
- the player identity is resolved
- the market settlement definition is known
- void/scratch handling is clear
- the data timestamp is known

Do not silently convert old notes into supervised training rows.
