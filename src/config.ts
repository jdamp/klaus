import { isAbsolute, resolve } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

const decimalId = z.string().regex(/^-?\d+$/, "must be a decimal Telegram identifier");
const positiveDecimalId = z
  .string()
  .regex(/^\d+$/, "must be a positive decimal Telegram identifier");
const pathValue = z
  .string()
  .min(1)
  .transform((value) => resolve(value));
const mcpId = z.string().regex(/^[a-z][a-z0-9_-]*$/);

const mcpServerSchema = z.object({
  id: mcpId,
  url: z
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "must use HTTP(S)")
    .refine((value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.hash;
    }, "must not contain embedded credentials or a fragment"),
  tokenFile: pathValue.optional(),
  tools: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().default(15_000),
  maxResultBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024),
});

const configSchema = z
  .object({
    telegram: z.object({
      tokenFile: pathValue,
      allowedUsers: z.array(positiveDecimalId).min(1),
      allowedChats: z.array(decimalId).min(1),
      pollingTimeoutSeconds: z.number().int().min(1).max(50).default(30),
    }),
    model: z.object({
      provider: z.string().min(1),
      id: z.string().min(1),
      reasoning: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .default("medium"),
      authPath: pathValue,
      modelsPath: pathValue.optional(),
      contextTokens: z.number().int().min(4_096).default(64_000),
      retryLimit: z.number().int().min(0).max(10).default(2),
    }),
    mcp: z.array(mcpServerSchema).default([]),
    skills: z.object({
      paths: z.array(pathValue).default([]),
    }),
    data: z.object({
      directory: pathValue,
      retentionDays: z.number().int().positive().default(90),
    }),
    health: z.object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65_535).default(8080),
    }),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, server] of value.mcp.entries()) {
      if (ids.has(server.id)) {
        context.addIssue({
          code: "custom",
          path: ["mcp", index, "id"],
          message: "MCP server identifiers must be unique",
        });
      }
      ids.add(server.id);
    }
    if (resolve(value.model.authPath).startsWith(resolve(value.data.directory) + "/")) {
      context.addIssue({
        code: "custom",
        path: ["model", "authPath"],
        message: "Pi authentication must be stored separately from application data",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
export type McpServerConfig = AppConfig["mcp"][number];

export function parseConfig(source: string): AppConfig {
  return configSchema.parse(parse(source));
}

export function assertAbsoluteConfiguredPaths(config: AppConfig): void {
  const paths = [
    config.telegram.tokenFile,
    config.model.authPath,
    config.data.directory,
    ...config.skills.paths,
    ...config.mcp.flatMap((server) => (server.tokenFile ? [server.tokenFile] : [])),
  ];
  if (paths.some((path) => !isAbsolute(path))) {
    throw new Error("All configured paths must resolve to absolute paths");
  }
}

export function publicConfig(config: AppConfig): unknown {
  return {
    ...config,
    telegram: { ...config.telegram, tokenFile: "[secret-file]" },
    model: { ...config.model, authPath: "[protected-auth-path]" },
    mcp: config.mcp.map((server) => ({
      ...server,
      tokenFile: server.tokenFile ? "[secret-file]" : undefined,
    })),
  };
}
