import { serve } from "@hono/node-server";
import { authConfigFromEnv, withAuth } from "../auth/index.js";
import { createApp } from "../server.js";
import { FileStore } from "../storage/file.js";
import { GcsStore } from "../storage/gcs.js";
import type { Store } from "../storage/types.js";

function fatal(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// K_SERVICE is set by Cloud Run. The local fallbacks below exist only for testing off Cloud Run.
const onCloudRun = Boolean(process.env.K_SERVICE);
const authDisabled = process.env.AUTH_DISABLED === "1";
if (authDisabled && onCloudRun) fatal("AUTH_DISABLED=1 is not allowed on Cloud Run");

let store: Store;
if (process.env.CACHE_BUCKET) {
  store = new GcsStore(process.env.CACHE_BUCKET);
} else if (onCloudRun) {
  fatal("Missing required env var: CACHE_BUCKET");
} else {
  store = new FileStore(process.env.CACHE_DIR ?? ".cache");
}

let app = createApp(store);
if (authDisabled) {
  console.warn("AUTH DISABLED (local dev only): /mcp is open");
} else {
  try {
    app = withAuth(app, authConfigFromEnv());
  } catch (err) {
    fatal((err as Error).message);
  }
}

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => console.log(`fantasy-mcp listening on :${port}`));
