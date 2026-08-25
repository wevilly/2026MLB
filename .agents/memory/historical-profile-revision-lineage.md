---
name: Historical profile revision lineage
description: Rules for safely deriving current player intelligence from append-only event and game-context revisions.
---

Historical player profile features must select the latest source observation deterministically and include the selected shared game-context revision in their input lineage. A correction to weather, roof, schedule, or day/night context must create a new current-derived revision without rewriting the observation or feature used by a frozen pregame record.

**Why:** Event-level source corrections and game-context corrections arrive independently. Treating context as a side lookup can leave current splits tied to stale context; counting every append-only revision also overstates player coverage.

**How to apply:** Keep source facts append-only, carry upstream retrieval timing into normalized observations, and derive feature identities from the logical event plus the context revision. Use opaque keyset cursors for bounded backfills and report PARTIAL until the caller consumes all returned cursors.

For external historical loads, retain an append-only receipt for each canonical player, role, and requested season range. A retained event does not prove range coverage, and a source row must match the selected player/role before it can satisfy a coverage receipt.

**Why:** Partial seasons, unresolved opponent identities, and an ignored upstream lookup parameter can otherwise turn a small or wrong response into permanent false completeness.

**How to apply:** Choose the earliest missing range from successful receipts, preserve PARTIAL/FAILED receipts for retries, and require the normal event cursor to finish materializing the returned range before loading the next one.

Historical backfill workers must obtain a database-backed singleton lease before selecting a range and hold it through source retrieval and materialization.

**Why:** A process-local guard cannot prevent multiple API instances from duplicating an external source request and writing competing receipts for the same player/range.

**How to apply:** Use a PostgreSQL advisory lease on a dedicated connection, release it in a `finally` block, and retain append-only source receipts as the durable audit of each completed or partial attempt.

Coverage readiness is horizon-based: a stored player profile is READY only when every applicable player-role range in the configured historical horizon has both a successful receipt and matching feature lineage.

**Why:** Any-event readiness masks a player who has a valid 2024 sample but never received 2025–2026 coverage; aggregated coverage also must not compare a player filter to NULL.

**How to apply:** Return NOT FOUND for no retained evidence, PARTIAL for incomplete or partially rejected ranges, and READY only after all required ranges complete. Include completed/required range counts in the response notes.

Append-only PARTIAL receipts are historical evidence, not a permanent unresolved flag when a later successful receipt and feature lineage cover the same target range.

**Why:** Identity or source errors can resolve on retry; preserving the original PARTIAL audit record must not make READY unreachable forever.

**How to apply:** Treat a PARTIAL range as unresolved only when no qualifying SUCCESS receipt with matching derived lineage (or explicit zero-source completion) supersedes it.