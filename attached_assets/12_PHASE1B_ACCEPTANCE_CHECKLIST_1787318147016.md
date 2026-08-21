# Phase 1B Acceptance Checklist

Replit must stop after this acceptance gate. Do not auto-start Statcast/model work.

## Database/provenance

- [ ] Source registry exists.
- [ ] Ingest-run audit exists.
- [ ] Raw payload reference/checksum is retained.
- [ ] Effective date and retrieval timestamp are retained.
- [ ] Re-running ingestion is idempotent.
- [ ] Historical projection/lineup snapshots are immutable.

## Identity

- [ ] One canonical internal player identity exists.
- [ ] MLBAM IDs are stored.
- [ ] FantasyPros IDs are stored.
- [ ] Cross-source mapping has confidence state.
- [ ] Unresolved mappings create Data Health issues.
- [ ] Name normalization does not silently merge ambiguous players.

## MLB official state

- [ ] Real schedule has been ingested.
- [ ] Teams/venues/gamePk persisted.
- [ ] Probable/official starters persisted with historical observations.
- [ ] Posted lineups persisted when available.
- [ ] Projected state is not promoted to posted without authoritative evidence.

## FantasyPros

- [ ] Secret remains server-side.
- [ ] Real hitter projection snapshot stored.
- [ ] Real pitcher projection snapshot stored.
- [ ] Lineup snapshot stored if endpoint allowed.
- [ ] News/player metadata stored if endpoint allowed.
- [ ] Older snapshot remains unchanged after later refresh.
- [ ] Sanitized test fixtures exist.

## Four-market architecture

- [ ] Market enum supports TOTAL_BASES_2_PLUS.
- [ ] Market enum supports EXTRA_BASE_HIT.
- [ ] Market enum supports BATTER_WALK.
- [ ] Market enum supports HOME_RUN.
- [ ] No code assumes exactly three hitter markets.
- [ ] No fake XBH probability exists.

## Price-free core

- [ ] Price/odds are not required for research readiness.
- [ ] Price/odds do not determine statuses.
- [ ] CLV/EV do not appear as required Phase 1 metrics.
- [ ] Legacy odds tables, if retained, are optional and disconnected from core ranking logic.

## UI

- [ ] Today displays real MLB slate state.
- [ ] Projection Center displays real FantasyPros data.
- [ ] Data Health displays live source health and issue queues.
- [ ] Settings exposes only configured/not-configured secret status.
- [ ] Pre-model status is READY/PARTIAL/BLOCKED.

## Required acceptance report evidence

- [ ] Tables created/changed.
- [ ] Endpoints implemented.
- [ ] Real test-date row counts.
- [ ] Identity match rate.
- [ ] Unresolved identity count.
- [ ] Projection snapshot count.
- [ ] Lineup snapshot count.
- [ ] Duplicate/idempotency test output.
- [ ] Security test output.
- [ ] Screenshot: Today.
- [ ] Screenshot: Projection Center.
- [ ] Screenshot: Data Health.
- [ ] Screenshot: Settings.
- [ ] Failed tests and known API limitations.
- [ ] Exact recommendation for Phase 2.
