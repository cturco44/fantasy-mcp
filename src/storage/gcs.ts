import { Storage } from "@google-cloud/storage";
import type { Store } from "./types.js";

/**
 * Cloud Storage store: one object per key in a single bucket. On Cloud Run it authenticates as the
 * service's identity. The cache must never fail a tool call because storage hiccupped, so every
 * error is logged and swallowed.
 */
export class GcsStore implements Store {
  private bucket;

  constructor(bucketName: string) {
    this.bucket = new Storage().bucket(bucketName);
  }

  private file(key: string) {
    return this.bucket.file(`${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const [buf] = await this.file(key).download();
      return JSON.parse(buf.toString("utf8")) as T;
    } catch (err) {
      if ((err as { code?: number }).code !== 404) console.error(`gcs get ${key} failed:`, err);
      return undefined;
    }
  }

  async put(key: string, value: unknown): Promise<void> {
    try {
      await this.file(key).save(JSON.stringify(value), { contentType: "application/json", resumable: false });
    } catch (err) {
      console.error(`gcs put ${key} failed:`, err);
    }
  }
}
