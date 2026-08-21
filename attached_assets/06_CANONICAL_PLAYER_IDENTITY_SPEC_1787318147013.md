# Canonical Player Identity Specification

## Goal

One real baseball player must map to one internal canonical `player_id` regardless of how sources format the name.

## External IDs to support

At minimum:

- MLBAM / MLB Stats API
- FantasyPros
- FanGraphs
- Baseball Savant / MLBAM relationship
- Retrosheet
- Baseball-Reference when available

## Canonical tables

Recommended concepts:

- `players`
- `player_external_ids`
- `player_aliases`
- `identity_match_events`
- `identity_review_queue`

## Identity confidence

Use:

- CONFIRMED
- HIGH_CONFIDENCE
- REVIEW_REQUIRED

## Matching precedence

1. Exact stable source-ID bridge.
2. Trusted cross-reference registry.
3. Deterministic composite match using multiple attributes.
4. Manual/review workflow.

Name-only fuzzy matching must never silently create CONFIRMED identity.

## Useful deterministic attributes

When available:

- full name
- normalized name
- birth date
- current/known team
- bats/throws
- position
- MLB debut date
- source-specific stable ID

## Normalization

Normalization may assist candidate generation, but the raw source name must always be retained.

Examples of normalized differences:

- accents/diacritics
- periods in initials
- apostrophes
- hyphens
- suffix punctuation
- whitespace

## Duplicate-name safety

Two players sharing the same normalized name are not automatically the same player.

## Auditability

Every cross-source merge should be reproducible:

- source A ID
- source B ID
- evidence used
- confidence
- algorithm/version
- timestamp
- reviewer/override if manual
