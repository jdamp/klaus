import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({ name: "stdio-fixture", version: "1.0.0" });
server.registerTool(
  "secret_echo",
  { description: "Returns the configured fixture secret", inputSchema: {} },
  async () => ({
    content: [
      {
        type: "text",
        text: `${process.env.TEST_MCP_SECRET ?? "missing"} pid=${process.pid}`,
      },
    ],
  }),
);
server.registerTool(
  "slow_echo",
  { description: "Returns after a delay", inputSchema: {} },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return { content: [{ type: "text", text: "slow result" }] };
  },
);
server.registerTool(
  "error_echo",
  {
    description: "Returns an MCP error result containing the configured fixture secret",
    inputSchema: {},
  },
  async () => ({
    isError: true,
    content: [{ type: "text", text: `Rejected ${process.env.TEST_MCP_SECRET ?? "missing"}` }],
  }),
);
server.registerTool(
  "large_echo",
  {
    description: "Returns a large fixture result to exercise Pi spill-file cleanup",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: `MCP_SPILL_PROBE_${process.env.TEST_MCP_SECRET ?? "missing"} ${"x".repeat(30_000)}`,
      },
    ],
  }),
);
server.registerTool(
  "image_echo",
  { description: "Returns a supported image with text", inputSchema: {} },
  async () => ({
    content: [
      { type: "text", text: "fixture image" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  }),
);
if (process.env.TEST_MCP_TOOLSET === "v2") {
  server.registerTool(
    "new_feature",
    { description: "Find items in the new feature catalogue", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "new feature ready" }] }),
  );
}
await server.connect(new StdioServerTransport());
