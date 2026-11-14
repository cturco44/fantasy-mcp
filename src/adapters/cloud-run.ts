import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "../server.js";
import { GcsStore } from "../storage/gcs.js";

const bucket = process.env.CACHE_BUCKET;
if (!bucket) {
  console.error("Missing required env var: CACHE_BUCKET");
  process.exit(1);
}

const store = new GcsStore(bucket);

// Prove storage works at startup (visible in logs); never blocks or crashes the server.
void (async () => {
  await store.put("_startup_probe", { at: new Date().toISOString() });
  const back = await store.get<{ at: string }>("_startup_probe");
  console.log(back ? `storage OK (bucket ${bucket})` : `storage FAILED (bucket ${bucket})`);
})();

// TEMPORARY LOCKDOWN until the auth layer (docs/deploy-cloud-run.md §3) exists:
// /mcp is refused entirely so nothing is ever publicly usable.
const app = new Hono();
app.all("/mcp", (c) => c.text("MCP endpoint disabled until auth is enabled", 503));
app.route("/", createApp(store));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => console.log(`fantasy-mcp listening on :${port}`));
