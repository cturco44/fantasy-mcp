import { serve } from "@hono/node-server";
import { createApp } from "../server.js";
import { FileStore } from "../storage/file.js";

const port = Number(process.env.PORT ?? 8787);
const app = createApp(new FileStore(process.env.CACHE_DIR ?? ".cache"));

serve({ fetch: app.fetch, port }, () => {
  console.log(`fantasy-mcp listening on http://localhost:${port}/mcp`);
});
