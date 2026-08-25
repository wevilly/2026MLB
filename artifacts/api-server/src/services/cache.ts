type CacheEntry = { expiresAt: number; value: unknown; accessedAt: number };
const entries = new Map<string, CacheEntry>();
const pendingLoads = new Map<string, Promise<unknown>>();
const invalidationGenerations = new Map<string, number>();

export function resolveCacheMaxEntries(value = process.env.API_CACHE_MAX_ENTRIES) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 500;
  return Math.min(Math.max(Number.isSafeInteger(parsed) ? parsed : 500, 50), 5_000);
}

const MAX_ENTRIES = resolveCacheMaxEntries();

function removeExpiredEntries(now = Date.now()) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

function enforceCapacity() {
  if (entries.size < MAX_ENTRIES) return;
  const oldest = [...entries.entries()].sort(([, left], [, right]) => left.accessedAt - right.accessedAt)
    .slice(0, Math.max(1, entries.size - MAX_ENTRIES + 1));
  for (const [key] of oldest) entries.delete(key);
}

export async function readThroughCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) {
    hit.accessedAt = now;
    return hit.value as T;
  }
  if (hit) entries.delete(key);

  const pending = pendingLoads.get(key);
  if (pending) return pending as Promise<T>;

  const requestGeneration = invalidationGenerations.get(key) ?? 0;
  let request: Promise<T>;
  request = load()
    .then((value) => {
      if ((invalidationGenerations.get(key) ?? 0) === requestGeneration) {
        removeExpiredEntries();
        enforceCapacity();
        entries.set(key, { value, expiresAt: Date.now() + ttlMs, accessedAt: Date.now() });
      }
      return value;
    })
    .finally(() => {
      if (pendingLoads.get(key) === request) pendingLoads.delete(key);
    });
  pendingLoads.set(key, request);
  return request;
}

export function invalidateCache(prefix: string) {
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
  for (const key of pendingLoads.keys()) {
    if (!key.startsWith(prefix)) continue;
    invalidationGenerations.set(key, (invalidationGenerations.get(key) ?? 0) + 1);
    pendingLoads.delete(key);
  }
}

export function cacheStatus() {
  removeExpiredEntries();
  return { entries: entries.size, pendingLoads: pendingLoads.size, maxEntries: MAX_ENTRIES };
}

export const CACHE_POLICY = {
  marketBoard: 30_000,
  gameSummary: 30_000,
  labs: 60_000,
  bullpen: 30_000,
} as const;