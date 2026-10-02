import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { hideMcpResourceHelpers, MCP_RESOURCE_HELPERS } from "../src/agent/extensions.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "unused" }], details: undefined };
    },
  };
}

describe("trusted Pi extension policy", () => {
  it("does not register MCP resource helpers and blocks any attempted call", async () => {
    const registered: string[] = [];
    let toolCallHandler: ((event: { toolName: string }) => unknown) | undefined;
    const fakeApi = {
      registerTool(definition: ToolDefinition) {
        registered.push(definition.name);
      },
      on(event: string, handler: (event: { toolName: string }) => unknown) {
        if (event === "tool_call") toolCallHandler = handler;
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    const baseFactory: ExtensionFactory = (pi) => {
      for (const name of MCP_RESOURCE_HELPERS) pi.registerTool(tool(name));
      pi.registerTool(tool("mcp__home__get_state"));
    };

    await hideMcpResourceHelpers(baseFactory)(fakeApi);

    expect(registered).toEqual(["mcp__home__get_state"]);
    expect(toolCallHandler).toBeDefined();
    for (const name of MCP_RESOURCE_HELPERS) {
      expect(await toolCallHandler?.({ toolName: name })).toEqual({
        block: true,
        reason: "MCP resource operations are disabled",
      });
    }
    expect(await toolCallHandler?.({ toolName: "mcp__home__get_state" })).toBeUndefined();
  });
});
