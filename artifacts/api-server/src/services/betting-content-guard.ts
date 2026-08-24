/**
 * The prohibited-betting-content vocabulary, in one place.
 *
 * No odds, prices, expected value, implied probability, CLV, stake or vig may
 * enter this system, in any code path. Pricing is handled outside it by the
 * operator at the book.
 *
 * This vocabulary was defined inside feature-store.ts and applied only there.
 * Audit S3 found that bettor-intelligence, the one surface whose entire purpose
 * is accepting content written outside the system, never applied it at all.
 * Extracted verbatim so both surfaces enforce the same list and it cannot drift
 * between them.
 *
 * Each caller keeps its own error type: what counts as prohibited is shared,
 * what to do about it is not.
 */

const PROHIBITED_BETTING_TOKENS = new Set([
  "bet",
  "bets",
  "betting",
  "clv",
  "juice",
  "moneyline",
  "odds",
  "odd",
  "over",
  "payout",
  "price",
  "sportsbook",
  "sportsbooks",
  "spread",
  "stake",
  "stakes",
  "under",
  "vig",
  "wager",
  "wagers",
]);

const PROHIBITED_BETTING_PHRASES = [
  "american odds",
  "closing line value",
  "decimal odds",
  "expected value",
  "fractional odds",
  "implied probability",
  "implied prob",
  "money line",
  "point spread",
  "sports book",
];

/** camelCase and snake_case both flattened to space-separated lowercase words. */
export function normalizedWords(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The offending term, or null when the text carries no betting content.
 *
 * Matching is on whole words rather than substrings, which is what keeps the
 * check usable on a surface that legitimately discusses bettors: "bettor" is
 * not "bet", and the domain vocabulary survives while the pricing vocabulary
 * does not.
 */
export function prohibitedBettingTerm(value: string): string | null {
  return scanForBettingTerm(value, EMPTY_EXEMPTIONS);
}

/**
 * Tokens that are betting vocabulary in a structured field and ordinary English
 * in a sentence.
 *
 * "over" and "under" name the two sides of a priced market, which is why a
 * feature key called `over` is prohibited outright. In a bettor's written
 * rationale the same words appear in "over the last 15 games" and "under the
 * lights", and rejecting those would refuse most legitimate research prose
 * while stopping no pricing from entering.
 *
 * The hard rule is specific about what may never appear: no odds, prices,
 * expected value, implied probability, CLV, stake or vig. None of that is
 * ambiguous, and none of it is exempted here.
 */
const PROSE_AMBIGUOUS_TOKENS = new Set(["over", "under"]);
const EMPTY_EXEMPTIONS: ReadonlySet<string> = new Set();

/**
 * As prohibitedBettingTerm, for free-form text written by a person rather than
 * a structured key or identifier.
 *
 * Every unambiguous pricing term is still rejected. The exempt comparators are
 * skipped during the scan rather than filtered from its result, so a sentence
 * carrying both an exempt word and a real one still reports the real one:
 * "I like the over, the odds are good" must fail on "odds".
 */
export function prohibitedBettingTermInProse(value: string): string | null {
  return scanForBettingTerm(value, PROSE_AMBIGUOUS_TOKENS);
}

function scanForBettingTerm(value: string, exempt: ReadonlySet<string>): string | null {
  const normalized = normalizedWords(value);
  if (!normalized) return null;
  if (PROHIBITED_BETTING_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return normalized;
  }
  const words = normalized.split(" ");
  for (const [index, word] of words.entries()) {
    if (exempt.has(word)) continue;
    if (word === "ev") {
      // Baseball research commonly uses avg_ev / max_ev for average or maximum
      // exit velocity. A standalone `ev` key is still prohibited expected-value
      // betting data, while these established baseball metric names are valid.
      if (!["avg", "average", "max", "maximum", "mean", "median"].includes(words[index - 1] ?? "")) {
        return word;
      }
      continue;
    }
    if (PROHIBITED_BETTING_TOKENS.has(word)) return word;
  }
  return null;
}
