/**
 * Public surface for non-MCP consumers (e.g. web app importing via the
 * `@instagram-mcp/lib` webpack alias).
 */
export * from "./insights.js";
export { InstagramClient, InstagramApiError, createClient } from "../client.js";
export type { Credentials, GraphApiError } from "../client.js";
