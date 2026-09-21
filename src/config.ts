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
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const mcpCommonSchema = {
  id: mcpId,
  tools: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().positive().default(15_000),
  maxResultBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024),
};

const httpMcpServerSchema = z
  .object({
    ...mcpCommonSchema,
    url: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "must use HTTP(S)")
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && !url.hash;
      }, "must not contain embedded credentials or a fragment"),
    tokenFile: pathValue.optional(),
  })
  .strict();

const stdioMcpServerSchema = z
  .object({
    ...mcpCommonSchema,
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    secretEnv: z.record(environmentName, pathValue).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    for (const name of Object.keys(value.secretEnv)) {
      if (name in value.env) {
        context.addIssue({
          code: "custom",
          path: ["secretEnv", name],
          message: "must not duplicate an ordinary environment variable",
        });
      }
    }
  });

const mcpServerSchema = z.union([httpMcpServerSchema, stdioMcpServerSchema]);

const mealieSchema = z
  .object({
    baseUrl: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "must use HTTP(S)")
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash;
      }, "must not contain credentials, a query, or a fragment")
      .transform((value) => value.replace(/\/$/, "")),
    apiKeyFile: pathValue,
    requestTimeoutMs: z.number().int().positive().default(30_000),
    importTimeoutMs: z.number().int().positive().default(180_000),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    maxResultBytes: z
      .number()
      .int()
      .positive()
      .default(64 * 1024),
  })
  .strict();

const configSchema = z
  .object({
    telegram: z.object({
      tokenFile: pathValue,
      allowedUsers: z.array(positiveDecimalId).min(1),
      allowedChats: z.array(decimalId).min(1),
      pollingTimeoutSeconds: z.number().int().min(1).max(50).default(30),
    }),
    agent: z
      .object({
        systemPromptFile: pathValue.optional(),
      })
      .default({}),
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
    mealie: mealieSchema.optional(),
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
    ...(config.agent.systemPromptFile ? [config.agent.systemPromptFile] : []),
    config.data.directory,
    ...config.skills.paths,
    ...(config.mealie ? [config.mealie.apiKeyFile] : []),
    ...config.mcp.flatMap((server) =>
      "url" in server
        ? server.tokenFile
          ? [server.tokenFile]
          : []
        : Object.values(server.secretEnv),
    ),
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
    mealie: config.mealie ? { ...config.mealie, apiKeyFile: "[secret-file]" } : undefined,
    mcp: config.mcp.map((server) =>
      "url" in server
        ? {
            ...server,
            tokenFile: server.tokenFile ? "[secret-file]" : undefined,
          }
        : {
            ...server,
            secretEnv: Object.fromEntries(
              Object.keys(server.secretEnv).map((name) => [name, "[secret-file]"]),
            ),
          },
    ),
  };
}
