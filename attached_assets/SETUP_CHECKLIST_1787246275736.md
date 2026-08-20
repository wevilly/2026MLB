# Replit Setup Checklist

## Before Replit builds anything

- [ ] Create a fresh Replit app for the MLB Analyst Platform.
- [ ] Upload every file/folder from this v2 pack.
- [ ] Add/attach Replit Database so `DATABASE_URL` is available.
- [ ] Open Replit Secrets and add `FANTASYPROS_API_KEY` with the real value.
- [ ] If available, add `OPENAI_API_KEY`. If not, leave live AI disabled; Phase 1 does not require live AI.
- [ ] Add optional odds/weather credentials only if available.
- [ ] Do not paste secret values into Agent prompts, source files or frontend settings.

## Start the build

- [ ] Open `REPLIT_MASTER_PROMPT.md`.
- [ ] Paste it into Replit Agent in Plan mode.
- [ ] Require Agent to inspect `mockups/` and `UI_UX_SPEC.md` before proposing UI architecture.
- [ ] Review the plan before Agent begins coding.
- [ ] Tell Agent to build Phase 1 only.

## Phase 1 must include

- [ ] database migrations
- [ ] MLB official schedule/game/player/starter ingestion
- [ ] FantasyPros daily hitter/pitcher projection snapshots
- [ ] FantasyPros lineup snapshots
- [ ] FantasyPros news/metadata ingestion
- [ ] canonical external-player-ID mapping
- [ ] Today Dashboard
- [ ] Projection Center v1
- [ ] Data Health
- [ ] Settings/API connection status
- [ ] research-file upload metadata
- [ ] automated tests
- [ ] no fake betting probabilities

## Review before Phase 2

Replit must produce the acceptance report defined in `PHASE_ACCEPTANCE.md`.

Do not proceed if:
- a secret can be found in frontend source/bundle/API responses;
- duplicate players/games are created on rerun;
- FantasyPros snapshots overwrite older snapshots;
- projected lineups are presented as official posted lineups;
- unresolved identity conflicts are silently name-matched;
- Data Health cannot tell you whether MLB or FantasyPros is stale/broken.

## After Phase 1 is accepted

Proceed one phase at a time:
1. Statcast / player and pitcher knowledge
2. Bullpen memory
3. Market engines
4. Odds/price engine
5. Bettor Intelligence
6. AI Analyst
7. Settlement/learning
8. Production hardening
