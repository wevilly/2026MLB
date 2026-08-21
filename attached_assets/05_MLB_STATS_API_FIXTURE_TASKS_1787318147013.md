# MLB Stats API Live Fixture Tasks — Replit Must Perform

MLB official game state is public data. Replit should obtain current examples directly rather than waiting for manual uploads.

## Required fixture categories

Generate sanitized/live test fixtures for:

1. Schedule for one real MLB date.
2. One game/live-feed response.
3. One active roster response.
4. One player/person response.
5. One example containing probable pitchers.
6. One example containing posted lineups when available.
7. One completed-game box score for settlement testing.

Suggested directory:

`tests/fixtures/mlb_stats_api/`

## What to preserve

For each fixture preserve enough source detail to test:

- gamePk
- home and away team IDs
- venue
- game state/status
- scheduled first pitch
- probable/official pitcher identity when supplied
- lineup order when supplied
- player MLBAM IDs
- roster position/status
- completed-game batting events/stat line

## Do not over-infer

The MLB feed may not explicitly label OPENER or BULK.

If a source does not establish the role, store UNKNOWN/PROBABLE/TBD according to the actual evidence.

## Idempotency test

Run the same date/game ingest twice and prove that it does not create duplicate canonical games, teams or MLBAM player identities.
