---
name: Bettor evaluation eligibility
description: Rules for when a bettor pick may contribute to settled performance metrics.
---

Performance evaluation must only score a pick when it maps to exactly one terminal MLB official outcome and was posted no later than that game's known first pitch. Picks with multiple eligible same-date outcomes (such as a doubleheader) or a post-first-pitch timestamp remain visible as evidence, but do not contribute to settled counts, outcome rates, base-rate deltas, or independence scores.

**Why:** Date-only pick intake cannot safely infer which leg of a doubleheader a bettor meant. Counting all matches duplicates evidence, and accepting a post-start pick allows hindsight to improve a record.

**How to apply:** Preserve the pick for operator review, but leave its official settled outcome absent until a single eligible game-level settlement can be established. Do not make an evaluator fallback choose an arbitrary game.