import { describe, expect, it } from "@effect/vitest";

import type { McpCapability } from "./McpInvocationContext.ts";
import { buildMcpToolCatalog } from "./McpToolCatalogService.ts";

const capabilities = (...values: McpCapability[]) => new Set(values);

describe("buildMcpToolCatalog", () => {
  it("returns a deterministic capability-filtered private catalog", () => {
    const input = {
      capabilities: capabilities("engine-knowledge", "engine-planning", "cursor-agent"),
      skillRevision: "skills-7",
    };
    const first = buildMcpToolCatalog(input);
    const second = buildMcpToolCatalog(input);

    expect(first).toEqual(second);
    expect(first.ttlMs).toBe(0);
    expect(first.cacheScope).toBe("private");
    expect(first.tools).toContain("engine_skill_search");
    expect(first.tools).toContain("knowledge_search");
    expect(first.tools).toContain("engine_plan");
    expect(first.tools).toContain("cursor_respond");
    expect(first.tools).not.toContain("preview_status");
    expect(first.tools).not.toContain("codex_start");
    expect(first.tools).toEqual([...first.tools].sort());
  });

  it("changes revision when the skill catalog revision changes", () => {
    const common = { capabilities: capabilities("engine-knowledge") };
    expect(buildMcpToolCatalog({ ...common, skillRevision: "one" }).revision).not.toBe(
      buildMcpToolCatalog({ ...common, skillRevision: "two" }).revision,
    );
  });

  it("advertises neutral delegation controls while hiding starts when routing is off", () => {
    const enabled = buildMcpToolCatalog({
      capabilities: capabilities("delegation-router"),
    });
    expect(enabled.tools).toEqual(["delegate_cancel", "delegate_respond", "delegate_start"]);

    const disabled = buildMcpToolCatalog({
      capabilities: capabilities("delegation-router"),
      effectiveMcp: {
        preview: false,
        codexAgent: false,
        cursorAgent: false,
        claudeAgent: false,
        engine: {
          planning: false,
          consensus: false,
          enrich: false,
          implement: false,
          quality: false,
          performance: false,
          typescript: false,
          delegation: { roles: {}, skillOverrides: {} },
          knowledgeScan: { mainThreadModelPreference: [] },
        },
        router: {
          mode: "off",
          maxBatchSize: 4,
          maxConcurrentPerParent: 4,
          maxConcurrentEnvironment: 8,
          defaultTimeoutMs: 1_800_000,
          diversity: "prefer",
          fallback: "pre-dispatch",
          explanation: "summary",
        },
      },
    });
    expect(disabled.tools).toEqual(["delegate_cancel", "delegate_respond"]);
  });
});
