import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./types.js";

/** Local-dev store: one JSON file per key under `dir`. Node only. */
export class FileStore implements Store {
  constructor(private dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async put(key: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(key), JSON.stringify(value));
  }
}
