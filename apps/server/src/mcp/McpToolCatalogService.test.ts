import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
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

  it("advertises only provider-specific delegation tools", () => {
    const catalog = buildMcpToolCatalog({
      capabilities: capabilities(
        "codex-agent",
        "cursor-agent",
        "claude-agent",
        "antigravity-agent",
      ),
    });
    expect(catalog.tools).toContain("codex_start");
    expect(catalog.tools).toContain("cursor_start");
    expect(catalog.tools).toContain("claude_start");
    expect(catalog.tools).toContain("antigravity_start");
    expect(catalog.tools.some((tool) => tool.startsWith("delegate_"))).toBe(false);
  });

  it("lists OpenCode tools when the setting and capability are on", () => {
    const catalog = buildMcpToolCatalog({
      capabilities: capabilities("opencode-agent"),
      effectiveMcp: {
        ...DEFAULT_SERVER_SETTINGS.mcp,
        preview: false,
        codexAgent: false,
        cursorAgent: false,
        claudeAgent: false,
        antigravityAgent: false,
        opencodeAgent: true,
      },
    });
    expect(catalog.tools).toContain("opencode_capabilities");
    expect(catalog.tools).toContain("opencode_start");
    expect(catalog.tools).toContain("opencode_cancel");
    expect(catalog.tools).toContain("opencode_respond");
  });
});
