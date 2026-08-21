---
name: FantasyPros lineup state
description: Live FantasyPros lineup endpoint behavior and the source-ownership rule it implies.
---

The live FantasyPros `/mlb/lineups` response without `projected=true` can return scheduled games while the `hitters` object is empty. Treat that as no lineup evidence, never as a posted or empty official lineup.

**Why:** A source response with an empty hitter map cannot establish an official batting order. Promoting it would hide missing information and violate source ownership.

**How to apply:** Persist FantasyPros `projected=true` batting orders only as `PROJECTED`. Use the official MLB game feed as the sole writer of `POSTED`, `UPDATED`, or `SCRATCHED` lineup state.