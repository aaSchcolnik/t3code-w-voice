import type { McpSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";

export interface McpToolCatalog {
  readonly tools: ReadonlyArray<string>;
  readonly ttlMs: 0;
  readonly cacheScope: "private";
  readonly revision: string;
}

export interface McpToolCatalogInput {
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly effectiveMcp?: McpSettings | undefined;
  readonly providerDriver?: ProviderDriverKind | undefined;
  readonly skillRevision?: string | undefined;
}

const PREVIEW_TOOLS = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
] as const;

const DELEGATION_TOOLS = {
  "codex-agent": ["codex_capabilities", "codex_start", "codex_cancel"],
  "cursor-agent": ["cursor_capabilities", "cursor_start", "cursor_cancel", "cursor_respond"],
  "claude-agent": ["claude_capabilities", "claude_start", "claude_cancel"],
} as const satisfies Partial<Record<McpCapability, ReadonlyArray<string>>>;

const ENGINE_WORKFLOW_TOOLS = {
  "engine-planning": ["engine_plan_brief", "engine_plan"],
  "engine-consensus": ["engine_consensus"],
  "engine-enrich": ["engine_enrich"],
  "engine-implement": ["engine_implement", "engine_chunks_next", "engine_chunks_update"],
  "engine-quality": ["engine_quality_audit", "engine_quality_quick", "engine_quality_pr"],
  "engine-performance": ["engine_hot_loops"],
  "engine-typescript": ["engine_typescript"],
} as const satisfies Partial<Record<McpCapability, ReadonlyArray<string>>>;

const ENGINE_KNOWLEDGE_TOOLS = [
  "engine_knowledge_status",
  "knowledge_search",
  "engine_knowledge_search",
  "engine_knowledge_get",
  "engine_knowledge_save",
  "engine_knowledge_bootstrap",
  "engine_knowledge_merge_reports",
  "engine_case_open",
  "engine_artifact_save",
  "engine_artifact_get",
  "engine_artifact_list",
  "engine_delegation_get",
  "engine_delegation_set",
  "engine_report_render",
  "engine_skill_search",
  "engine_skill_list",
  "engine_skill_run",
  "engine_skill_save",
] as const;

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const settingAllows = (capability: McpCapability, settings: McpSettings | undefined): boolean => {
  if (settings === undefined) return true;
  switch (capability) {
    case "preview":
      return settings.preview;
    case "codex-agent":
      return settings.codexAgent;
    case "cursor-agent":
      return settings.cursorAgent;
    case "claude-agent":
      return settings.claudeAgent;
    case "engine-planning":
      return settings.engine.planning;
    case "engine-consensus":
      return settings.engine.consensus;
    case "engine-enrich":
      return settings.engine.enrich;
    case "engine-implement":
      return settings.engine.implement;
    case "engine-quality":
      return settings.engine.quality;
    case "engine-performance":
      return settings.engine.performance;
    case "engine-typescript":
      return settings.engine.typescript;
    case "engine-knowledge":
      return true;
  }
};

export const buildMcpToolCatalog = (input: McpToolCatalogInput): McpToolCatalog => {
  const enabled = (capability: McpCapability) =>
    input.capabilities.has(capability) && settingAllows(capability, input.effectiveMcp);
  const tools = new Set<string>();

  if (enabled("preview")) {
    for (const tool of PREVIEW_TOOLS) tools.add(tool);
  }
  for (const [capability, names] of Object.entries(DELEGATION_TOOLS)) {
    if (!enabled(capability as McpCapability)) continue;
    for (const tool of names) tools.add(tool);
  }
  if (enabled("engine-knowledge")) {
    for (const tool of ENGINE_KNOWLEDGE_TOOLS) tools.add(tool);
  }
  for (const [capability, names] of Object.entries(ENGINE_WORKFLOW_TOOLS)) {
    if (!enabled(capability as McpCapability)) continue;
    for (const tool of names) tools.add(tool);
  }

  const sortedTools = [...tools].sort();
  const revisionInput = JSON.stringify({
    version: 1,
    tools: sortedTools,
    providerDriver: input.providerDriver ?? null,
    skillRevision: input.skillRevision ?? null,
  });
  return {
    tools: sortedTools,
    ttlMs: 0,
    cacheScope: "private",
    revision: `mcp-catalog-v1-${stableHash(revisionInput)}`,
  };
};

export type McpToolCatalogBuilder = (input: McpToolCatalogInput) => McpToolCatalog;

export class McpToolCatalogService extends Context.Reference<McpToolCatalogBuilder>(
  "t3/mcp/McpToolCatalogService",
  { defaultValue: () => buildMcpToolCatalog },
) {}

export const catalogForInvocation = Effect.fn("McpToolCatalogService.catalogForInvocation")(
  function* (
    scope: McpInvocationScope,
    skillRevision?: string,
  ): Effect.fn.Return<McpToolCatalog, never, McpToolCatalogService> {
    const build = yield* McpToolCatalogService;
    return build({
      capabilities: scope.capabilities,
      effectiveMcp: scope.effectiveMcp,
      providerDriver: scope.providerDriver,
      skillRevision,
    });
  },
);
