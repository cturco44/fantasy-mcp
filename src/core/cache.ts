import type { Store } from "../storage/types.js";

interface Entry<T> {
  at: number;
  value: T;
}

/**
 * Read-through cache: an in-process layer (avoids re-parsing big payloads)
 * in front of the persistent Store. If a refresh fails, serve stale data
 * rather than failing the tool call.
 */
export class Cache {
  private hot = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private store: Store) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    let entry = this.hot.get(key) as Entry<T> | undefined;
    if (!entry) {
      entry = await this.store.get<Entry<T>>(key);
      if (entry) this.hot.set(key, entry);
    }
    if (entry && now - entry.at < ttlMs) return entry.value;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const refresh = (async () => {
      try {
        const value = await load();
        const fresh = { at: Date.now(), value };
        this.hot.set(key, fresh);
        await this.store.put(key, fresh);
        return value;
      } catch (err) {
        if (entry) return entry.value;
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, refresh);
    return refresh;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
