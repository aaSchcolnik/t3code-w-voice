import {
  CONSENSUS_DEFAULTS,
  DEFAULT_SERVER_SETTINGS,
  SCOUT_DEFAULTS,
  WORKER_DEFAULTS,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { renderDelegationSection, resolveDelegationChains } from "./delegation.ts";

const capabilities = (...values: ReadonlyArray<McpCapability>): ReadonlySet<McpCapability> =>
  new Set(values);
const defaults = {
  ...DEFAULT_SERVER_SETTINGS.mcp.engine.delegation,
  roles: { scout: SCOUT_DEFAULTS, worker: WORKER_DEFAULTS, consensus: CONSENSUS_DEFAULTS },
};

describe("resolveDelegationChains", () => {
  it("uses a workflow override before the role chain", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities("codex-agent", "cursor-agent"),
      settings: {
        ...defaults,
        skillOverrides: {
          plan: { scout: [{ provider: "codex", model: "override-model" }] },
        },
      },
    });

    expect(resolved.scout).toMatchObject({ provider: "codex", model: "override-model" });
  });

  it("skips unavailable providers and selects the next target", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities("codex-agent"),
      settings: defaults,
    });

    expect(resolved.scout).toMatchObject({ provider: "codex", model: "gpt-5.5" });
  });

  it("resolves every available consensus member, not first-available", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities("codex-agent", "cursor-agent"),
      settings: defaults,
    });

    expect(resolved.consensusPanel).toHaveLength(2);
    expect(resolved.consensusPanel[0]).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
    expect(resolved.consensusPanel[1]).toMatchObject({ provider: "cursor", model: "grok-4.5" });
  });

  it("filters unavailable providers out of the consensus panel", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities("cursor-agent"),
      settings: defaults,
    });

    expect(resolved.consensusPanel).toHaveLength(1);
    expect(resolved.consensusPanel[0]).toMatchObject({ provider: "cursor", model: "grok-4.5" });
  });

  it("returns inline for an explicit empty override chain", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities("codex-agent", "cursor-agent"),
      settings: { ...defaults, skillOverrides: { plan: { scout: [] } } },
    });

    expect(resolved.scout).toBeUndefined();
  });
});

describe("renderDelegationSection", () => {
  it("renders the inline fallback when no matching provider is available", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities(),
      settings: defaults,
    });

    expect(renderDelegationSection({ workflow: "plan", resolved })).toContain(
      "No tracked subagents are available",
    );
  });

  it("omits workflows whose delegation overhead exceeds the work", () => {
    const resolved = resolveDelegationChains({
      workflow: "quality-quick",
      capabilities: capabilities("codex-agent", "cursor-agent"),
      settings: defaults,
    });

    expect(renderDelegationSection({ workflow: "quality-quick", resolved })).toBe("");
  });

  it("serializes model options into tracked tool instructions", () => {
    const resolved = resolveDelegationChains({
      workflow: "implement",
      capabilities: capabilities("codex-agent"),
      settings: defaults,
    });
    const section = renderDelegationSection({ workflow: "implement", resolved });

    expect(section).toContain("`codex_start`");
    expect(section).toContain('"model":"gpt-5.6-terra"');
    expect(section).toContain('"reasoningEffort"');
    expect(section).toContain("`codex_result` exactly once");
  });

  it("renders the engine_consensus pointer for plans when available", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities("codex-agent", "cursor-agent"),
      settings: defaults,
    });
    const section = renderDelegationSection({
      workflow: "plan",
      resolved,
      consensusAvailable: true,
    });

    expect(section).toContain("calling `engine_consensus` on the draft-plan artifact");
    expect(section).not.toContain("Fan out:");
    expect(section).not.toContain("**Consensus 1:**");
  });

  it("renders the consensus-unavailable fallback when no panel provider is available", () => {
    const resolved = resolveDelegationChains({
      workflow: "plan",
      capabilities: capabilities(),
      settings: defaults,
    });
    const section = renderDelegationSection({ workflow: "plan", resolved });

    expect(section).toContain("No external consensus panel is available");
    expect(section).toContain('engine_report_render (kind="styled-plan")');
    expect(section).not.toContain("**Consensus");
  });

  it("does not render a consensus section for non-plan workflows", () => {
    const resolved = resolveDelegationChains({
      workflow: "implement",
      capabilities: capabilities("codex-agent", "cursor-agent"),
      settings: defaults,
    });
    const section = renderDelegationSection({ workflow: "implement", resolved });

    expect(section).not.toContain("Plan consensus audit");
    expect(section).not.toContain("**Consensus");
  });

  it("renders every consensus target with options and focus", () => {
    const resolved = resolveDelegationChains({
      workflow: "consensus",
      capabilities: capabilities("codex-agent", "cursor-agent"),
      settings: {
        ...defaults,
        roles: {
          ...defaults.roles,
          consensus: [
            { ...CONSENSUS_DEFAULTS[0]!, focus: "risk and complexity" },
            CONSENSUS_DEFAULTS[1]!,
          ],
        },
      },
    });
    const section = renderDelegationSection({ workflow: "consensus", resolved });

    expect(section).toContain("**Consensus 1:**");
    expect(section).toContain("**Consensus 2:**");
    expect(section).toContain('"reasoningEffort"');
    expect(section).toContain("Focus lens: risk and complexity");
  });

  it("adds the credentials gate and click-through only when preview is available", () => {
    const resolved = resolveDelegationChains({
      workflow: "implement",
      capabilities: capabilities("codex-agent"),
      settings: defaults,
    });
    const available = renderDelegationSection({
      workflow: "implement",
      resolved,
      previewAvailable: true,
    });
    const unavailable = renderDelegationSection({
      workflow: "implement",
      resolved,
      previewAvailable: false,
    });

    expect(available).toContain("Credentials gate — before any clicking");
    expect(available).toContain("STOP, ask the user in chat");
    expect(available).toContain("`preview_status`");
    expect(available).toContain("kind=preview-verification");
    expect(unavailable).not.toContain("Credentials gate");
    expect(unavailable).not.toContain("`preview_status`");
    expect(unavailable).toContain("preview capability");
  });
});
