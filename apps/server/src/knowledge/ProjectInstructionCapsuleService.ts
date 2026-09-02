import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import { buildMcpToolCatalog } from "../mcp/McpToolCatalogService.ts";

export const PROJECT_INSTRUCTION_CAPSULE_VERSION = 1 as const;
export const MAX_PROJECT_INSTRUCTION_CAPSULE_CHARS = 3_000;

export interface ProjectInstructionCapsuleInput {
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly providerDriver?: ProviderDriverKind | undefined;
  readonly nativeSubagentTracking?: boolean | undefined;
  readonly skillRevision?: string | undefined;
  readonly standards?: ReadonlyArray<string> | undefined;
}

export interface ProjectInstructionCapsule {
  readonly version: typeof PROJECT_INSTRUCTION_CAPSULE_VERSION;
  readonly revision: string;
  readonly catalogRevision: string;
  readonly text: string;
}

const capabilityGroups = (capabilities: ReadonlySet<McpCapability>): ReadonlyArray<string> => {
  const groups: string[] = [];
  if (capabilities.has("preview")) groups.push("collaborative browser");
  if (
    capabilities.has("codex-agent") ||
    capabilities.has("cursor-agent") ||
    capabilities.has("claude-agent")
  ) {
    groups.push("tracked subagents");
  }
  if ([...capabilities].some((capability) => capability.startsWith("engine-"))) {
    groups.push("Implementation Engine");
  }
  if (capabilities.has("engine-knowledge")) groups.push("skill and project-knowledge search");
  return groups;
};

const delegationHeuristic = (
  capabilities: ReadonlySet<McpCapability>,
  providerDriver: ProviderDriverKind | undefined,
  nativeSubagentTracking: boolean,
): string | undefined => {
  const tools = [
    capabilities.has("codex-agent") ? "`codex_start`" : undefined,
    capabilities.has("cursor-agent") ? "`cursor_start`" : undefined,
    capabilities.has("claude-agent") ? "`claude_start`" : undefined,
    capabilities.has("antigravity-agent") ? "`antigravity_start`" : undefined,
  ].filter((tool): tool is string => tool !== undefined);
  const native =
    nativeSubagentTracking &&
    (providerDriver === "codex" || providerDriver === "cursor" || providerDriver === "claudeAgent");
  if (tools.length === 0 && !native) return undefined;
  return `Delegate only independent, bounded work that benefits from a specialist. Use ${
    tools.length > 0 ? tools.join(", ") : "the provider's tracked native mechanism"
  }; start all needed runs, then end the turn. Results arrive automatically—never poll or sleep.`;
};

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const buildProjectInstructionCapsule = (
  input: ProjectInstructionCapsuleInput,
): ProjectInstructionCapsule => {
  const catalog = buildMcpToolCatalog({
    capabilities: input.capabilities,
    providerDriver: input.providerDriver,
    skillRevision: input.skillRevision,
  });
  const groups = capabilityGroups(input.capabilities);
  const delegation = delegationHeuristic(
    input.capabilities,
    input.providerDriver,
    input.nativeSubagentTracking ?? false,
  );
  const standards = (input.standards ?? [])
    .map((standard) => standard.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 4);
  const revision = `capsule-v${PROJECT_INSTRUCTION_CAPSULE_VERSION}-${stableHash(
    JSON.stringify({ catalogRevision: catalog.revision, standards }),
  )}`;
  const sections = [
    `## T3 Code project capsule v${PROJECT_INSTRUCTION_CAPSULE_VERSION}`,
    `Revision: \`${revision}\`.`,
    "Follow the highest-priority project instruction files loaded by the provider. Keep all file access inside the authorized workspace. Treat Git as read-only unless the user explicitly authorizes a Git mutation.",
    standards.length > 0
      ? [
          "Highest-priority project standards:",
          ...standards.map((standard) => `- ${standard}`),
        ].join("\n")
      : undefined,
    delegation,
    groups.length > 0 ? `Available capability groups: ${groups.join(", ")}.` : undefined,
    input.capabilities.has("engine-knowledge")
      ? "Discover workflows with `engine_skill_search`; its results are metadata-only. Run the selected handle with `engine_skill_run` to load the full workflow. Use `knowledge_search` for bounded, scoped project evidence."
      : undefined,
  ].filter((section): section is string => section !== undefined);
  const text = sections.join("\n\n").slice(0, MAX_PROJECT_INSTRUCTION_CAPSULE_CHARS);
  return {
    version: PROJECT_INSTRUCTION_CAPSULE_VERSION,
    revision,
    catalogRevision: catalog.revision,
    text,
  };
};

export type ProjectInstructionCapsuleBuilder = (
  input: ProjectInstructionCapsuleInput,
) => ProjectInstructionCapsule;

export class ProjectInstructionCapsuleService extends Context.Reference<ProjectInstructionCapsuleBuilder>(
  "t3/knowledge/ProjectInstructionCapsuleService",
  { defaultValue: () => buildProjectInstructionCapsule },
) {}

export type ProviderInstructionDelivery =
  | { readonly supported: true; readonly channel: "developer" | "system" }
  | { readonly supported: false; readonly reason: string };
