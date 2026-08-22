const baseUrl = (process.env.API_BASE_URL ?? "http://127.0.0.1:8080/api").replace(/\/$/, "");
const requestsPerEndpoint = Number(process.env.LOAD_TEST_REQUESTS ?? 24);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 6);
const p95SlaMs = Number(process.env.LOAD_TEST_P95_MS ?? 500);
const date = new Date().toISOString().slice(0, 10);
const endpoints = [
  "/healthz",
  `/analyst/today?date=${date}`,
  `/analyst/bullpen-room?date=${date}`,
  `/analyst/market-board?date=${date}`,
  `/analyst/market-board/game-summary?date=${date}`,
];

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

async function request(path, index) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "x-request-id": `load-${index}-${crypto.randomUUID()}` },
  });
  const durationMs = performance.now() - startedAt;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  await response.arrayBuffer();
  return { path, durationMs };
}

// The SLA applies to sustained traffic after the documented warm-service
// startup. Populate each bounded read-through cache once before measuring it.
for (const path of endpoints) await request(path, "warmup");

const jobs = endpoints.flatMap((path) => Array.from({ length: requestsPerEndpoint }, (_, index) => () => request(path, index)));
const durations = new Map(endpoints.map((path) => [path, []]));
let cursor = 0;
const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const result = await job();
    durations.get(result.path).push(result.durationMs);
  }
});

await Promise.all(workers);
const report = Object.fromEntries([...durations.entries()].map(([path, values]) => [
  path,
  { requests: values.length, p50Ms: Number(percentile(values, 0.5).toFixed(1)), p95Ms: Number(percentile(values, 0.95).toFixed(1)) },
]));
const failing = Object.entries(report).filter(([, metrics]) => metrics.p95Ms >= p95SlaMs);
console.log(JSON.stringify({ baseUrl, concurrency, p95SlaMs, endpoints: report }, null, 2));
if (failing.length) {
  throw new Error(`Read SLA failed: ${failing.map(([path, metrics]) => `${path} p95=${metrics.p95Ms}ms`).join(", ")}`);
}