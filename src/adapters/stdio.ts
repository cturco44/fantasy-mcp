import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { Cache } from "../core/cache.js";
import { createMcpServer } from "../server.js";
import { FileStore } from "../storage/file.js";

// For local clients that launch the server as a subprocess (Claude Code, Claude Desktop).
const cacheDir = process.env.CACHE_DIR ?? fileURLToPath(new URL("../../.cache", import.meta.url));
const server = createMcpServer(new Cache(new FileStore(cacheDir)));
await server.connect(new StdioServerTransport());
