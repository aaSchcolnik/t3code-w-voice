import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SkillRepository } from "../persistence/Services/Skills.ts";
import type { McpCapability } from "./McpInvocationContext.ts";
import type { McpProviderSessionConfig } from "./McpProviderSession.ts";
import { renderSkillCatalogSection } from "./skillCatalog.ts";

const TRACKED_DELEGATION_INSTRUCTIONS = `
## T3 Code tracked subagents

When delegating work to Codex, Cursor, or Claude (including specific models such as Cursor Composer), you MUST use the T3 Code MCP delegation tools when they are available:
- Use \`mcp__t3-code__codex_start\` (\`codex_start\`) for Codex.
- Use \`mcp__t3-code__cursor_start\` (\`cursor_start\`) for Cursor.
- Use \`mcp__t3-code__claude_start\` (\`claude_start\`) for Claude.

Do not substitute another delegation mechanism: a provider-specific agent/plugin (for example, a \`codex:*\` or \`cursor:*\` subagent type), your own native collaboration or agent-spawning tools (for example \`spawn_agent\`) when the user asked for a Codex, Cursor, or Claude subagent, launching \`codex exec\`, \`cursor-agent -p\`, or \`claude -p\`, or an equivalent companion script through Bash or another shell. Those paths are untracked or run the wrong provider: the user cannot see the actual provider status, transcript, result, or cancellation controls in the Subagents panel.

After starting a tracked run, call the matching \`codex_result\`, \`cursor_result\`, or \`claude_result\` tool exactly once. The result call waits event-driven until the run finishes (or needs structured input). If Cursor needs input, call \`cursor_respond\` and then call \`cursor_result\` exactly once again for the next active phase. NEVER poll the status/result tools and NEVER create shell sleep timers or background polling commands. Use a status tool only when the user explicitly asks for a one-time progress snapshot.
`.trim();

export function trackedDelegationInstructions(
  capabilities: ReadonlySet<McpCapability>,
): string | undefined {
  return capabilities.has("codex-agent") ||
    capabilities.has("cursor-agent") ||
    capabilities.has("claude-agent")
    ? TRACKED_DELEGATION_INSTRUCTIONS
    : undefined;
}

const IMPLEMENTATION_ENGINE_INSTRUCTIONS = `## T3 Code Implementation Engine

Implementation Engine tools are available for project-aware planning, consensus analysis, implementation, audits, performance analysis, and TypeScript work. Before coding tasks, call \`engine_knowledge_status\`. Use \`engine_plan\`, \`engine_consensus\`, \`engine_enrich\`, \`engine_implement\`, and the matching quality/performance tools when their structured workflow fits the task. \`engine_consensus\` can analyze any subject with a multi-agent panel. Store workflow output with the engine case/artifact tools; do not create engine temp directories in the repository. Custom skills are listed in the "T3 Code skills" section; run one with \`engine_skill_run({ slug, task })\`. Call \`engine_skill_list\` only if you need to re-check the catalog. When the user asks to create or modify a T3 Code skill, use \`engine_skill_save\`; skills are globally stored and versioned in T3 Code's database, not written into project files. Delegation defaults are configurable per project: call \`engine_delegation_get\` to inspect global, project, effective, and resolved chains. \`engine_delegation_set\` changes the current project by default; pass scope=\`global\` only when the user explicitly asks to change every inheriting project. Consensus members, models, reasoning options, and focus lenses can be changed through role \`consensus\` and take effect on the next hydration.`;

export function implementationEngineInstructions(
  capabilities: ReadonlySet<McpCapability>,
): string | undefined {
  return capabilities.has("engine-knowledge") ? IMPLEMENTATION_ENGINE_INSTRUCTIONS : undefined;
}

export function mcpSessionInstructions(
  capabilities: ReadonlySet<McpCapability>,
): string | undefined {
  const sections = [
    trackedDelegationInstructions(capabilities),
    implementationEngineInstructions(capabilities),
  ].filter((section): section is string => section !== undefined);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

const appendInstructionSection = (
  base: string | undefined,
  section: string | undefined,
): string | undefined => {
  const sections = [base, section].filter((value): value is string => value !== undefined);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
};

export const buildMcpSessionInstructions = Effect.fn("buildMcpSessionInstructions")(function* (
  session: McpProviderSessionConfig,
): Effect.fn.Return<string | undefined, never, SkillRepository | ProjectionProjectRepository> {
  const fallback = mcpSessionInstructions(session.capabilities);
  const loadCatalog = Effect.gen(function* () {
    const skills = yield* SkillRepository;
    const projects = yield* ProjectionProjectRepository;
    const [records, project] = yield* Effect.all(
      [skills.list(), projects.getById({ projectId: session.projectId })],
      { concurrency: "unbounded" },
    );
    const projectSkillOverrides = Option.isSome(project)
      ? project.value.mcpOverrides?.skills
      : undefined;
    return appendInstructionSection(
      fallback,
      renderSkillCatalogSection({
        skills: records,
        projectSkillOverrides,
        capabilities: session.capabilities,
      }),
    );
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
    defaultValue: () => (session) => Effect.succeed(mcpSessionInstructions(session.capabilities)),
  },
) {}

export const makeMcpSessionInstructionBuilder = Effect.fn("makeMcpSessionInstructionBuilder")(
  function* (): Effect.fn.Return<
    McpSessionInstructionBuilder,
    never,
    SkillRepository | ProjectionProjectRepository
  > {
    const skills = yield* SkillRepository;
    const projects = yield* ProjectionProjectRepository;
    return (session) =>
      buildMcpSessionInstructions(session).pipe(
        Effect.provideService(SkillRepository, skills),
        Effect.provideService(ProjectionProjectRepository, projects),
      );
  },
);

export interface UntrackedDelegationAttempt {
  readonly provider: "codex" | "cursor" | "claude";
  readonly trackedTool: "codex_start" | "cursor_start" | "claude_start";
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
