import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProjectId, ProviderDriverKind } from "@t3tools/contracts";

import { searchKnowledge } from "../knowledge/KnowledgeRepository.ts";
import { buildProjectInstructionCapsule } from "../knowledge/ProjectInstructionCapsuleService.ts";
import { ProjectKnowledgeStore } from "../knowledge/ProjectKnowledgeStore.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SkillRepository } from "../persistence/Services/Skills.ts";
import type { McpCapability } from "./McpInvocationContext.ts";
import type { McpProviderSessionConfig } from "./McpProviderSession.ts";
import { skillCatalogRevision } from "./skillCatalog.ts";

const TRACKED_PROVIDER_TOOLS = {
  "codex-agent": {
    label: "Codex",
    start: "codex_start",
  },
  "cursor-agent": {
    label: "Cursor",
    start: "cursor_start",
  },
  "claude-agent": {
    label: "Claude",
    start: "claude_start",
  },
  "antigravity-agent": {
    label: "Antigravity",
    start: "antigravity_start",
  },
} as const;

const sameProviderNativeInstruction = (
  providerDriver: ProviderDriverKind | undefined,
): string | undefined => {
  switch (providerDriver) {
    case "claudeAgent":
      return "Claude's native Agent/Task mechanism is also available; native runs are tracked in the Subagents panel.";
    case "codex":
      return "Codex collaboration tools are also available; native child threads are tracked in the Subagents panel.";
    case "cursor":
      return "Cursor's native Task mechanism is also available; native task runs are tracked in the Subagents panel.";
    default:
      return undefined;
  }
};

export function trackedDelegationInstructions(
  capabilities: ReadonlySet<McpCapability>,
  providerDriver?: ProviderDriverKind,
  nativeSubagentTracking = false,
): string | undefined {
  const callable = Object.entries(TRACKED_PROVIDER_TOOLS).flatMap(([capability, tool]) =>
    capabilities.has(capability as McpCapability) ? [tool] : [],
  );
  const nativeInstruction = nativeSubagentTracking
    ? sameProviderNativeInstruction(providerDriver)
    : undefined;
  if (callable.length === 0 && nativeInstruction === undefined) {
    return undefined;
  }

  const toolNames = callable.map((tool) => `\`${tool.start}\` (${tool.label})`).join(", ");
  return [
    "## T3 Code tracked subagents",
    nativeInstruction,
    callable.length > 0
      ? `Callable tracked provider tools: ${toolNames}. Honor an explicit provider request. For independent work, start every needed run before ending the turn. Pass a stable idempotency key for retry-safe starts; an omitted key has no retry deduplication. Results and questions arrive automatically—never wait, poll, sleep, or create background polling commands. Concurrent writers are allowed, so assign disjoint work and keep shared files sequential.`
      : undefined,
    capabilities.has("cursor-agent")
      ? "Answer a tracked Cursor question with `cursor_respond`, then end the turn."
      : undefined,
    callable.length > 0
      ? "Tracked subagents stay inside the workspace and use Git read-only; the server handles permission requests."
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

const IMPLEMENTATION_ENGINE_INSTRUCTIONS = `## T3 Code Implementation Engine

Use the matching engine workflow for project-aware planning, implementation, audits, performance, or TypeScript work. Inspect project knowledge first. Discover reusable workflows with \`engine_skill_search\`; run a selected handle with \`engine_skill_run\`. Search bounded evidence with \`knowledge_search\`.`;

export function implementationEngineInstructions(
  capabilities: ReadonlySet<McpCapability>,
): string | undefined {
  return capabilities.has("engine-knowledge") ? IMPLEMENTATION_ENGINE_INSTRUCTIONS : undefined;
}

export function mcpSessionInstructions(
  capabilities: ReadonlySet<McpCapability>,
  providerDriver?: ProviderDriverKind,
  nativeSubagentTracking = false,
): string | undefined {
  if (capabilities.size === 0) return undefined;
  const capsule = buildProjectInstructionCapsule({
    capabilities,
    providerDriver,
    nativeSubagentTracking,
  }).text;
  const delegation = trackedDelegationInstructions(
    capabilities,
    providerDriver,
    nativeSubagentTracking,
  );
  return delegation === undefined ? capsule : `${capsule}\n\n${delegation}`;
}

type ProjectStandardsLoader = (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>;

const standardsFromRows = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  const riskOrder = { high: 0, medium: 1, low: 2 } as const;
  return [...rows]
    .sort((left, right) => {
      const leftRisk =
        typeof left.risk === "string" && left.risk in riskOrder
          ? riskOrder[left.risk as keyof typeof riskOrder]
          : 3;
      const rightRisk =
        typeof right.risk === "string" && right.risk in riskOrder
          ? riskOrder[right.risk as keyof typeof riskOrder]
          : 3;
      return leftRisk - rightRisk;
    })
    .flatMap((row) => (typeof row.rule_text === "string" ? [row.rule_text] : []))
    .slice(0, 4);
};

export const buildMcpSessionInstructions = Effect.fn("buildMcpSessionInstructions")(function* (
  session: McpProviderSessionConfig,
  loadStandards: ProjectStandardsLoader = () => Effect.succeed([]),
): Effect.fn.Return<string | undefined, never, SkillRepository | ProjectionProjectRepository> {
  const fallback = mcpSessionInstructions(
    session.capabilities,
    session.providerDriver,
    session.nativeSubagentTracking,
  );
  const loadCatalog = Effect.gen(function* () {
    const skills = yield* SkillRepository;
    const projects = yield* ProjectionProjectRepository;
    const [records, project, standards] = yield* Effect.all(
      [
        skills.list({ projectId: session.projectId }),
        projects.getById({ projectId: session.projectId }),
        loadStandards(session.projectId),
      ],
      { concurrency: "unbounded" },
    );
    const projectSkillOverrides = Option.isSome(project)
      ? project.value.mcpOverrides?.skills
      : undefined;
    const capsule = buildProjectInstructionCapsule({
      capabilities: session.capabilities,
      providerDriver: session.providerDriver,
      nativeSubagentTracking: session.nativeSubagentTracking,
      skillRevision: skillCatalogRevision({
        skills: records,
        projectSkillOverrides,
        capabilities: session.capabilities,
      }),
      standards,
    }).text;
    const delegation = trackedDelegationInstructions(
      session.capabilities,
      session.providerDriver,
      session.nativeSubagentTracking,
    );
    return delegation === undefined ? capsule : `${capsule}\n\n${delegation}`;
  });

  return yield* loadCatalog.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to build the MCP skill catalog; using base instructions", {
        cause: String(cause),
        projectId: session.projectId,
        threadId: session.threadId,
      }).pipe(Effect.as(fallback)),
    ),
  );
});

export type McpSessionInstructionBuilder = (
  session: McpProviderSessionConfig,
) => Effect.Effect<string | undefined>;

export class McpSessionInstructionBuilderService extends Context.Reference<McpSessionInstructionBuilder>(
  "t3/mcp/McpSessionInstructionBuilder",
  {
    defaultValue: () => (session) =>
      Effect.succeed(
        mcpSessionInstructions(
          session.capabilities,
          session.providerDriver,
          session.nativeSubagentTracking,
        ),
      ),
  },
) {}

export const makeMcpSessionInstructionBuilder = Effect.fn("makeMcpSessionInstructionBuilder")(
  function* (): Effect.fn.Return<
    McpSessionInstructionBuilder,
    never,
    SkillRepository | ProjectionProjectRepository | ProjectKnowledgeStore
  > {
    const skills = yield* SkillRepository;
    const projects = yield* ProjectionProjectRepository;
    const knowledgeStore = yield* ProjectKnowledgeStore;
    const loadStandards: ProjectStandardsLoader = (projectId) =>
      searchKnowledge(projectId, { table: "rules", query: "", limit: 12 }).pipe(
        Effect.map(standardsFromRows),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to load project standards for the MCP instruction capsule", {
            cause: String(cause),
            projectId,
          }).pipe(Effect.as([])),
        ),
        Effect.provideService(ProjectKnowledgeStore, knowledgeStore),
      );
    return (session) =>
      buildMcpSessionInstructions(session, loadStandards).pipe(
        Effect.provideService(SkillRepository, skills),
        Effect.provideService(ProjectionProjectRepository, projects),
      );
  },
);

export interface UntrackedDelegationAttempt {
  readonly provider: "codex" | "cursor" | "claude" | "antigravity";
  readonly trackedTool: "codex_start" | "cursor_start" | "claude_start" | "antigravity_start";
}

/**
 * Detect only non-interactive agent invocations that bypass T3's tracked
 * delegation service. Ordinary provider CLI usage (login, version, etc.) must
 * continue to work.
 */
export function detectUntrackedDelegationAttempt(
  toolName: string,
  toolInput: Record<string, unknown>,
  capabilities: ReadonlySet<McpCapability>,
): UntrackedDelegationAttempt | undefined {
  const subagentType = toolInput.subagent_type ?? toolInput.subagentType;
  if (/(?:agent|task)/iu.test(toolName) && typeof subagentType === "string") {
    const normalizedType = subagentType.trim().toLowerCase();
    if (capabilities.has("codex-agent") && /^codex(?:[:/.-]|$)/u.test(normalizedType)) {
      return { provider: "codex", trackedTool: "codex_start" };
    }
    if (capabilities.has("cursor-agent") && /^cursor(?:[:/.-]|$)/u.test(normalizedType)) {
      return { provider: "cursor", trackedTool: "cursor_start" };
    }
  }

  if (!/(?:bash|shell|command|terminal)/iu.test(toolName)) return undefined;
  const commandValue = toolInput.command ?? toolInput.cmd;
  if (typeof commandValue !== "string") return undefined;
  const command = commandValue.toLowerCase();

  if (
    capabilities.has("cursor-agent") &&
    /(?:^|[;&|()\s])(?:[^\s/]+\/)*cursor-agent(?:\s|$)/u.test(command) &&
    /(?:^|\s)(?:-p|--print)(?:\s|$)/u.test(command)
  ) {
    return { provider: "cursor", trackedTool: "cursor_start" };
  }

  if (
    capabilities.has("claude-agent") &&
    /(?:^|[;&|()\s])(?:[^\s/]+\/)*claude(?:\s|$)/u.test(command) &&
    /(?:^|\s)(?:-p|--print)(?:\s|$)/u.test(command)
  ) {
    return { provider: "claude", trackedTool: "claude_start" };
  }

  if (
    capabilities.has("antigravity-agent") &&
    /(?:^|[;&|()\s])(?:[^\s/]+\/)*agy(?:\s|$)/u.test(command) &&
    /(?:^|\s)(?:-p|--print|--prompt)(?:\s|$)/u.test(command)
  ) {
    return { provider: "antigravity", trackedTool: "antigravity_start" };
  }

  if (
    capabilities.has("codex-agent") &&
    ((/(?:^|[;&|()\s])(?:[^\s/]+\/)*codex(?:\s|$)/u.test(command) &&
      /(?:^|\s)exec(?:\s|$)/u.test(command)) ||
      /codex-companion\.mjs["']?\s+(?:task|task-worker)(?:\s|$)/u.test(command))
  ) {
    return { provider: "codex", trackedTool: "codex_start" };
  }

  return undefined;
}

export function untrackedDelegationDenialMessage(attempt: UntrackedDelegationAttempt): string {
  return `Do not launch ${attempt.provider} as an untracked shell subprocess. Use the T3 Code MCP tool ${attempt.trackedTool} so the run appears in the Subagents panel with status, transcript, result, and cancellation controls.`;
}
