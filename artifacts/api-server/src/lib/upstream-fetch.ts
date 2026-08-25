/**
 * The single outbound call used by every ingest path.
 *
 * Risk report S-21. Fourteen provider calls across research-, data- and
 * weather-foundation used bare `fetch`, and bare `fetch` has no timeout: if
 * Baseball Savant, FanGraphs, statsapi or the weather provider accepted the
 * connection and then stopped sending, the await never settled. The ingest run
 * stayed RUNNING, the refresh request held its connection until the proxy cut
 * it (S-20), and the operator saw a failed refresh over work that was still
 * notionally in flight. Only the AI tool gateway bounded its own call.
 *
 * A bounded call turns that hang into an ordinary FAILED run with a readable
 * reason, which the ingest_runs row and Data Health can then report.
 */

/** Wall-clock ceiling for one upstream request, including a slow body read. */
export function resolveUpstreamTimeoutMs(value = process.env.UPSTREAM_FETCH_TIMEOUT_MS) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 60_000;
  return Math.min(Math.max(Number.isSafeInteger(parsed) ? parsed : 60_000, 1_000), 300_000);
}

const DEFAULT_TIMEOUT_MS = resolveUpstreamTimeoutMs();

export class UpstreamTimeoutError extends Error {
  constructor(endpoint: string | URL, timeoutMs: number) {
    super(`Upstream request to ${safeHost(endpoint)} exceeded ${timeoutMs}ms and was aborted`);
    this.name = "UpstreamTimeoutError";
  }
}

/**
 * The host only. A Statcast Search URL carries the whole query in its path, and
 * that lands in ingest_runs.error_message, which the UI renders.
 */
function safeHost(endpoint: string | URL) {
  try {
    return new URL(endpoint).host;
  } catch {
    return "upstream provider";
  }
}

export async function upstreamFetch(
  endpoint: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  // A caller-supplied signal still wins; the timeout is an additional bound,
  // never a replacement for a cancellation the caller already owns.
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(endpoint, { ...init, signal });
  } catch (error) {
    if (timeout.aborted) throw new UpstreamTimeoutError(endpoint, timeoutMs);
    throw error;
  }
}
