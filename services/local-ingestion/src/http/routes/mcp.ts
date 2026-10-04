import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppServices } from "../app.js";
import { requireMcpToken } from "../auth.js";
import { agentTools, runAgentTool, type AgentToolDeps } from "../../domains/agent/tools.js";
import { UsageTracker } from "../../domains/organize/runtime-types.js";

/** Stateless Streamable HTTP: a fresh server + transport per request; business sessions are organize runs (`run_id`). */
export function registerMcpRoutes(app: Hono, services: AppServices): void {
  const { appDb, auth, aiGateway } = services;

  app.all("/mcp", requireMcpToken(auth), async (c) => {
    const deps: AgentToolDeps = {
      db: appDb.db,
      indexCtx: aiGateway
        ? { db: appDb.db, searchIndex: services.searchIndex ?? null, llm: { gateway: aiGateway, usage: new UsageTracker(), allowOverLimit: false } }
        : null,
      now: () => new Date()
    };
    const server = new McpServer({ name: "study-studio", version: "1.0.0" });
    for (const tool of agentTools()) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (input: unknown) => {
        const result = await runAgentTool(tool, deps, input);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], ...(result.ok ? {} : { isError: true }) };
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
