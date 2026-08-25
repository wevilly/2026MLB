/**
 * The research audit's arithmetic, checked against hand-computed answers.
 *
 * A measurement tool is only worth what its numbers are worth. Every case here
 * has an answer worked out independently of the implementation, because the
 * failure mode that matters is not a crash: it is a plausible-looking table
 * that is quietly wrong, read once, and acted on.
 *
 * Three of these guard specific mistakes that are easy to make and invisible
 * afterwards: an AUC with the sign inverted (which would report a backwards
 * ranking as a good one), ties counted as wins (which inflates AUC by exactly
 * the amount the engine did not earn), and an unsettled leg scored as a loss
 * (which would punish the comparator for games it never got to be judged on).
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  auc,
  gradeConstruction,
  summariseMarket,
  wilson,
} from "../scripts/research/audit-statistics.mjs";

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

describe("rank-order AUC", () => {
  test("perfect ordering is 1 and perfect inversion is 0", () => {
    // Scores are negated ranks in the audit, so higher must mean better.
    assert.equal(auc([1, 2, 3, 4], [false, false, true, true]), 1);
    assert.equal(auc([1, 2, 3, 4], [true, true, false, false]), 0);
  });

  test("an inverted ranking does not read as a good one", () => {
    // The audit scores -rank. A ranking where rank 1 always misses and rank 10
    // always hits must come back near 0, never near 1. Getting this backwards
    // would turn the worst possible finding into the best possible headline.
    const ranks = [1, 2, 3, 8, 9, 10];
    const hits = [false, false, false, true, true, true];
    assert.equal(auc(ranks.map((rank) => -rank), hits), 0);
  });

  test("ties are averaged, not counted as wins", () => {
    // Every score identical: the ordering carries no information at all.
    assert.equal(auc([1, 1, 1, 1], [true, true, false, false]), 0.5);
  });

  test("a partial tie matches the pairwise count", () => {
    // Positives at 2 and 3, negatives at 1 and 2. Pairwise: 3>1 win, 3>2 win,
    // 2>1 win, 2 vs 2 tie counts a half. So 3.5 of 4 pairs, which is 0.875.
    close(auc([1, 2, 2, 3], [false, true, false, true]) as number, 0.875);
  });

  test("an unanswerable question returns null rather than 0.5", () => {
    // All hits carries no ordering information, but it is also not evidence of
    // a coin flip. Reporting 0.5 there would invent a result.
    assert.equal(auc([1, 2, 3], [true, true, true]), null);
    assert.equal(auc([1, 2, 3], [false, false, false]), null);
    assert.equal(auc([], []), null);
  });
});

describe("Wilson interval", () => {
  test("no observations gives no interval", () => {
    assert.equal(wilson(0, 0), null);
  });

  test("one observation does not collapse to a point", () => {
    // The normal approximation gives [1, 1] here, which reads as certainty from
    // a single event. Wilson gives roughly [0.207, 1].
    const bounds = wilson(1, 1) as [number, number];
    close(bounds[0], 1 / (1 + 1.96 * 1.96), 1e-9);
    close(bounds[1], 1, 1e-9);
  });

  test("zero hits is bounded away from certainty", () => {
    const bounds = wilson(0, 1) as [number, number];
    close(bounds[0], 0, 1e-9);
    close(bounds[1], (1.96 * 1.96) / (1 + 1.96 * 1.96), 1e-9);
  });

  test("a large balanced sample matches the textbook interval", () => {
    const bounds = wilson(50, 100) as [number, number];
    close(bounds[0], 0.4038, 1e-4);
    close(bounds[1], 0.5962, 1e-4);
  });

  test("a wide interval is what marks a thin bucket as unreadable", () => {
    const thin = wilson(4, 6) as [number, number];
    const solid = wilson(400, 600) as [number, number];
    assert.ok(thin[1] - thin[0] > 0.5, "six observations must stay obviously uncertain");
    assert.ok(solid[1] - solid[0] < 0.1, "six hundred observations must narrow");
  });
});

describe("grading a two-leg construction", () => {
  const construction = { legs: [{ id: "a" }, { id: "b" }] };

  test("both legs must settle as a hit", () => {
    assert.deepEqual(gradeConstruction(construction, () => true), { gradable: true, converted: true });
    assert.deepEqual(
      gradeConstruction(construction, (leg: { id: string }) => leg.id === "a"),
      { gradable: true, converted: false },
    );
  });

  test("an unsettled leg is ungradable, never a loss", () => {
    // A postponement or a scratch is an absence of evidence. Scoring it as a
    // failure would punish the comparator for a game it never got to be judged
    // on, and the bias would be invisible in the totals.
    const result = gradeConstruction(construction, (leg: { id: string }) => (leg.id === "a" ? true : undefined));
    assert.deepEqual(result, { gradable: false, converted: false });
  });

  test("a side with no construction is ungradable", () => {
    assert.deepEqual(gradeConstruction(null, () => true), { gradable: false, converted: false });
  });
});

describe("per-market summary", () => {
  const rows = [
    { researchRank: 1, researchState: "STRONG", outcomeHit: true },
    { researchRank: 2, researchState: "STRONG", outcomeHit: true },
    { researchRank: 3, researchState: "POSITIVE", outcomeHit: false },
    { researchRank: 12, researchState: "NEUTRAL", outcomeHit: false },
    { researchRank: null, researchState: "NEUTRAL", outcomeHit: true },
  ];

  test("the base rate and bucket lift are consistent", () => {
    const summary = summariseMarket("TOTAL_BASES_2_PLUS", rows, 1);
    close(summary.baseRate as number, 3 / 5);
    const top = summary.buckets.find((bucket) => bucket.label === "1 to 3");
    assert.equal(top?.n, 3);
    assert.equal(top?.hits, 2);
    close(top?.lift as number, (2 / 3) / (3 / 5));
  });

  test("an unranked candidate is still counted", () => {
    // RANK, DON'T GATE: a candidate the engine surfaced without ordering is
    // still a surfaced candidate, and its outcome still happened. Dropping it
    // would quietly restrict the audit to the rows the engine felt sure about.
    const summary = summariseMarket("TOTAL_BASES_2_PLUS", rows, 1);
    const unranked = summary.buckets.find((bucket) => bucket.label === "unranked");
    assert.equal(unranked?.n, 1);
    assert.equal(summary.n, 5);
    assert.equal(summary.rankedN, 4, "AUC must be computed over ranked rows only");
  });

  test("thin buckets are flagged rather than hidden", () => {
    const summary = summariseMarket("TOTAL_BASES_2_PLUS", rows, 30);
    assert.ok(summary.buckets.every((bucket) => bucket.thin), "every bucket here is far below 30");
  });

  test("empty buckets and states are dropped, not printed as zero", () => {
    const summary = summariseMarket("HOME_RUN", [
      { researchRank: 1, researchState: "STRONG", outcomeHit: true },
    ], 1);
    assert.deepEqual(summary.buckets.map((bucket) => bucket.label), ["1 to 3"]);
    assert.deepEqual(summary.states.map((state) => state.state), ["STRONG"]);
  });
});
