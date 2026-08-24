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

/**
 * THE VOCABULARY, AND WHY EACH TERM IS OR IS NOT IN IT.
 *
 * Read this before adding a word. Three obvious betting terms are deliberately
 * NOT tokens, because tokenisation splits on every non-alphanumeric character
 * and they collide head-on with this domain's own vocabulary:
 *
 *   total   `total_bases` is the core market of this system, and
 *           `park_total_bases_factor` and a bare `total` metric key both exist.
 *           Tokenising `total` would reject the feature store's own payloads.
 *   unit    a bare `unit` key exists in the feature vocabulary.
 *   line    no key collides today, but "line drive" is ordinary baseball prose
 *           and would be rejected on every bettor rationale that used it.
 *           "line up" and "line-up" also split to ["line", "up"], while
 *           "lineup" stays one word and would not have tripped.
 *
 * The betting sense of all three is caught by PROHIBITED_BETTING_PHRASES
 * instead, which matches against the whole normalised string and therefore
 * distinguishes "the line moved" from "line drive rate".
 *
 * In the vocabulary as tokens: bet, bets, betting, chalk, chalky, clv, juice,
 * moneyline, odd, odds, over, payout, price, sportsbook, sportsbooks, spread,
 * stake, stakes, under, vig, wager, wagers. Plus `ev` under the exit-velocity
 * exception below.
 *
 * Ambiguous in prose, exempted there and only there: over, under, book. See
 * PROSE_AMBIGUOUS_TOKENS.
 *
 * Checked and found safe to tokenise: chalk and book collide with no metric
 * key in this codebase. juice was already present and does not catch "juiced",
 * which is the form the baseball term takes.
 */
const PROHIBITED_BETTING_TOKENS = new Set([
  "bet",
  "book",
  "books",
  "chalk",
  "chalky",
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

/**
 * Phrases are matched against the whole normalised string, before any token
 * scan and before any prose exemption. That is what lets the betting sense of
 * "line", "total" and "unit" be rejected without tokenising words this domain
 * needs, and it is also how "over under" is still caught even though "over" and
 * "under" are individually exempt in prose.
 */
const PROHIBITED_BETTING_PHRASES = [
  "american odds",
  "at the book",
  "closing line",
  "closing line value",
  "decimal odds",
  "expected value",
  "fractional odds",
  "full unit",
  "game total",
  "half unit",
  "implied probability",
  "implied prob",
  "line move",
  "line moved",
  "line movement",
  "money line",
  "opening line",
  "over under",
  "point spread",
  "run total",
  "sports book",
  "team total",
  "unit size",
  "units on",
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
 * while stopping no pricing from entering. "book" is the same case: the venue
 * in "at the book", and the idiom in "by the book".
 *
 * The exemption is narrower than it looks. Phrases are matched first and are
 * not exempted, so "over under", "at the book", "game total" and "line moved"
 * are all still rejected in prose. What survives is only the bare word used in
 * its ordinary English sense.
 *
 * The hard rule is specific about what may never appear: no odds, prices,
 * expected value, implied probability, CLV, stake or vig. None of that is
 * ambiguous, and none of it is exempted here.
 */
const PROSE_AMBIGUOUS_TOKENS = new Set(["over", "under", "book"]);
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
