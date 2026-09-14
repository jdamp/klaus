import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

import { parseConfig } from "../src/config.js";

type KubernetesObject = {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  spec?: Record<string, unknown>;
};

describe("packaging and deployment examples", () => {
  it("ships a validation-safe local configuration without credentials", async () => {
    const source = await readFile("examples/config.local.yaml", "utf8");
    const config = parseConfig(source);
    expect(config.telegram.allowedUsers).toHaveLength(2);
    expect(config.telegram.allowedChats).toHaveLength(3);
    expect(config.mcp[0]).toMatchObject({ id: "home" });
    expect(config.mcp[0]?.tools).toBeUndefined();
    expect(source).not.toMatch(/\d{8,}:[A-Za-z0-9_-]{20,}/);
    expect(source).not.toContain("Bearer ");
  });

  it("defines a pinned multi-stage non-root image with explicit runtime mounts and healthcheck", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).toContain(
      "ARG NODE_IMAGE=node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2",
    );
    expect(dockerfile.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(3);
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('VOLUME ["/var/lib/klaus-agent", "/var/lib/klaus-agent-auth"]');
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "--experimental-sqlite"');
    expect(dockerfile).toContain("FROM runtime AS verification");
    expect(dockerfile).toContain("FROM runtime AS final");
  });

  it("renders a single-consumer restricted k3s deployment with durable state", async () => {
    const source = await readFile("deploy/k3s/klaus-agent.yaml", "utf8");
    const objects = parseAllDocuments(source).map(
      (document) => document.toJS() as KubernetesObject,
    );
    expect(objects.every((object) => object.kind)).toBe(true);
    const configMap = objects.find((object) => object.kind === "ConfigMap");
    expect(configMap?.data?.["config.yaml"]).toBeDefined();
    const config = parseConfig(configMap!.data!["config.yaml"]!);
    expect(config.data.directory).toBe("/var/lib/klaus-agent");
    expect(config.model.authPath).toBe("/var/lib/klaus-agent-auth/auth.json");

    const deployment = objects.find((object) => object.kind === "Deployment");
    expect(deployment).toBeDefined();
    const spec = deployment!.spec as {
      replicas: number;
      strategy: { type: string };
      template: {
        spec: {
          automountServiceAccountToken: boolean;
          terminationGracePeriodSeconds: number;
          securityContext: Record<string, unknown>;
          containers: Array<{
            securityContext: {
              allowPrivilegeEscalation: boolean;
              readOnlyRootFilesystem: boolean;
              capabilities: { drop: string[] };
            };
            livenessProbe: { httpGet: { path: string } };
            readinessProbe: { httpGet: { path: string } };
            volumeMounts: Array<{ name: string; readOnly?: boolean }>;
          }>;
          volumes: Array<Record<string, unknown>>;
        };
      };
    };
    expect(spec.replicas).toBe(1);
    expect(spec.strategy.type).toBe("Recreate");
    expect(spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(spec.template.spec.terminationGracePeriodSeconds).toBeGreaterThan(30);
    expect(spec.template.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const container = spec.template.spec.containers[0]!;
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(container.livenessProbe.httpGet.path).toBe("/live");
    expect(container.readinessProbe.httpGet.path).toBe("/ready");
    expect(container.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "config", readOnly: true }),
        expect.objectContaining({ name: "telegram-token", readOnly: true }),
        expect.objectContaining({ name: "home-mcp-token", readOnly: true }),
        expect.objectContaining({ name: "data" }),
        expect.objectContaining({ name: "auth" }),
      ]),
    );
    const claims = objects.filter((object) => object.kind === "PersistentVolumeClaim");
    expect(claims.map((claim) => claim.metadata?.name).sort()).toEqual([
      "klaus-agent-auth",
      "klaus-agent-data",
    ]);
  });

  it("keeps deployment secret examples as unmistakable placeholders", async () => {
    const source = await readFile("deploy/k3s/secret.example.yaml", "utf8");
    expect(source).toContain("REPLACE_WITH_TEST_BOT_TOKEN");
    expect(source).toContain("REPLACE_WITH_MCP_BEARER_TOKEN");
    expect(source).not.toMatch(/\d{8,}:[A-Za-z0-9_-]{20,}/);
  });
});
