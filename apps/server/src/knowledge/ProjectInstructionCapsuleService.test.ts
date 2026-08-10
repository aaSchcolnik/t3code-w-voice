import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import {
  buildProjectInstructionCapsule,
  MAX_PROJECT_INSTRUCTION_CAPSULE_CHARS,
} from "./ProjectInstructionCapsuleService.ts";

const capabilities = (...values: McpCapability[]) => new Set(values);

describe("buildProjectInstructionCapsule", () => {
  it("builds a compact versioned capsule without embedding skill bodies", () => {
    const capsule = buildProjectInstructionCapsule({
      capabilities: capabilities("engine-knowledge", "engine-planning", "codex-agent"),
      providerDriver: ProviderDriverKind.make("codex"),
      skillRevision: "skills-4",
      standards: [
        "Preserve remote-ready single-origin behavior.",
        "Never run against live user data.",
      ],
    });

    expect(capsule.version).toBe(1);
    expect(capsule.revision).not.toBe(capsule.catalogRevision);
    expect(capsule.text.length).toBeLessThanOrEqual(MAX_PROJECT_INSTRUCTION_CAPSULE_CHARS);
    expect(capsule.text).toContain("highest-priority project instruction files");
    expect(capsule.text).toContain("Preserve remote-ready single-origin behavior.");
    expect(capsule.text).toContain("Never run against live user data.");
    expect(capsule.text).toContain("Git as read-only");
    expect(capsule.text).toContain("engine_skill_search");
    expect(capsule.text).toContain("metadata-only");
    expect(capsule.text).not.toContain("### Custom");
  });

  it("omits unavailable capability guidance", () => {
    const capsule = buildProjectInstructionCapsule({ capabilities: capabilities("preview") });
    expect(capsule.text).toContain("collaborative browser");
    expect(capsule.text).not.toContain("engine_skill_search");
    expect(capsule.text).not.toContain("start all needed runs");
  });
});
