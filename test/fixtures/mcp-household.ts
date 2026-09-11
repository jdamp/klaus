import type { DiscoveredTool, McpClientLike } from "../../src/mcp/registry.js";

export const householdTools: DiscoveredTool[] = [
  { name: "light", description: "Set a light", inputSchema: { type: "object" } },
  { name: "vacuum", description: "Control a vacuum", inputSchema: { type: "object" } },
  { name: "desk", description: "Set desk height", inputSchema: { type: "object" } },
  { name: "shopping_list", description: "Manage a list", inputSchema: { type: "object" } },
];

export function householdMcpFixture(): McpClientLike {
  return {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools: householdTools }),
    callTool: async (name, args) => ({ operation: name, args }),
  };
}
