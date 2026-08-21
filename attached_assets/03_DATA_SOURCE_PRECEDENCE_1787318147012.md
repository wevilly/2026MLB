# Data Source Ownership and Precedence

## Principle

Every field has an owner. Cross-check sources can disagree, but they do not silently replace the owner.

## Official MLB state

**Owner:** MLB Stats API / official MLB game feeds

Owns:
- game ID
- date and scheduled start
- home/away teams
- venue
- official game status
- official posted lineups
- official/announced starting pitchers when present
- official box-score/game-feed settlement

If another source disagrees with an official posted lineup or official starter state, record the conflict and keep MLB as the canonical official-state value.

## Forward projections

**Primary external source:** FantasyPros API

Use for:
- hitter daily projections
- pitcher daily projections
- projected lineup evidence
- player/news metadata
- intraday projection movement

FantasyPros does not overwrite official MLB state.

## Underlying contact/pitch skill — later phase

**Primary:** Baseball Savant / Statcast

Use for:
- xSLG / xwOBA
- barrel and hard-hit data
- EV and launch-angle information
- pitch usage/results
- velocity/movement/release
- location/zone information
- batter and pitcher handedness interactions

## Season/split and plate-discipline context — later phase

**Primary:** FanGraphs where available; official MLB definitions as needed.

## Historical identity

**Primary bootstrap:** Chadwick Register and deterministic source IDs.

Never let fuzzy name matching silently become canonical identity.

## Historical play-by-play

**Primary:** Retrosheet/Chadwick plus official data.

## Bullpen state

The platform's append-only bullpen usage and role history becomes the system of record after ingestion.

External sources provide evidence for roles, usage and manager overrides.

## User-supplied research

User uploads are immutable evidence. Preserve file name, hash, upload timestamp, effective date and tags.

## Legacy sportsbook fields

Any old odds/price tables are OPTIONAL legacy compatibility only.

They do not own prediction confidence and do not block a player from being researched or ranked.
