/**
 * Minimal key/value storage used for caching. Implementations: in-memory,
 * local files (dev), and later Cloudflare KV. Tools never know which one.
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
