type CacheEntry = { expiresAt: number; value: unknown };
const entries = new Map<string, CacheEntry>();

export async function readThroughCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function invalidateCache(prefix: string) {
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}

export const CACHE_POLICY = {
  marketBoard: 30_000,
  gameSummary: 30_000,
  labs: 60_000,
  bullpen: 30_000,
} as const;