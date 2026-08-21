# Open Questions and Edit Checklist

These are deliberate review points, not blockers to reading the plan.

## Bullpen
- Should availability heuristics remain fixed project rules or become configurable/admin-editable?
- What exact freshness window makes Bullpen Room STALE?
- Do we want manager/beat overrides entered manually, AI-assisted, or both with human confirmation?

## Market research
- Should Phase 3 rankings be ordinal only or include an uncalibrated research score? Recommendation: ordinal plus transparent feature evidence, avoid pseudo-probabilities.
- How should ties be represented?
- What minimum sample rules should trigger INSUFFICIENT SAMPLE for pitch-type and split panels?

## Historical/modeling
- How many seasons should be included initially in model training?
- Do we require a full season of 2026 before activation, or allow historical backfill plus 2026 walk-forward validation?
- What simple benchmark must each market model beat before ACTIVE status?

## Confidence
- Should FIRE be limited to a maximum count per market/slate?
- Should HOLD mean model-positive but operationally uncertain, or broadly "interesting but not recommended"?

## Bettor Intelligence
- Which bettors/sources are initial priority?
- How much source text may be retained versus only structured paraphrase/mechanism tags?
- Should bettor identity be source-account-specific or person-level across platforms?

## AI
- Should the AI be able to create draft research notes directly in a review queue?
- Which database actions, if any, should the AI ever be allowed to write? Recommendation: none initially except draft notes that require approval.

## Daily automation
- What exact refresh schedule do we want from morning through first pitch?
- When should the final pregame prediction snapshot freeze?
- Should late scratches automatically downgrade affected statuses or fully rerun the market board?

## Workbook/export
- Keep existing seven-sheet workbook unchanged, or add XBH rows/sheet and version the spec?
- Does the web platform become the official record while Excel is only an export? Recommendation: yes.

## UX
- Should Park research get a standalone Park Lab page or remain in Game Lab?
- Should source provenance open in a side drawer or inline expandable rows?

## Edit workflow

For every change we make to this pack:
1. update the relevant phase document;
2. update the Master Roadmap if phase/order changes;
3. add a Decision Log row if the rule changes behavior;
4. update the Plan Mode prompt if Replit instructions change;
5. do not rely on chat memory alone.
