# Audit extension: the previously unreviewed services

Remediation task 5.6. The original audit read tb-engine, bullpen-foundation,
round-robin-comparison, daily-market-board, model-training,
walk-forward-validation, settlement, orchestration and replit.md. This document
covers everything it did not.

Format matches the remediation plan: symptom, root cause, required change,
severity. **Nothing in this document was fixed silently.** Where a Phase 1 to
Phase 4 defect was found to repeat, it is logged here with the task it repeats,
and either recorded as already fixed by that task's rollout or scheduled as new
work.

Severity: BLOCKER means the system produces wrong or absent output today. HIGH
means a real defect with a material effect. MEDIUM means correctness debt. LOW
means hygiene.

---

## 1. The four unaudited market engines

The plan instructed: assume the five tb-engine findings are present until
disproven. Each was checked mechanically.

### 1.1 Task 2.6, non-transactional writes — WAS PRESENT, FIXED

walk-engine, xbh-engine and hr-engine each wrote candidates and evidence blocks
in a bare loop on the shared pool and reconciled afterwards, with none of it in
a transaction: the identical defect. Fixed under task 2.6, which explicitly
instructed applying the same pattern to the other four engines. hrrbi-engine
writes its whole slate in one set-based statement and has no reconcile step, so
it was already atomic.

The N+1 batching from task 2.6 was applied to tb-engine only, as the plan
scoped it. **Scheduled:** the same batching for walk, xbh and hr. Each still
issues one candidate insert plus roughly six evidence-block inserts per
candidate. Severity MEDIUM, same reasoning as 2.6: a slow refresh close to
first pitch is a refresh that misses the freeze window.

### 1.2 Task 2.7, hardcoded lineup source — WAS PRESENT, FIXED

All three carried their own copy of `getSlateLineupPlayers` with
`source_id = 'FANTASYPROS'` written into the SQL. Fixed under task 2.7: all four
now use the shared `querySlateLineupPlayers`, and all four annotate conflicted
candidates with a blocking evidence gap.

### 1.3 Task 4.2, absence of weather — WAS PRESENT, FIXED

No engine had a weather term. Fixed under task 4.2: all four read the slate's
weather in one query and score a bounded, market-specific term, with the extreme
cold and strong wind cases as counter-evidence flags.

### 1.4 Task 2.5, split versus unsplit metric divergence — PARTIALLY PRESENT, SCHEDULED

Measured precisely: for each engine, which metric keys are read BOTH with a
split-then-fallback and, elsewhere in the same file, unsplit with no fallback.

| Engine | Metrics resolved two ways | Severity |
| --- | --- | --- |
| tb-engine | none (fixed by task 2.5) | — |
| xbh-engine | none | — |
| walk-engine | `zone_percent` | MEDIUM |
| hr-engine | `barrel_percent`, `hard_hit_percent` | MEDIUM |

hr-engine is the worst case and is the same shape as the original iso defect:
`barrel_percent` and `hard_hit_percent` are resolved split-then-fallback for the
PITCHER and unsplit for the HITTER, in the same pass over the same matchup.

**Required change:** extract the `resolveHitterMetric` / `resolvePitcherMetric`
pair from tb-engine into a shared module and route every hitter and pitcher
metric read in walk-engine, xbh-engine and hr-engine through it, with a
`seasonHitterMetric` for the fields deliberately labelled "season" and an
`UNSPLIT_*_METRICS` map carrying a stated reason for each genuine exception.
This is a SELECTION change and needs the `SELECTION:` prefix.

Separately, each engine reads a set of metrics unsplit with no stated reason:

- walk-engine: `o_swing_percent`, `pitches_per_pa`, `z_swing_percent`
- xbh-engine: `avg_ev`, `barrel_percent`, `gb_percent`, `ld_percent`,
  `pull_percent`, `sweet_spot_percent`
- hr-engine: `avg_ev`, `barrel_pa`, `fb_percent`, `gb_percent`, `iso`,
  `launch_angle`, `pull_percent`, `xslg`

These are consistent within each file, so they are not the 2.5 defect. They are
the same unstated-policy problem the `UNSPLIT_HITTER_METRICS` map was introduced
to make visible. Severity LOW individually, MEDIUM as a set.

### 1.5 Task 4.1, park excluded from ranking — PRESENT, SCHEDULED

| Engine | State |
| --- | --- |
| tb-engine | Fixed by task 4.1: composite total-bases factor, bounded, batter-side split. |
| xbh-engine | `buildParkEvidence` still carries "Park factors are context only, not used to gate or boost rank directly". Park is not read by the score. **This is the identical defect.** |
| walk-engine | Carries a context-only note, but a JUSTIFIED one: "walk rate is primarily pitcher/hitter discipline driven". This is the correct call for this market and should stay, with the justification kept. |
| hr-engine | Reads `hr_factor` and uses it in evidence and in `checkCounterEvidence`, so park is not excluded here. It uses the RAW HR factor and the UNSPLIT key. |

**Required change, xbh-engine:** SELECTION. Compose an extra-base-hit park
factor. The tb-engine composite is the wrong one to reuse directly: extra base
hits are doubles, triples and home runs, so the singles component should carry
little or no weight and the doubles component should dominate. Feed it into
`computeEvidenceScore` as a bounded adjustment capped below the pitcher matchup
term, use the batter-side split, and rewrite the note. Severity HIGH.

**Required change, hr-engine:** SELECTION. The raw HR factor is the right base
metric for this market, so no composite is needed, but it must use the
batter-side split like every other park read, and it should be a bounded score
adjustment rather than only a counter-evidence flag. Severity MEDIUM.

**Required change, walk-engine:** none. Keep the note and its justification.
This is the one place where "context only" is a decision rather than an
omission.

### 1.6 Task 4.3, batting order step function — PRESENT, SCHEDULED

All three engines award points by batting-order bucket. hr-engine's is a
three-bucket function on `battingOrder <= 4 / <= 6 / else`. The expected plate
appearance table and `opportunityScore` from task 4.3 are already exported from
tb-engine.

**Required change:** route all four engines through the shared expected plate
appearance value and expose the figure on each opportunity evidence payload.
Severity MEDIUM.

---

## 2. feature-store.ts

Reviewed against task 1.6, which the plan notes terminates here.

### 2.1 The feature vector is validated but its NULLs are not distinguished — HIGH

**Symptom:** a metric that the research snapshot recorded as NULL and a metric
that was never collected are the same value in the frozen vector.

**Root cause:** `assertMetricMap` accepts `number | null` and the flattener drops
nulls entirely, so `flattenNumbers` produces the same output for "this player
has no xslg row" and "this player's xslg row exists and is null". Task 1.6's
mean imputation and coverage check treat both as missing, which is the safe
reading, but the frozen vector cannot tell an operator which happened.

**Required change:** record the two cases separately in the snapshot, either as
a companion `nullFeatureKeys` list or by keeping the null keys in the vector and
excluding them at the model boundary rather than at the flattener.

### 2.2 The idempotency hash covers the vector, not its provenance — MEDIUM

**Symptom:** two captures of the same numbers from different research snapshots
produce one row, and the second capture's provenance is discarded.

**Root cause:** `featureHash` hashes the canonical feature JSON only. The
partial unique index on `(player_id, game_pk, market, feature_hash)` then treats
the second capture as a duplicate. That is the intended idempotency guarantee,
but it means the provenance rows written alongside the FIRST capture are the
only lineage kept.

**Required change:** decide explicitly whether provenance is part of a snapshot's
identity. If it is not, say so in the code, because a reader currently cannot
tell whether the second capture's lineage was deliberately or accidentally
dropped.

### 2.3 Two swallowed rollback failures — LOW

`catch { /* ignore */ }` around two `ROLLBACK` calls. Ignoring a rollback failure
is defensible, but after task 3.5 it should be logged rather than silent.

---

## 3. data-foundation.ts

### 3.1 `players.throws` is overwritten with an empty string — BLOCKER

**Symptom:** the entire platoon and split-metric layer in every engine silently
degrades to unsplit season values for an unknown fraction of players.

**Root cause:** `upsertOfficialPlayer` writes `String(pitchHand.code ?? "")`,
which is an EMPTY STRING when the payload has no `pitchHand`, and the conflict
clause is unconditional:

```
ON CONFLICT (player_id) DO UPDATE SET ... throws = EXCLUDED.throws
```

The game-feed ingest calls `upsertOfficialPlayer` for every player in the
boxscore, and the schedule request hydrates only `team,venue,probablePitcher`.
Any call whose payload lacks `pitchHand` therefore OVERWRITES a previously known
handedness with `""`.

`bullpen-foundation` guards exactly this case for `reliever_profiles`:

```
throws = CASE WHEN EXCLUDED.throws IS NOT NULL AND EXCLUDED.throws <> ''
              THEN EXCLUDED.throws ELSE reliever_profiles.throws END
```

The `players` table has no such guard, and the same guard is missing from both
`upsertOfficialPlayer` and the FantasyPros directory upsert, which writes
`String(metadata.bat_hand ?? "")` for `bats` in the same shape.

Downstream, `""` is not null: `resolveBatterSide(bats, "")` returns null for a
switch hitter, `isPlatoonDisfavored` returns false, and `hk(metric, null)`
resolves to the unsplit key. Every split metric quietly becomes the season line
and nothing reports it.

**Required change:**
1. Apply the same non-empty guard to `bats` and `throws` in both player upserts.
2. Write NULL rather than `""` when the field is absent, so "unknown" is a
   distinguishable value.
3. Add a data-health counter: how many players in today's lineups have a null or
   empty `throws`. That is the number the plan asked for and it cannot be
   answered from code alone.
4. Backfill: re-hydrate handedness for every player with an empty value.

Severity BLOCKER: this determines whether the platoon layer runs at all, which
is the plan's own framing of the question.

### 3.2 `resolveBatterSide` returns null for a switch hitter facing an unknown hand — HIGH, DESIGN

Correct as written: a switch hitter's side is genuinely undetermined until the
pitcher's hand is known. But combined with 3.1 it is reached far more often than
intended, and the candidate carries no flag saying the split layer did not run.

**Required change:** emit an explicit `PLATOON_SIDE_UNRESOLVED` disclosure on the
candidate whenever `resolveBatterSide` returns null, so a degraded evaluation is
visible rather than silent. This is a disclosure, not a gate: RANK, DON'T GATE.

---

## 4. research-foundation.ts

### 4.1 Two bare catch blocks — HIGH, repeats task 3.5

**Symptom:** a Statcast split ingest that fails partway reports the rows it
managed and nothing about the failure.

**Root cause:** `} catch {` inside the per-player split loop, and a second in
`extractEmbeddedArray`. Same shape as the three the plan found in
bullpen-foundation.

**Required change:** apply the task 3.5 treatment. Bind the error, log it,
increment a failure counter, and return PARTIAL rather than SUCCESS. Twenty-two
literal `'SUCCESS'` writes in this file each need the same expected-volume check.

### 4.2 Name-only player resolution — FIXED

`labProfile` resolved `playerId ?? profileCount.rows[0]?.player_id`, silently
picking the first row for a name carried by more than one club. Fixed under task
2.7. It is the only name-based resolution in the codebase.

### 4.3 Nineteen sequential per-entity loops — MEDIUM

Same N+1 shape as tasks 2.6 and 5.3, in the largest service in the repository.
Not measured; scheduled behind the engine batching above.

---

## 5. batter-pitcher-research.ts

No new defects. This service is the best-behaved in the repository:

- The BvP rank adjustment is bounded by `MAX_RANK_ADJUSTMENT`, is zero below
  `MIN_CONTEXT_PA`, and is documented as unable to set a research state.
- It refuses to fall forward or infer a pair from names, and says so in the
  returned note.
- Age decay and shrinkage are explicit and exposed on the payload.

One observation, LOW: `coverageStatus` is the hardcoded string
`"STATCAST_AVAILABLE; RETROSHEET_ADAPTER_NOT_CONFIGURED"`. It is honest today but
will not change when the adapter is configured. It should be derived.

---

## 6. ai-tool-gateway.ts and ai-workflows.ts

Reviewed for prompt injection surface, as the plan directed.

### 6.1 The tool gateway is well bounded — no finding

`executeAiToolCall` refuses any tool that is not registered, active, and
`READ_ONLY`; parameter keys are allowlisted per tool; every call is logged to an
append-only table with the tool definition that was in force. Write operations
are structurally unreachable through this path. This is the right design.

### 6.2 Live web search results reach the model as untrusted content — HIGH

**Symptom:** a page that ranks for a research query can put text in front of the
model.

**Root cause:** `LIVE_WEB_SEARCH` scrapes DuckDuckGo HTML and returns title, URL
and snippet. `runAiAnalystChat` then interpolates
`JSON.stringify(toolResult.result).slice(0, 24000)` directly into the user turn.
Third-party text is therefore concatenated into the prompt with no delimiter and
no marking.

Mitigations that ARE present: the system prompt instructs the model to treat web
results as unverified until reviewed in the sourcing register; outbound URLs are
parsed and protocol-checked; no user-supplied URL is fetched; the model cannot
call tools itself, since the tool is selected server-side before the model runs;
and every web claim is recorded in the sourcing register for human review.

The residual risk is that the guidance lives in an instruction the injected text
can argue with, rather than in the structure of the prompt.

**Required change:**
1. Wrap tool output in an explicit untrusted-content delimiter and state in the
   system prompt that nothing inside it is an instruction.
2. Strip or escape any content inside snippets that looks like an instruction to
   the assistant before interpolation.
3. State the model's inability to act: it has no tools at this point in the
   flow, and the system prompt should say so, so a "call this tool" injection is
   inert by construction rather than by refusal.

Severity HIGH, because `/analyst/ai/tool-call` and `/analyst/ai/chat` are both
HTTP-reachable.

### 6.3 Neither AI route requires the operator approval session — HIGH

**Symptom:** `POST /analyst/ai/tool-call` and `POST /analyst/ai/chat` are
reachable without the `ai_operator_approval` cookie that the operator-session
routes exist to issue.

**Root cause:** the approval session gates the draft approval routes, not the
tool-call or chat routes.

**Required change:** decide explicitly whether the read-only tool surface should
require an approved operator session. If it should not, say so in a comment
where the approval middleware is applied elsewhere, because its absence
currently reads as an oversight.

---

## 7. exports.ts

`buildSlateExport` and `buildWorkbookExport` do not call `assertNoBettingData`.
They compose from platform tables that are themselves guarded, so no betting
field can currently reach them, but the export is the outermost boundary and the
one most likely to gain a hand-assembled field later.

**Required change:** call `assertNoBettingData` on the assembled export payload
before returning. Cheap, and it puts the guard at the boundary it protects.
Severity LOW today, HIGH the day someone adds a field.

---

## 8. bettor-intelligence.ts

### 8.1 No betting-data guard on an ingest surface named for betting — HIGH

**Symptom:** `POST /analyst/bettor/ingest` accepts a third-party pick and stores
its evidence, and nothing checks the payload for prohibited content.

**Root cause:** `assertNoBettingData` does not appear anywhere in this service.
The schema is careful: `bettor_picks` records evidence and lineage, and the
tables carry no odds or stake columns. But the guard that the plan calls
non-negotiable is applied in settlement.ts and feature-store.ts and not here,
on the one surface whose entire purpose is to accept content from outside the
system.

**Required change:** call `assertNoBettingData` on every ingested bettor payload
and on the evidence JSON before persisting. If a third-party pick genuinely
arrives carrying a price, the correct behaviour is to reject the ingest, not to
store it in a jsonb column.

### 8.2 Five sequential per-entity loops — MEDIUM

Same N+1 shape. Two transactions are used correctly.

---

## 9. cache.ts

### 9.1 A failed load is never cached, but a pending load is shared — no finding

`readThroughCache` de-duplicates concurrent loads and clears the pending entry in
a `finally`, so a rejection does not poison the cache. Correct.

### 9.2 Capacity eviction sorts the whole map on every insert — LOW

`enforceCapacity` runs `[...entries.entries()].sort(...)` whenever the map is at
capacity, which is O(n log n) per insert at the ceiling of up to 5,000 entries.
A least-recently-used ring or a simple insertion-order eviction would be O(1).

### 9.3 The cache is per-process — MEDIUM, DOCUMENTATION

With more than one replica, two operators can see different board data for up to
`CACHE_POLICY.marketBoard` milliseconds, and `invalidateCache` after a refresh
clears one process's copy only. This is fine for a single process and needs to
be stated in replit.md before a second replica exists.

---

## 10. audit.ts

No defects. Small, append-only, parameterised, and it now takes an optional
executor so an event can be written in the caller's transaction. The `limit` is
clamped to 1 to 500.

One observation, LOW: `queryAuditEvents` has no filter by action, resource or
time, so an operator investigating one promotion has to page through everything.

---

## 11. The mlb-analyst frontend

Reviewed for the question the plan asked: with 1,472 rows at RESEARCH_ONLY /
NONE, how has the interface been presenting a null model layer for its entire
life?

### 11.1 It presents the null state honestly — no defect

This is the strongest part of the application. Specifically:

- `ReadinessStrip` renders the readiness contract on every page, and renders an
  explicit "readiness unavailable, this view cannot be treated as operational"
  panel when no health contract comes back, rather than a blank or a default.
- The board's metric row shows "Usable now" as `0` with the note "Evidence
  remains audit-only" whenever `readiness.usable` is false, instead of showing
  the row count.
- A "Research-only" count is displayed as a first-class metric with the note "No
  unsupported probability signal shown".
- The empty state explains that the view reads persisted server outputs and that
  research evidence "is never converted into probability or confidence guidance
  without a current accepted validation contract".
- A visible line states that the board excludes odds, prices, EV, CLV, implied
  probability, vig and recommendation fields.

The interface has been telling the truth the whole time. The defect was
underneath it.

### 11.2 The confidence basis note table was a two-branch ternary — FIXED

`MODEL_CONFIRMED` versus everything else, so all four collapsed
`MODEL_REJECTED` conditions rendered as "Model validation did not confirm this
research row". Fixed under task 2.3: a lookup table with one sentence per basis,
plus the imputed-feature count and coverage per row from task 1.6.

### 11.3 App.tsx is one file — MEDIUM

Over 2,000 lines holding every page. The same accretion that produced
analyst.ts, and it should get the same treatment as task 5.2. Not urgent: unlike
the router, it has no ordering hazard and no unreviewed HTTP surface.

---

## Summary of scheduled work

| # | Item | Severity | Repeats |
| --- | --- | --- | --- |
| S1 | `players.throws` overwritten with `""`, plus the population-rate measurement and backfill | BLOCKER | new |
| S2 | Web search results reach the model as undelimited untrusted content | HIGH | new |
| S3 | No betting-data guard on the bettor ingest surface | HIGH | new |
| S4 | SELECTION: xbh-engine park excluded from ranking | HIGH | task 4.1 |
| S5 | research-foundation bare catches and 22 unconditional SUCCESS writes | HIGH | task 3.5 |
| S6 | Decide whether the AI tool and chat routes need an approved operator session | HIGH | new |
| S7 | SELECTION: hr-engine and walk-engine split-versus-unsplit divergence | MEDIUM | task 2.5 |
| S8 | SELECTION: hr-engine park uses the raw unsplit HR factor | MEDIUM | task 4.1 |
| S9 | Expected plate appearances in walk, xbh and hr engines | MEDIUM | task 4.3 |
| S10 | N+1 batching for walk, xbh, hr, research-foundation, bettor-intelligence | MEDIUM | tasks 2.6, 5.3 |
| S11 | feature-store: distinguish a null metric from an uncollected one | HIGH | task 1.6 |
| S12 | `PLATOON_SIDE_UNRESOLVED` disclosure on the candidate | HIGH | new |
| S13 | feature-store snapshot identity versus provenance, stated | MEDIUM | new |
| S14 | Split App.tsx by page | MEDIUM | task 5.2 |
| S15 | `assertNoBettingData` on the export boundary | LOW | new |
| S16 | Cache eviction cost, per-process scope documented | LOW | new |
| S17 | Audit event filters; derived BvP coverage status; logged rollback failures | LOW | new |
