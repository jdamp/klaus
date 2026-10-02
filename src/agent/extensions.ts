import {
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type InlineExtension,
  type LoadedMcpConfig,
  type McpExtensionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const MCP_RESOURCE_HELPERS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

const emptyMcpConfig: NonNullable<McpExtensionOptions["loadConfig"]> = (): LoadedMcpConfig => ({
  servers: [],
  errors: [],
});

export function hideMcpResourceHelpers(factory: ExtensionFactory): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) =>
      MCP_RESOURCE_HELPERS.has(event.toolName)
        ? { block: true, reason: "MCP resource operations are disabled" }
        : undefined,
    );
    const guardedApi = new Proxy(pi, {
      get(target, property) {
        if (property === "registerTool") {
          return (definition: ToolDefinition) => {
            if (MCP_RESOURCE_HELPERS.has(definition.name)) return;
            return target.registerTool(definition);
          };
        }

        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => method.apply(target, args);
      },
    });
    return factory(guardedApi);
  };
}

export function createTrustedExtensionFactories(
  options: {
    memory?: ExtensionFactory;
    compaction?: ExtensionFactory;
    loadMcpConfig?: McpExtensionOptions["loadConfig"];
    mcpFactory?: ExtensionFactory;
  } = {},
): InlineExtension[] {
  const factories: InlineExtension[] = [];
  if (options.memory) {
    factories.push({ name: "klaus-memory-context", hidden: true, factory: options.memory });
  }
  if (options.compaction) {
    factories.push({
      name: "klaus-attribution-compaction",
      hidden: true,
      factory: options.compaction,
    });
  }

  factories.push(
    {
      name: "klaus-mcp",
      hidden: true,
      replaceable: true,
      factory:
        options.mcpFactory ??
        hideMcpResourceHelpers(
          createMcpExtension({ loadConfig: options.loadMcpConfig ?? emptyMcpConfig }),
        ),
    },
    {
      name: "klaus-tool-search",
      hidden: true,
      replaceable: true,
      factory: createToolSearchExtension(),
    },
  );
  return factories;
}
