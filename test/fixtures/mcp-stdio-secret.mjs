import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({ name: "stdio-fixture", version: "1.0.0" });
server.registerTool(
  "secret_echo",
  { description: "Returns the configured fixture secret", inputSchema: {} },
  async () => ({
    content: [{ type: "text", text: process.env.TEST_MCP_SECRET ?? "missing" }],
  }),
);
await server.connect(new StdioServerTransport());
