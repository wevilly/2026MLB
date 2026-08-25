/**
 * Does the research rank predict the settled outcome?
 *
 * Nothing in this platform has answered that yet. Four engines assign an
 * ordinal rank, the Round Robin comparator picks a side from those ranks, and
 * `historical_outcomes` records what actually happened, but the three have
 * never been joined and scored. No model has reached ACTIVE, so every board is
 * currently asserting an ordering that has not been measured against truth.
 * This is that measurement.
 *
 * READ ONLY. Every statement here is a SELECT. It writes nothing, promotes
 * nothing, and changes no platform state, so it is safe to run mid-slate.
 *
 * It is calibration work, not pricing: hit rates, discrimination and coverage,
 * computed from settled official outcomes. No odds, price, EV, CLV, vig, stake
 * or implied probability is read, derived or printed, and none exists in the
 * tables it reads.
 *
 * Four questions, in the order they have to be answered:
 *
 *   A. COVERAGE     Is there enough settled data to conclude anything at all?
 *                   Asked first on purpose. A confident table over 40 rows is
 *                   worse than no table, so this section can end the run.
 *
 *   B. SIGNAL       Per market: hit rate by rank bucket and by research state,
 *                   with Wilson intervals, plus rank-order AUC. AUC is the one
 *                   number that says whether the ordering carries information.
 *
 *   C. COMPARATOR   The Round Robin comparison replayed over history. The
 *                   losing side is retained by contract, which makes it a
 *                   ready-made control: for each game both sides proposed a
 *                   construction, the comparator chose one, and settlement
 *                   says which converted. If the chosen side does not beat the
 *                   rejected side, `compareConstruction` is not earning its
 *                   complexity.
 *
 *   D. WALK POLICY  `WALK_SETTLEMENT_POLICY` grades walks as MLB baseOnBalls,
 *                   which includes intentional walks and excludes hit by
 *                   pitch. replit.md flags that as an unconfirmed assumption.
 *                   Because walks, intentional walks and hit by pitch are each
 *                   persisted separately, the exposure is measurable without
 *                   refetching a feed: this counts how many settled rows would
 *                   flip under each alternative definition. It does not decide
 *                   which definition is right. That is the operator's rule at
 *                   the book, and it lives outside this system by design.
 *
 * What section C deliberately does NOT do: it replays the comparator with the
 * operational current-date readiness gate removed. That gate stops an operator
 * acting on a stale slate today; it is not a claim about whether the evidence
 * was good on the day. Leaving it in would mark every historical candidate
 * unselectable and produce zero constructions, so the section would silently
 * measure nothing. Section C therefore scores the comparison logic, not the
 * live operational pipeline, and cannot speak to pipeline freshness. Every
 * other gate (identity, blocked, negative, stale or incomplete evidence,
 * unresolved starter) is the real one, imported from the same modules the route
 * uses rather than restated here.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/research/rank-outcome-audit.mjs
 *   DATABASE_URL=... node scripts/research/rank-outcome-audit.mjs --since 2026-04-01 --until 2026-08-24
 *   DATABASE_URL=... node scripts/research/rank-outcome-audit.mjs --board RR2 --json
 *
 * Flags:
 *   --since YYYY-MM-DD   first slate date to include (default: all history)
 *   --until YYYY-MM-DD   last slate date to include (default: yesterday, ET)
 *   --board RRn          restrict section C to one board (default: all five)
 *   --min-sample N       below this a bucket is marked thin and gets no verdict (default 30)
 *   --json               emit the raw result object instead of the report
 */

import pg from "pg";
import { compareRoundRobinGame } from "../../artifacts/api-server/src/services/round-robin-comparison.ts";
import { RR_DB_TO_MARKET } from "../../artifacts/api-server/src/services/market-codes.ts";
import { getMarketResearchSelectionEligibility } from "../../lib/api-zod/src/market-research-eligibility.ts";
import { build } from "../../artifacts/api-server/node_modules/esbuild/lib/main.js";
import { gradeConstruction, summariseMarket } from "./audit-statistics.mjs";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};
const dateFlag = (name, fallback) => {
  const value = flag(name);
  if (value === null) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} takes YYYY-MM-DD.`);
  return value;
};

/** Dates are YYYY-MM-DD in America/New_York, the same as everywhere else here. */
function easternDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

const since = dateFlag("--since", "2000-01-01");
// Today's slate cannot be settled yet, so including it would only dilute.
const until = dateFlag("--until", easternDate(-1));
const ALL_BOARDS = ["RR1", "RR2", "RR3", "RR4", "RR5"];
const boardFlag = flag("--board");
if (boardFlag && !ALL_BOARDS.includes(boardFlag.toUpperCase())) {
  throw new Error("--board takes RR1, RR2, RR3, RR4 or RR5.");
}
const boards = boardFlag ? [boardFlag.toUpperCase()] : ALL_BOARDS;
const minSample = Number(flag("--min-sample") ?? 30);
if (!Number.isSafeInteger(minSample) || minSample <= 0) throw new Error("--min-sample takes a positive integer.");
const asJson = args.includes("--json");

const percent = (value) => (value === null || value === undefined || Number.isNaN(value) ? "  n/a" : `${(value * 100).toFixed(1)}%`);
const interval = (bounds) => (bounds === null ? "" : `[${(bounds[0] * 100).toFixed(0)}, ${(bounds[1] * 100).toFixed(0)}]`);

// ── The clause every section depends on ──────────────────────────────────────

/**
 * Settled truth, with corrections respected.
 *
 * `historical_outcomes` is append-only: a correction is a NEW row pointing at
 * the row it corrects, and the original is never updated. So current truth for
 * a player-game-market is the leaf of that chain, the row nothing else
 * references. Reading the table without this clause double counts every
 * corrected outcome and scores superseded rows as if they still stood.
 */
const SETTLED_LEAF = `
  ho.settlement_state = 'SETTLED'
  AND NOT EXISTS (SELECT 1 FROM historical_outcomes newer WHERE newer.correction_of = ho.outcome_id)`;

// ── Section A: coverage ──────────────────────────────────────────────────────

async function coverage(pool) {
  const settled = await pool.query(
    `SELECT ho.market,
            count(*)::int AS settled,
            count(*) FILTER (WHERE ho.outcome_hit)::int AS hits,
            count(DISTINCT ho.slate_date)::int AS slates,
            min(ho.slate_date)::text AS first_slate,
            max(ho.slate_date)::text AS last_slate,
            count(*) FILTER (WHERE ho.settled_without_snapshot)::int AS without_snapshot
       FROM historical_outcomes ho
      WHERE ${SETTLED_LEAF} AND ho.slate_date BETWEEN $1 AND $2
      GROUP BY ho.market
      ORDER BY ho.market`,
    [since, until],
  );

  const joined = await pool.query(
    `SELECT mrc.market,
            count(*)::int AS candidates,
            count(ho.outcome_id)::int AS graded
       FROM market_research_candidates mrc
       LEFT JOIN historical_outcomes ho
         ON ho.slate_date = mrc.slate_date AND ho.game_pk = mrc.game_pk
        AND ho.player_id = mrc.player_id AND ho.market = mrc.market
        AND ${SETTLED_LEAF}
      WHERE mrc.slate_date BETWEEN $1 AND $2
      GROUP BY mrc.market
      ORDER BY mrc.market`,
    [since, until],
  );

  return { settled: settled.rows, joined: joined.rows };
}

// ── Section B: does rank or state predict the outcome ────────────────────────

async function signal(pool) {
  const { rows } = await pool.query(
    `SELECT mrc.market, mrc.research_rank, mrc.research_state, ho.outcome_hit
       FROM market_research_candidates mrc
       JOIN historical_outcomes ho
         ON ho.slate_date = mrc.slate_date AND ho.game_pk = mrc.game_pk
        AND ho.player_id = mrc.player_id AND ho.market = mrc.market
      WHERE ${SETTLED_LEAF} AND mrc.slate_date BETWEEN $1 AND $2`,
    [since, until],
  );

  const byMarket = new Map();
  for (const row of rows) {
    const list = byMarket.get(row.market) ?? [];
    list.push({
      researchRank: row.research_rank,
      researchState: row.research_state,
      outcomeHit: row.outcome_hit,
    });
    byMarket.set(row.market, list);
  }

  return [...byMarket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([market, list]) => summariseMarket(market, list, minSample));
}

// ── Section C: replay the comparator against its own control group ───────────

/**
 * The pregame lineup policy, read from the service rather than restated.
 *
 * lineup-sources.ts imports the database handle, which a standalone script
 * cannot resolve, so it is bundled here with that one import stubbed. The point
 * is that the source precedence keeps exactly one home: writing FANTASYPROS and
 * PROJECTED into this file is precisely the defect Task 2.7 removed everywhere
 * else, and a research tool that drifts from the policy it is auditing is
 * measuring the wrong system.
 */
async function loadLineupPolicy() {
  const result = await build({
    entryPoints: ["artifacts/api-server/src/services/lineup-sources.ts"],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "db-stub",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "stub" }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export const pool = {}; export const db = {};", loader: "js",
        }));
      },
    }],
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("utf8");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return module.lineupSourceFilter(module.PREGAME_LINEUP_SOURCE_PRECEDENCE);
}

async function replayCandidates(pool, date, lineupFilter) {
  const { rows } = await pool.query(
    `WITH accepted AS (
       SELECT * FROM unnest($2::text[], $3::text[]) AS s(source_id, state)
     ),
     latest_lineup AS (
       SELECT DISTINCT ON (ls.game_pk, ls.team_id)
         ls.lineup_snapshot_id, ls.game_pk, ls.team_id, ls.state, ls.source_id
       FROM lineup_snapshots ls
       JOIN games g ON g.game_pk = ls.game_pk
       JOIN accepted a ON a.source_id = ls.source_id AND a.state = ls.state::text
       WHERE g.game_date = $1
       ORDER BY ls.game_pk, ls.team_id, array_position($2::text[], ls.source_id), ls.observed_at DESC
     )
     SELECT mrc.candidate_id, mrc.game_pk::bigint, mrc.player_id,
            COALESCE(p.full_name, 'Unknown') AS player_name, mrc.market,
            mrc.research_rank, mrc.research_state, mrc.primary_mechanism,
            mrc.bullpen_path_evidence, mrc.starter_matchup_evidence,
            mrc.missing_stale_evidence, ll.state AS lineup_state,
            CASE WHEN ll.team_id = g.away_team_id THEN 'AWAY' ELSE 'HOME' END AS side,
            CASE WHEN ll.team_id = g.away_team_id THEN away.abbreviation ELSE home.abbreviation END AS team,
            NOT EXISTS (
              SELECT 1 FROM player_eligibility pe
              WHERE pe.player_id = mrc.player_id AND pe.source_id = 'FANTASYPROS'
                AND pe.effective_date = mrc.slate_date AND pe.requires_identity_review
            ) AS identity_resolved
       FROM market_research_candidates mrc
       JOIN games g ON g.game_pk = mrc.game_pk
       JOIN teams away ON away.team_id = g.away_team_id
       JOIN teams home ON home.team_id = g.home_team_id
       JOIN latest_lineup ll ON ll.game_pk = mrc.game_pk
       JOIN lineup_entries le ON le.lineup_snapshot_id = ll.lineup_snapshot_id AND le.player_id = mrc.player_id
       LEFT JOIN players p ON p.player_id = mrc.player_id
      WHERE mrc.slate_date = $1`,
    [date, lineupFilter.sourceIds, lineupFilter.states],
  );

  return rows.map((row) => {
    const starterState = typeof row.starter_matchup_evidence?.starterState === "string"
      ? row.starter_matchup_evidence.starterState
      : "UNKNOWN";
    const eligibility = getMarketResearchSelectionEligibility({
      researchState: row.research_state,
      missingStaleEvidence: row.missing_stale_evidence,
      identityResolved: row.identity_resolved,
    });
    const starterResolved = !["UNKNOWN", "TBD"].includes(starterState);
    return {
      candidateId: row.candidate_id,
      gamePk: Number(row.game_pk),
      playerId: row.player_id,
      playerName: row.player_name,
      market: RR_DB_TO_MARKET[row.market] ?? row.market,
      researchRank: row.research_rank,
      researchState: row.research_state,
      side: row.side,
      team: row.team,
      // The current-date readiness gate is deliberately absent. See the header.
      selectable: starterResolved && eligibility.selectable,
      selectionBlockReason: starterResolved ? eligibility.selectionBlockReason : "BLOCKED",
      lineupState: row.lineup_state,
      starterState,
      // Neither field reaches compareConstruction; they appear only in the
      // prose evidence summary. So the replay does not pay for a per candidate
      // batter-versus-pitcher lookup to reproduce them.
      bvpStatus: "NOT_FOUND",
      bvpEvidence: null,
      arsenalStatus: "NOT_FOUND",
      evidenceFreshness: row.missing_stale_evidence ? "STALE" : "CURRENT",
      evidenceFreshnessDetail: row.missing_stale_evidence,
      primaryMechanism: row.primary_mechanism,
      opportunityEvidence: {},
      starterMatchupEvidence: row.starter_matchup_evidence ?? {},
      bullpenPathEvidence: row.bullpen_path_evidence ?? {},
      parkEvidence: {},
      counterEvidence: {},
    };
  });
}

async function comparator(pool, lineupFilter) {
  const slates = await pool.query(
    `SELECT DISTINCT slate_date::text AS slate_date
       FROM market_research_candidates
      WHERE slate_date BETWEEN $1 AND $2
      ORDER BY slate_date`,
    [since, until],
  );

  const outcomes = await pool.query(
    `SELECT ho.slate_date::text AS slate_date, ho.game_pk::bigint, ho.player_id, ho.market, ho.outcome_hit
       FROM historical_outcomes ho
      WHERE ${SETTLED_LEAF} AND ho.slate_date BETWEEN $1 AND $2`,
    [since, until],
  );
  const key = (slate, gamePk, playerId, market) => `${slate}|${gamePk}|${playerId}|${market}`;
  const settled = new Map(outcomes.rows.map((row) => [
    key(row.slate_date, Number(row.game_pk), row.player_id, RR_DB_TO_MARKET[row.market] ?? row.market),
    row.outcome_hit,
  ]));

  const results = boards.map((board) => ({
    board,
    games: 0,
    selected: 0,
    validTie: 0,
    noComparison: 0,
    // The paired subset: only games where BOTH sides offered a gradable
    // construction. Comparing every selected side against every rejected side
    // across different games would confound the comparator with the slate.
    paired: 0,
    pairedSelectedConverted: 0,
    pairedRejectedConverted: 0,
    pairedBothConverted: 0,
    pairedNeitherConverted: 0,
    ungradable: 0,
  }));
  const byBoard = new Map(results.map((entry) => [entry.board, entry]));

  for (const { slate_date: slate } of slates.rows) {
    const candidates = await replayCandidates(pool, slate, lineupFilter);
    if (!candidates.length) continue;
    const settledFor = (leg) => settled.get(key(slate, leg.gamePk, leg.playerId, leg.market));

    const games = new Map();
    for (const candidate of candidates) {
      const list = games.get(candidate.gamePk) ?? [];
      list.push(candidate);
      games.set(candidate.gamePk, list);
    }

    for (const [gamePk, gameCandidates] of games) {
      const away = gameCandidates.find((candidate) => candidate.side === "AWAY")?.team ?? "AWAY";
      const home = gameCandidates.find((candidate) => candidate.side === "HOME")?.team ?? "HOME";
      for (const board of boards) {
        const tally = byBoard.get(board);
        const comparison = compareRoundRobinGame(board, gamePk, away, home, gameCandidates, {});
        tally.games += 1;
        if (comparison.comparisonStatus === "SELECTED") tally.selected += 1;
        if (comparison.comparisonStatus === "VALID_TIE") tally.validTie += 1;
        if (comparison.comparisonStatus === "NO_COMPARISON") tally.noComparison += 1;
        if (!comparison.selectedSide) continue;

        const awayGrade = gradeConstruction(comparison.away.bestConstruction, settledFor);
        const homeGrade = gradeConstruction(comparison.home.bestConstruction, settledFor);
        if (!awayGrade.gradable || !homeGrade.gradable) {
          tally.ungradable += 1;
          continue;
        }

        const chosen = comparison.selectedSide === "AWAY" ? awayGrade : homeGrade;
        const rejected = comparison.selectedSide === "AWAY" ? homeGrade : awayGrade;
        tally.paired += 1;
        if (chosen.converted) tally.pairedSelectedConverted += 1;
        if (rejected.converted) tally.pairedRejectedConverted += 1;
        if (chosen.converted && rejected.converted) tally.pairedBothConverted += 1;
        if (!chosen.converted && !rejected.converted) tally.pairedNeitherConverted += 1;
      }
    }
  }

  return results;
}

// ── Section D: how exposed is the walk settlement assumption ─────────────────

async function walkPolicy(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS settled,
            count(*) FILTER (WHERE ho.outcome_hit)::int AS hits_current,
            count(*) FILTER (WHERE COALESCE(ho.walks, 0) - COALESCE(ho.intentional_walks, 0) >= 1)::int AS hits_excluding_ibb,
            count(*) FILTER (WHERE COALESCE(ho.walks, 0) + COALESCE(ho.hit_by_pitch, 0) >= 1)::int AS hits_including_hbp,
            count(*) FILTER (WHERE ho.walks IS NULL)::int AS missing_walks,
            count(*) FILTER (WHERE ho.intentional_walks IS NULL)::int AS missing_ibb,
            count(*) FILTER (WHERE ho.hit_by_pitch IS NULL)::int AS missing_hbp,
            count(DISTINCT ho.walk_definition)::int AS distinct_definitions
       FROM historical_outcomes ho
      WHERE ${SETTLED_LEAF} AND ho.market = 'BATTER_WALK' AND ho.slate_date BETWEEN $1 AND $2`,
    [since, until],
  );
  return rows[0];
}

// ── Report ───────────────────────────────────────────────────────────────────

function report(result) {
  const lines = [];
  const say = (text = "") => lines.push(text);

  say("MLB Analyst research audit");
  say(`Slate range ${since} to ${until}`);
  say("Read only. Calibration and settlement statistics; no pricing of any kind.");
  say();

  say("A. COVERAGE");
  say("-".repeat(78));
  if (!result.coverage.settled.length) {
    say("No settled outcomes in this range, so nothing below can be concluded.");
    say("Settle a slate first, or widen --since.");
    return lines.join("\n");
  }
  say("market                  settled    hits   slates  first        last         no snapshot");
  for (const row of result.coverage.settled) {
    say(`${row.market.padEnd(22)} ${String(row.settled).padStart(7)} ${String(row.hits).padStart(7)} `
      + `${String(row.slates).padStart(8)}  ${row.first_slate}   ${row.last_slate}   ${String(row.without_snapshot).padStart(6)}`);
  }
  say();
  say("candidates that reached a settled outcome:");
  for (const row of result.coverage.joined) {
    const share = row.candidates ? (row.graded / row.candidates) * 100 : 0;
    say(`  ${row.market.padEnd(22)} ${String(row.graded).padStart(7)} of ${String(row.candidates).padStart(7)}  (${share.toFixed(1)}%)`);
  }
  const total = result.coverage.settled.reduce((sum, row) => sum + row.settled, 0);
  say();
  say(total < minSample * 4
    ? `WARNING: ${total} settled rows in total, which is too few to separate signal from noise. `
      + "Read section B as a shape to watch, not a result."
    : `${total} settled rows in total.`);
  say();

  say("B. DOES THE RANK PREDICT THE OUTCOME");
  say("-".repeat(78));
  for (const market of result.signal) {
    say(`${market.market}   n=${market.n}   base hit rate ${percent(market.baseRate)}`);
    say(`  rank-order AUC ${market.rankAuc === null ? "n/a" : market.rankAuc.toFixed(3)} over ${market.rankedN} ranked rows`
      + "   (0.500 is no information)");
    say("  rank bucket        n     hits     rate    95% CI        lift");
    for (const bucket of market.buckets) {
      say(`  ${bucket.label.padEnd(14)} ${String(bucket.n).padStart(6)} ${String(bucket.hits).padStart(7)}   `
        + `${percent(bucket.rate)}  ${interval(bucket.wilson).padEnd(12)} `
        + `${bucket.lift === null ? "" : `${bucket.lift.toFixed(2)}x`}${bucket.thin ? "  (thin)" : ""}`);
    }
    say("  research state     n     hits     rate    95% CI");
    for (const state of market.states) {
      say(`  ${state.state.padEnd(14)} ${String(state.n).padStart(6)} ${String(state.hits).padStart(7)}   `
        + `${percent(state.rate)}  ${interval(state.wilson).padEnd(12)}${state.thin ? "  (thin)" : ""}`);
    }
    if (market.withinState.length) {
      say("  rank AUC holding state fixed (does rank add anything after state):");
      for (const entry of market.withinState) {
        say(`    ${entry.state.padEnd(12)} n=${String(entry.n).padStart(6)}   AUC ${entry.auc.toFixed(3)}`);
      }
    }
    say();
  }

  say("C. DOES THE COMPARATOR BEAT THE SIDE IT REJECTED");
  say("-".repeat(78));
  say("board  games  selected  ties  no comp  ungrad  paired  chosen won  rejected won  both  neither");
  for (const row of result.comparator) {
    say(`${row.board.padEnd(6)} ${String(row.games).padStart(6)} ${String(row.selected).padStart(9)} `
      + `${String(row.validTie).padStart(5)} ${String(row.noComparison).padStart(8)} ${String(row.ungradable).padStart(7)} `
      + `${String(row.paired).padStart(7)} ${String(row.pairedSelectedConverted).padStart(11)} `
      + `${String(row.pairedRejectedConverted).padStart(13)} ${String(row.pairedBothConverted).padStart(5)} `
      + `${String(row.pairedNeitherConverted).padStart(8)}`);
  }
  say();
  for (const row of result.comparator) {
    if (row.paired < minSample) {
      say(`${row.board}: ${row.paired} paired games, below the ${minSample} threshold. No verdict.`);
      continue;
    }
    const discordant = row.paired - row.pairedBothConverted - row.pairedNeitherConverted;
    say(`${row.board}: chosen ${percent(row.pairedSelectedConverted / row.paired)} `
      + `vs rejected ${percent(row.pairedRejectedConverted / row.paired)} over ${row.paired} paired games. `
      + `${discordant} where exactly one side converted, which is the only subset that can judge the comparator.`);
  }
  say();
  say("A tie count that is a large share of games means the evidence terms are too");
  say("coarse to separate real candidates, not that the two sides are genuinely equal.");
  say();

  say("D. WALK SETTLEMENT POLICY EXPOSURE");
  say("-".repeat(78));
  const walk = result.walkPolicy;
  if (!walk || walk.settled === 0) {
    say("No settled BATTER_WALK rows in this range.");
  } else {
    say(`settled walk rows                      ${walk.settled}`);
    say(`hits under the current policy (BB)     ${walk.hits_current}`);
    say(`hits if intentional walks excluded     ${walk.hits_excluding_ibb}   (${walk.hits_current - walk.hits_excluding_ibb} rows would flip)`);
    say(`hits if hit by pitch counted           ${walk.hits_including_hbp}   (${walk.hits_including_hbp - walk.hits_current} rows would flip)`);
    say(`rows missing walks / ibb / hbp         ${walk.missing_walks} / ${walk.missing_ibb} / ${walk.missing_hbp}`);
    say(`distinct walk_definition values        ${walk.distinct_definitions}`);
    say();
    say("This measures exposure, not correctness. Which definition is right is the");
    say("operator's settlement rule at the book, which this system does not model.");
    say("Both alternatives recompute from stored columns, so a policy change is a");
    say("re-grade rather than a refetch.");
  }

  return lines.join("\n");
}

// ── Entry point ──────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const lineupFilter = await loadLineupPolicy();
  const result = {
    since,
    until,
    coverage: await coverage(pool),
    signal: await signal(pool),
    comparator: await comparator(pool, lineupFilter),
    walkPolicy: await walkPolicy(pool),
  };
  console.log(asJson ? JSON.stringify(result, null, 2) : report(result));
} finally {
  await pool.end();
}
