/**
 * Runs the REAL instagram-mcp-server production code over stdio, with only
 * the outbound HTTP layer faked (see fetch-stub.mjs). This is what
 * promptfoo actually spawns now, replacing the old hand-written mock.
 *
 * Fake credentials are fine here — they're never sent anywhere real,
 * since fetch itself is intercepted before any request leaves the process.
 */
import { installFetchStub } from "./fetch-stub.mjs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

process.env.INSTAGRAM_ACCESS_TOKEN ??= "fake-token-for-evals-only";
process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ??= "fake-account-id";
process.env.INSTAGRAM_TOKEN_TYPE ??= "facebook_page";

installFetchStub();

// Import the REAL production server module. Path assumes this evals/ folder
// sits directly inside the instagram-mcp-server repo root, next to src/.
const { server } = await import("../src/index.ts");

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("REAL instagram-mcp-server running on stdio (fetch stubbed)");
