import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { resolveKnowledgeScanConfiguration } from "./scanAvailability.ts";

const provider = (
  instanceId: string,
  driver: "claudeAgent" | "codex" | "cursor",
  models: ReadonlyArray<string>,
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: models.map((slug) => ({ slug, name: slug })),
  }) as unknown as ServerProvider;

describe("resolveKnowledgeScanConfiguration", () => {
  it("prefers available Claude and exposes the complete default scanner panel", () => {
    const resolved = resolveKnowledgeScanConfiguration({
      mcp: DEFAULT_SERVER_SETTINGS.mcp,
      providers: [
        provider("claude-work", "claudeAgent", ["claude-opus-4-8"]),
        provider("codex", "codex", ["gpt-5.6-terra"]),
        provider("cursor", "cursor", ["grok-4.5", "glm-5.2"]),
      ],
    });
    expect(resolved.selectedModel?.model).toBe("claude-opus-4-8");
    expect(resolved.availableScanners).toEqual([
      "claudeAgent/claude-opus-4-8",
      "codex/gpt-5.6-terra",
      "cursor/grok-4.5",
      "cursor/glm-5.2",
    ]);
  });

  it("falls through to Codex when Claude is unavailable", () => {
    const resolved = resolveKnowledgeScanConfiguration({
      mcp: DEFAULT_SERVER_SETTINGS.mcp,
      providers: [provider("codex", "codex", ["gpt-5.6-terra"])],
    });
    expect(resolved.selectedModel?.model).toBe("gpt-5.6-terra");
    expect(resolved.availableScanners).toEqual(["codex/gpt-5.6-terra"]);
  });
});
