import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { Cache } from "./core/cache.js";
import { INSTRUCTIONS } from "./core/instructions.js";
import { registerPrompts } from "./core/prompts.js";
import { SleeperClient } from "./core/sleeper.js";
import { registerTools } from "./core/tools.js";
import type { Store } from "./storage/types.js";

export function createMcpServer(cache: Cache): McpServer {
  const server = new McpServer({ name: "fantasy-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, new SleeperClient(cache), cache);
  registerPrompts(server);
  return server;
}

/**
 * Host-agnostic HTTP app (Hono runs on Node, Cloudflare Workers, Vercel, ...).
 * Stateless: a fresh MCP server per request; the cache is what persists.
 */
export function createApp(store: Store): Hono {
  const cache = new Cache(store);
  const app = new Hono();

  app.get("/", (c) => c.text("fantasy-mcp is running. MCP endpoint: /mcp"));

  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(cache);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
