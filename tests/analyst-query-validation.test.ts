import assert from "node:assert/strict";
import test from "node:test";
import { bundleService } from "./helpers/bundle.ts";

const shared = bundleService("artifacts/api-server/src/routes/analyst/shared.ts");
const cache = bundleService("artifacts/api-server/src/services/cache.ts");

type SharedValidators = {
  requestedDate: (value: unknown) => string;
  requestedWindow: (value: unknown) => string;
  requestedPlayerId: (value: unknown) => number | null;
  requestedLabSearch: (value: unknown) => string;
};

function assertValidationError(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => (
    error instanceof Error
    && (error as Error & { code?: string }).code === code
  ));
}

test("analyst lab query validators accept only real dates and supported windows", async () => {
  const { requestedDate, requestedWindow } = await shared as SharedValidators;

  assert.equal(requestedDate("2026-02-28"), "2026-02-28");
  assertValidationError(() => requestedDate("2026-02-30"), "INVALID_DATE");
  assertValidationError(() => requestedDate("2026-2-3"), "INVALID_DATE");
  assertValidationError(() => requestedDate("null"), "INVALID_DATE");
  assert.equal(requestedWindow("ROLLING_30"), "ROLLING_30");
  assertValidationError(() => requestedWindow("LAST_MONTH"), "INVALID_WINDOW");
  assertValidationError(() => requestedWindow("undefined"), "INVALID_WINDOW");
});

test("analyst lab query validators reject null-like and non-positive identity inputs", async () => {
  const { requestedPlayerId, requestedLabSearch } = await shared as SharedValidators;

  assert.equal(requestedPlayerId(undefined), null);
  assert.equal(requestedPlayerId("660271"), 660271);
  assertValidationError(() => requestedPlayerId("0"), "INVALID_PLAYER_ID");
  assertValidationError(() => requestedPlayerId("4.2"), "INVALID_PLAYER_ID");
  assertValidationError(() => requestedPlayerId("null"), "INVALID_PLAYER_ID");
  assert.equal(requestedLabSearch("  Aaron Judge  "), "Aaron Judge");
  assertValidationError(() => requestedLabSearch("undefined"), "INVALID_SEARCH");
  assertValidationError(() => requestedLabSearch(["Aaron Judge"]), "INVALID_SEARCH");
});

test("lab cache invalidation prevents an older in-flight response from becoming fresh again", async () => {
  const { readThroughCache, invalidateCache } = await cache as {
    readThroughCache: <T>(key: string, ttlMs: number, load: () => Promise<T>) => Promise<T>;
    invalidateCache: (prefix: string) => void;
  };
  let releaseOldLoad: (value: string) => void = () => undefined;
  const oldLoad = new Promise<string>((resolve) => { releaseOldLoad = resolve; });

  const staleRequest = readThroughCache("player-lab:cache-race", 10_000, () => oldLoad);
  invalidateCache("player-lab:");
  const freshRequest = readThroughCache("player-lab:cache-race", 10_000, async () => "fresh");
  releaseOldLoad("stale");

  assert.equal(await staleRequest, "stale");
  assert.equal(await freshRequest, "fresh");
  assert.equal(await readThroughCache("player-lab:cache-race", 10_000, async () => "unexpected"), "fresh");
});