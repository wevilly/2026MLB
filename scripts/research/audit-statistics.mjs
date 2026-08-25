/**
 * The arithmetic behind the research audit, with no database and no I/O.
 *
 * Separated from rank-outcome-audit.mjs for the same reason
 * round-robin-comparison.ts is separated from the route that feeds it: a
 * measurement nobody can test is not evidence. Every function here is pure, so
 * tests/research-audit-statistics.test.ts can check them against hand-computed
 * answers, and a wrong number shows up as a failing test rather than as a
 * confident-looking table.
 *
 * These are outcome statistics: hit rates, intervals and discrimination over
 * settled official results. Nothing here reads or produces odds, price, EV,
 * CLV, vig, stake or implied probability.
 */

/**
 * Wilson score interval for a binomial proportion.
 *
 * The normal approximation is wrong exactly where this audit spends most of its
 * time: small buckets and rates near 0 or 1. A bucket of six with four hits is
 * 67 percent, and without an interval that reads as a finding rather than as
 * noise. Wilson stays inside [0, 1] and does not collapse at the extremes.
 */
export function wilson(hits, total, z = 1.96) {
  if (total === 0) return null;
  const p = hits / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [
    Math.max(0, (centre - spread) / denominator),
    Math.min(1, (centre + spread) / denominator),
  ];
}

/**
 * Rank-order AUC, by the Mann-Whitney identity, with midranks for ties.
 *
 * Reads as: the probability that a randomly chosen hit scored higher than a
 * randomly chosen miss. 0.50 is no information, and it is invariant to the base
 * rate, which matters because HR and TB have very different base rates and
 * would otherwise not be comparable.
 *
 * Ties are averaged rather than broken. Whole groups of candidates share a
 * research rank, and counting a tie as a win would inflate the number by
 * exactly the amount the engine did not earn.
 *
 * Returns null when the question is unanswerable: no rows, or all outcomes the
 * same. Null is not 0.5. An all-hits sample carries no ordering information but
 * it is also not evidence of a coin flip, and reporting 0.5 there would invent
 * a result.
 */
export function auc(scores, labels) {
  const n = scores.length;
  if (n === 0 || labels.length !== n) return null;
  const positives = labels.reduce((count, label) => count + (label ? 1 : 0), 0);
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return null;

  const order = scores
    .map((score, index) => ({ score, label: Boolean(labels[index]) }))
    .sort((a, b) => a.score - b.score);

  const midranks = new Array(n);
  let index = 0;
  while (index < n) {
    let end = index;
    while (end + 1 < n && order[end + 1].score === order[index].score) end += 1;
    const midrank = (index + end + 2) / 2; // ranks are 1-based
    for (let at = index; at <= end; at += 1) midranks[at] = midrank;
    index = end + 1;
  }

  let positiveRankSum = 0;
  for (let at = 0; at < n; at += 1) if (order[at].label) positiveRankSum += midranks[at];
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * Rank buckets.
 *
 * Coarse on purpose. A per-rank hit rate over one season is a dozen rows deep
 * and reads as noise; these are wide enough to say something and narrow enough
 * that a monotone trend across them would be visible. "unranked" is kept as its
 * own bucket rather than dropped, because RANK, DON'T GATE means an unranked
 * candidate is still a surfaced candidate and its outcomes still count.
 */
export const RANK_BUCKETS = [
  { label: "1 to 3", test: (rank) => rank !== null && rank <= 3 },
  { label: "4 to 6", test: (rank) => rank !== null && rank >= 4 && rank <= 6 },
  { label: "7 to 10", test: (rank) => rank !== null && rank >= 7 && rank <= 10 },
  { label: "11 to 15", test: (rank) => rank !== null && rank >= 11 && rank <= 15 },
  { label: "16 or worse", test: (rank) => rank !== null && rank >= 16 },
  { label: "unranked", test: (rank) => rank === null },
];

/** The engine's own state vocabulary, strongest first. */
export const STATE_ORDER = ["STRONG", "POSITIVE", "NEUTRAL", "NEGATIVE", "BLOCKED"];

/**
 * Everything section B reports for one market.
 *
 * `rows` are {researchRank, researchState, outcomeHit}. Rank is null when the
 * engine surfaced a candidate without ordering it.
 */
export function summariseMarket(market, rows, minSample = 30) {
  const hits = rows.reduce((count, row) => count + (row.outcomeHit ? 1 : 0), 0);
  const baseRate = rows.length ? hits / rows.length : null;
  const ranked = rows.filter((row) => row.researchRank !== null && row.researchRank !== undefined);

  // Negated so that a better (lower) rank scores higher, which makes an AUC
  // above 0.5 mean "the ranking is right way up".
  const rankAuc = auc(ranked.map((row) => -row.researchRank), ranked.map((row) => row.outcomeHit));

  // The comparator sorts by state first and only then by rank. So the question
  // is not just whether rank predicts, but whether it predicts anything that
  // state has not already said. Holding state fixed answers that directly.
  const withinState = STATE_ORDER.map((state) => {
    const group = ranked.filter((row) => row.researchState === state);
    return {
      state,
      n: group.length,
      auc: auc(group.map((row) => -row.researchRank), group.map((row) => row.outcomeHit)),
    };
  }).filter((entry) => entry.n >= minSample && entry.auc !== null);

  const bucketOf = (label, group) => {
    const groupHits = group.reduce((count, row) => count + (row.outcomeHit ? 1 : 0), 0);
    const rate = group.length ? groupHits / group.length : null;
    return {
      label,
      n: group.length,
      hits: groupHits,
      rate,
      wilson: wilson(groupHits, group.length),
      lift: rate !== null && baseRate ? rate / baseRate : null,
      thin: group.length < minSample,
    };
  };

  return {
    market,
    n: rows.length,
    hits,
    baseRate,
    rankAuc,
    rankedN: ranked.length,
    withinState,
    buckets: RANK_BUCKETS
      .map((bucket) => bucketOf(bucket.label, rows.filter((row) => bucket.test(row.researchRank ?? null))))
      .filter((bucket) => bucket.n > 0),
    states: STATE_ORDER
      .map((state) => {
        const entry = bucketOf(state, rows.filter((row) => row.researchState === state));
        return { ...entry, state, lift: undefined };
      })
      .filter((entry) => entry.n > 0),
  };
}

/**
 * Did a two-leg construction convert?
 *
 * Both legs must have settled as a hit. A construction with one leg missing
 * from settlement is UNGRADABLE, not a loss: postponements, scratches and
 * unsettled rows are absences of evidence, and scoring them as failures would
 * quietly punish the comparator for games it never got to be judged on.
 *
 * `settledFor(leg)` returns true, false, or undefined when no settled outcome
 * exists for that leg.
 */
export function gradeConstruction(construction, settledFor) {
  if (!construction) return { gradable: false, converted: false };
  const legs = construction.legs.map((leg) => settledFor(leg));
  if (legs.some((hit) => hit === undefined || hit === null)) return { gradable: false, converted: false };
  return { gradable: true, converted: legs.every(Boolean) };
}
