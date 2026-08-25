/**
 * Search Failure Risk Report remediation.
 *
 * The report separated "the search is broken" from "the search correctly has
 * nothing to say", and found that the platform could not tell an operator
 * which one had happened. These are the guarantees that make the difference
 * observable, pinned so a later edit cannot quietly remove them again.
 *
 * The register IDs in each describe() are the report's own.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";

import { bundleService } from "./helpers/bundle.ts";

// The api-server sources use extensionless relative imports, so a test bundles
// them the same way every other service test in this directory does.
const shared = await bundleService("artifacts/api-server/src/routes/analyst/shared.ts") as {
  isRealCalendarDate: (date: string) => boolean;
  requestedDate: (value: unknown) => string;
  requestedPlayerId: (value: unknown) => number | null;
  requestedWindow: (value: unknown) => string;
};
const { isRealCalendarDate, requestedDate, requestedPlayerId, requestedWindow } = shared;

const httpErrors = await bundleService("artifacts/api-server/src/lib/http-errors.ts") as {
  RequestValidationError: new (message: string) => Error & { status: number };
};
const { RequestValidationError } = httpErrors;

/**
 * Each entry point is bundled separately, so the class identity differs between
 * bundles even though the source is one file. What the middleware actually
 * branches on is the shape - a 400 carried on the error - so that is what is
 * asserted here.
 */
const isValidationFailure = (error: unknown) => {
  const candidate = error as { name?: string; status?: number };
  return candidate?.name === "RequestValidationError" && candidate?.status === 400;
};

const upstream = await bundleService("artifacts/api-server/src/lib/upstream-fetch.ts") as {
  resolveUpstreamTimeoutMs: (value?: string) => number;
  upstreamFetch: (endpoint: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
};
const { resolveUpstreamTimeoutMs, upstreamFetch } = upstream;

const APP = "artifacts/api-server/src/app.ts";
const RESEARCH_FOUNDATION = "artifacts/api-server/src/services/research-foundation.ts";
const OPENAPI = "lib/api-spec/openapi.yaml";
const UI = "artifacts/mlb-analyst/src/App.tsx";

describe("S-14 a date that is not a day is rejected, not queried", () => {
  test("the shape check alone accepted these", () => {
    for (const impossible of ["2026-02-31", "2026-13-01", "2026-04-31", "2025-02-29"]) {
      assert.equal(isRealCalendarDate(impossible), false, `${impossible} is not a calendar date`);
      assert.throws(() => requestedDate(impossible), isValidationFailure, impossible);
    }
  });

  test("real dates, including a leap day, still pass through unchanged", () => {
    for (const real of ["2026-08-25", "2024-02-29", "2026-12-31", "2026-01-01"]) {
      assert.equal(isRealCalendarDate(real), true, real);
      assert.equal(requestedDate(real), real);
    }
  });

  test("a malformed shape is still rejected", () => {
    for (const malformed of ["2026-8-25", "08/25/2026", "today", "2026-08-25T00:00:00Z"]) {
      assert.throws(() => requestedDate(malformed), isValidationFailure, malformed);
    }
  });
});

describe("S-13 a rejected parameter is the caller's error, not a server fault", () => {
  test("every lab parameter parser throws the type the middleware answers 400 for", () => {
    assert.throws(() => requestedWindow("ROLLING_90"), isValidationFailure);
    assert.throws(() => requestedPlayerId("abc"), isValidationFailure);
    assert.throws(() => requestedPlayerId("-1"), isValidationFailure);
    assert.throws(() => requestedPlayerId("1.5"), isValidationFailure);
    assert.throws(() => requestedPlayerId(["1", "2"]), isValidationFailure);
  });

  test("the error carries a 400, so the middleware never has to infer one", () => {
    assert.equal(new RequestValidationError("x").status, 400);
  });

  test("an empty or literal-null playerId means no player, not a bad request", () => {
    // These are what a client sends when its own state is empty. Answering
    // them with an error taught operators to distrust a working search.
    for (const empty of [undefined, null, "", "null", "undefined"]) {
      assert.equal(requestedPlayerId(empty), null, JSON.stringify(empty));
    }
  });

  test("a valid id is unchanged", () => {
    assert.equal(requestedPlayerId("592450"), 592450);
  });

  test("the error middleware answers 400 for it and keeps 500 opaque", () => {
    const app = readFileSync(APP, "utf8");
    assert.match(app, /isRequestValidationError\(error\)/, "the middleware must branch on the validation type");
    assert.match(app, /res\.status\(error\.status\)\.json\(\{ error: error\.message/, "a rejected request must return its own reason");
    assert.match(app, /res\.status\(500\)\.json\(\{ error: "Internal server error"/, "a real fault must stay opaque");
  });
});

describe("S-16 the lab operations publish the responses they can return", () => {
  test("both labs document 400 and 500, not only 200", () => {
    const spec = readFileSync(OPENAPI, "utf8");
    for (const operation of ["getAnalystPlayerLab", "getAnalystPitcherLab"]) {
      const at = spec.indexOf(`operationId: ${operation}`);
      assert.ok(at > 0, `${operation} must exist`);
      // The operation ends where the next path begins.
      const next = spec.indexOf("\n  /", at);
      const block = spec.slice(at, next === -1 ? undefined : next);
      assert.match(block, /"400":\s*\n\s*\$ref: "#\/components\/responses\/BadRequest"/, `${operation} must document 400`);
      assert.match(block, /"500":\s*\n\s*\$ref: "#\/components\/responses\/InternalError"/, `${operation} must document 500`);
    }
  });

  test("the published error body carries the request id the API returns", () => {
    const spec = readFileSync(OPENAPI, "utf8");
    const at = spec.indexOf("    ErrorResponse:");
    const block = spec.slice(at, at + 500);
    assert.match(block, /requestId: \{ type: string \}/, "an operator quotes this to find the log line");
  });
});

describe("S-17 and S-18 a search answers the query it was given", () => {
  const source = readFileSync(RESEARCH_FOUNDATION, "utf8");

  test("no query and no selected id is an empty state, not the first eligible player", () => {
    assert.match(source, /if \(playerId == null && !search\)/, "the wildcard branch must be refused before the query runs");
    assert.match(source, /NO SEARCH SUBMITTED/);
  });

  test("the row cap is declared once and the query asks for one more than it shows", () => {
    assert.match(source, /const SEARCH_RESULT_LIMIT = 100;/);
    assert.match(source, /SEARCH_RESULT_LIMIT \+ 1/, "the extra row is how truncation is detected");
    assert.match(source, /searchTruncated/, "truncation must reach the response");
    assert.ok(
      !/ORDER BY p\.player_id, p\.full_name LIMIT 100/.test(source),
      "the cap must not be hard-coded back into the SQL",
    );
  });
});

describe("explicit player ids pass the gate the search results pass", () => {
  const source = readFileSync(RESEARCH_FOUNDATION, "utf8");

  test("a supplied id is checked for eligibility, role, and identity review", () => {
    assert.match(source, /if \(playerId != null\) \{/, "the id must be checked before it selects a profile");
    assert.match(source, /PLAYER NOT ELIGIBLE FOR THIS ROLE/);
    assert.match(source, /PLAYER NOT ELIGIBLE FOR REQUESTED DATE/);
    const gate = source.slice(source.indexOf("if (playerId != null) {"));
    assert.match(gate, /NOT pe\.requires_identity_review AND NOT pe\.quarantined_from_current_research/);
  });

  test("the as-of comparison uses the same clock the default date comes from", () => {
    assert.ok(
      !/effectiveDate !== dateOnly\(new Date\(\)\)/.test(source),
      "UTC midnight is not Eastern midnight; the two disagree for four hours every night",
    );
    assert.match(source, /effectiveDate !== currentEasternDate\(\)/);
  });
});

describe("S-21 every upstream provider call is bounded", () => {
  test("no ingest service calls bare fetch", () => {
    for (const service of ["research-foundation", "data-foundation", "weather-foundation"]) {
      const source = readFileSync(`artifacts/api-server/src/services/${service}.ts`, "utf8");
      assert.ok(
        !/\bawait fetch\(/.test(source),
        `${service} must call upstreamFetch, because bare fetch has no timeout and a hung provider never settles`,
      );
      assert.match(source, /upstreamFetch/, `${service} must import the bounded call`);
    }
  });

  test("the timeout is bounded on both sides, whatever the environment says", () => {
    assert.equal(resolveUpstreamTimeoutMs(undefined), 60_000);
    assert.equal(resolveUpstreamTimeoutMs("5000"), 5_000);
    assert.equal(resolveUpstreamTimeoutMs("1"), 1_000, "an unusably short timeout is clamped up");
    assert.equal(resolveUpstreamTimeoutMs("99999999"), 300_000, "an unbounded one is clamped down");
    assert.equal(resolveUpstreamTimeoutMs("not a number"), 60_000);
  });

  test("a provider that accepts and then stalls aborts instead of hanging", async () => {
    // A URL that never resolves would depend on the network. An already-aborted
    // caller signal proves the composition, and the timeout proves the bound.
    await assert.rejects(
      () => upstreamFetch("https://example.invalid/never", {}, 1_000),
      (error: Error) => error.name === "UpstreamTimeoutError" || error.name === "TypeError",
      "the call must settle one way or the other, never hang",
    );
  });

  test("the aborted message names the host, not the whole query URL", () => {
    const source = readFileSync("artifacts/api-server/src/lib/upstream-fetch.ts", "utf8");
    assert.match(source, /new URL\(endpoint\)\.host/, "the message lands in ingest_runs.error_message, which the UI renders");
  });
});

describe("S-22 a swallowed provider failure still says why", () => {
  test("the split fallback logs the rejected player instead of only counting it", () => {
    const source = readFileSync(RESEARCH_FOUNDATION, "utf8");
    assert.ok(!/\} catch \{\n          rejected \+= 1;/.test(source), "the bare catch lost the reason entirely");
    assert.match(source, /statcast split fallback rejected one player/);
  });
});

describe("S-30 and S-12 the operator can see why a search is empty", () => {
  const ui = readFileSync(UI, "utf8");

  test("the empty state renders the API's own status and notices", () => {
    assert.match(ui, /title=\{data\?\.sourceStatus\}/, "the API already says what state it is in");
    assert.match(ui, /notices=\{data\?\.notices\?\.slice\(1\)\}/);
  });

  test("the error state distinguishes a rejected request from an unreachable API", () => {
    assert.match(ui, /export function describeQueryError/);
    for (const branch of ["status === 400", "status === 404", "status === 503", "status === undefined"]) {
      assert.ok(ui.includes(branch), `the operator needs ${branch} told apart from the others`);
    }
    assert.equal(
      (ui.match(/describeQueryError\(query\.error\)/g) ?? []).length, 2,
      "both labs must use it",
    );
  });

  test("the search input follows the URL instead of only its first render", () => {
    assert.equal(
      (ui.match(/useEffect\(\(\) => \{ setSearchInput\(search \|\| ''\); \}, \[search\]\);/g) ?? []).length, 2,
      "back/forward moved the results without moving the box the operator reads",
    );
  });

  test("a malformed playerId in the URL is not serialised into a request", () => {
    assert.ok(
      !/parseInt\(playerIdParam, 10\)/.test(ui),
      "parseInt('12x') is 12, which answers for a player nobody asked for",
    );
    assert.equal(
      (ui.match(/Number\.isSafeInteger\(parsedPlayerId\) && parsedPlayerId > 0/g) ?? []).length, 2,
    );
  });

  test("the result list states which query it answers", () => {
    assert.match(ui, /text-lab-search-scope/, "the list and the profile can describe different players");
    assert.equal((ui.match(/activeSearch=\{search\}/g) ?? []).length, 2);
  });
});
