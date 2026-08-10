import type {
  EngineDelegationSettings,
  EngineDelegationRole,
  EngineDelegationSkillOverride,
  EngineDelegationTarget,
  EngineWorkflowName,
} from "@t3tools/contracts";
import { NATIVE_SUBAGENT_MODEL_BY_DRIVER, resolveDelegationRoles } from "@t3tools/contracts";

import type { McpCapability } from "../../mcp/McpInvocationContext.ts";

export interface ResolvedDelegationChains {
  readonly scout: EngineDelegationTarget | undefined;
  readonly worker: EngineDelegationTarget | undefined;
  /** Every available member runs in parallel, not first-available. */
  readonly consensusPanel: ReadonlyArray<EngineDelegationTarget>;
  /** Every configured available scanner runs; inline is the Judge lane. */
  readonly scannerPanel: ReadonlyArray<EngineDelegationTarget>;
}

const providerCapability = {
  codex: "codex-agent",
  cursor: "cursor-agent",
  claudeAgent: "claude-agent",
} as const;

const targetAvailable = (
  target: EngineDelegationTarget,
  capabilities: ReadonlySet<McpCapability>,
): boolean => target.provider === "inline" || capabilities.has(providerCapability[target.provider]);

const firstAvailable = (
  chain: ReadonlyArray<EngineDelegationTarget>,
  capabilities: ReadonlySet<McpCapability>,
): EngineDelegationTarget | undefined =>
  chain.find((target) => targetAvailable(target, capabilities));

function resolveDelegationChain(input: {
  readonly settings: EngineDelegationSettings;
  readonly availableProviders: ReadonlySet<EngineDelegationTarget["provider"]>;
  readonly role: EngineDelegationRole;
  readonly workflow?: EngineWorkflowName | undefined;
  readonly skillOverride?: EngineDelegationSkillOverride | null | undefined;
}): ReadonlyArray<EngineDelegationTarget> {
  const skillChain = input.skillOverride?.[input.role];
  if (skillChain !== undefined) {
    return skillChain;
  }

  const workflowChain =
    input.workflow === undefined
      ? undefined
      : input.settings.skillOverrides[input.workflow]?.[input.role];
  if (workflowChain !== undefined) {
    return workflowChain;
  }

  const roles = resolveDelegationRoles(input.settings, input.availableProviders);
  return roles[input.role];
}

export function resolveDelegationChains(input: {
  readonly settings: EngineDelegationSettings;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly workflow?: EngineWorkflowName | undefined;
  readonly skillOverride?: EngineDelegationSkillOverride | null | undefined;
}): ResolvedDelegationChains {
  const availableProviders = new Set<EngineDelegationTarget["provider"]>();
  if (input.capabilities.has("codex-agent")) availableProviders.add("codex");
  if (input.capabilities.has("cursor-agent")) availableProviders.add("cursor");
  if (input.capabilities.has("claude-agent")) availableProviders.add("claudeAgent");
  availableProviders.add("inline");
  const delegationChain = (role: EngineDelegationRole) =>
    resolveDelegationChain({
      settings: input.settings,
      availableProviders,
      role,
      workflow: input.workflow,
      skillOverride: input.skillOverride,
    });
  const roles = resolveDelegationRoles(input.settings, availableProviders);
  const override =
    input.skillOverride ??
    (input.workflow === undefined ? undefined : input.settings.skillOverrides[input.workflow]);
  return {
    scout: firstAvailable(delegationChain("scout"), input.capabilities),
    worker: firstAvailable(delegationChain("worker"), input.capabilities),
    consensusPanel: (override?.consensus ?? roles.consensus).filter((target) =>
      targetAvailable(target, input.capabilities),
    ),
    scannerPanel: (override?.scanner ?? roles.scanner).filter((target) =>
      targetAvailable(target, input.capabilities),
    ),
  };
}

interface WorkflowDelegationGuidance {
  readonly scout?: string | undefined;
  readonly worker?: string | undefined;
  readonly consensus?: string | undefined;
  readonly judge: string;
}

const parseDelegationGuidance = (markdown: string): WorkflowDelegationGuidance | undefined => {
  const section = markdown.match(/(?:^|\n)## Delegation guidance\s*\n([\s\S]*?)(?=\n## |$)/i)?.[1];
  if (section === undefined) return undefined;
  const roles: Partial<Record<"scout" | "worker" | "consensus" | "judge", string>> = {};
  for (const match of section.matchAll(
    /^\s*-\s+\*\*(Scout|Worker|Consensus|Judge):\*\*\s*(.+)$/gim,
  )) {
    const role = match[1]?.toLowerCase() as keyof typeof roles;
    const value = match[2]?.trim();
    if (value !== undefined && value !== "") roles[role] = value;
  }
  if (roles.judge === undefined) return undefined;
  return {
    ...(roles.scout === undefined ? {} : { scout: roles.scout }),
    ...(roles.worker === undefined ? {} : { worker: roles.worker }),
    ...(roles.consensus === undefined ? {} : { consensus: roles.consensus }),
    judge: roles.judge,
  };
};

const workflowGuidance: Partial<Record<EngineWorkflowName, WorkflowDelegationGuidance>> = {
  "plan-brief": {
    scout:
      "Optionally use one Scout to resolve WHERE (paths and symbols) when the area is unfamiliar.",
    judge: "Keep the scope decision, acceptance criteria, and final brief on the main thread.",
  },
  plan: {
    scout:
      "Use 1–3 parallel Scouts with disjoint scopes to gather owners, exemplars, consumers, call sites, tests, and layer-model evidence.",
    consensus:
      "Run the consensus audit by calling `engine_consensus` on the draft-plan artifact; follow its returned protocol and fold accepted corrections into the plan.",
    judge:
      "Make the design choice, run the fit/risk stress test, compare alternatives, synthesize the plan, and adjudicate every consensus finding yourself on the main thread.",
  },
  consensus: {
    consensus:
      "Fan out the identical subject packet to every panelist in parallel; only the configured focus lens may differ.",
    judge:
      "Own the context gate, collection, disagreement gate, adjudication, artifact persistence, and final report.",
  },
  enrich: {
    scout:
      "In Expand mode, use one Scout per target directory to verify that matched rules and lessons actually apply.",
    judge:
      "Own the concern-map budget, placement decisions, dependency-direction validation, and final artifact updates.",
  },
  implement: {
    worker:
      "Delegate a whole dependency-ready chunk only when its lane permits delegation and its complete intentional edit set is known. Concurrent Workers must have disjoint intentional edit sets.",
    judge:
      "Split chunks, persist engine_chunks_update transitions, verify completeness independently, classify failures, and perform final preview verification on the main thread.",
  },
  "quality-audit": {
    scout:
      "Use one Scout per disjoint directory or rule-pack partition to collect source, caller, test, and rule evidence.",
    judge:
      "Adjudicate dispositions and severity, group findings by root cause, and write the final report on the main thread.",
  },
  "quality-pr": {
    scout:
      "For large diffs only, use one Scout per semantic block to trace callers, contracts, tests, and cross-cutting effects.",
    judge: "Own every verdict and finding write-up on the main thread.",
  },
  "hot-loops": {
    scout:
      "Use disjoint Scouts for surface categories A–F to scan loops, subscriptions, timers, and I/O-in-loop evidence.",
    judge:
      "Estimate frequency × cost × fan-out, distinguish measured from inferred cost, and choose remediation on the main thread.",
  },
};

const renderTarget = (role: string, target: EngineDelegationTarget): string => {
  if (target.provider === "inline") {
    const model = target.model === undefined ? "" : ` using \`${target.model}\``;
    const focus = target.focus === undefined ? "" : ` Focus lens: ${target.focus}.`;
    return `- **${role}:** run this lane inline on the main thread${model}.${focus}`;
  }
  const tool = `${target.provider === "claudeAgent" ? "claude" : target.provider}_start`;
  const parameters = {
    ...(target.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: target.providerInstanceId }),
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(target.options === undefined ? {} : { options: target.options }),
  };
  const renderedParameters =
    Object.keys(parameters).length === 0 ? "" : ` with ${JSON.stringify(parameters)}`;
  const focus = target.focus === undefined ? "" : ` Focus lens: ${target.focus}.`;
  return `- **${role}:** call \`${tool}\`${renderedParameters} and a stable idempotency key.${focus}`;
};

export const renderConsensusPanelTargets = (panel: ReadonlyArray<EngineDelegationTarget>): string =>
  panel
    .map((target, index) =>
      renderTarget(panel.length === 1 ? "Consensus" : `Consensus ${index + 1}`, target),
    )
    .join("\n");

export const renderScannerPanelTargets = (panel: ReadonlyArray<EngineDelegationTarget>): string =>
  panel
    .map((target, index) =>
      renderTarget(panel.length === 1 ? "Scanner" : `Scanner ${index + 1}`, target),
    )
    .join("\n");

export function renderDelegationSection(input: {
  readonly workflow: EngineWorkflowName | string;
  readonly skillMarkdown?: string | undefined;
  readonly resolved: ResolvedDelegationChains;
  readonly previewAvailable?: boolean | undefined;
  readonly consensusAvailable?: boolean | undefined;
  readonly providerDriver?: string | undefined;
}): string {
  const guidance =
    (input.skillMarkdown === undefined
      ? undefined
      : parseDelegationGuidance(input.skillMarkdown)) ??
    workflowGuidance[input.workflow as EngineWorkflowName];
  if (guidance === undefined) return "";

  const previewSection =
    input.workflow === "implement"
      ? input.previewAvailable
        ? `## Final preview verification (Judge-only)

Implementation is not finished until repository/spec checks and this walkthrough pass.

1. **Credentials gate — before any clicking:** determine whether every affected route and flow requires authentication or a test account. If credentials are required and are not already supplied, STOP, ask the user in chat for them, and WAIT for the response. Never invent credentials and never start a walkthrough that will dead-end at a login wall.
2. **Open and navigate:** call \`preview_status\`; when no automation-capable preview is attached, call \`preview_open\`. Navigate to every affected route with \`preview_navigate\`.
3. **Exercise primary flows:** use \`preview_click\`, \`preview_type\`, \`preview_press\`, and \`preview_wait_for\` to cover the changed behavior, including relevant loading, empty, error, permission, and reconnect states.
4. **Inspect:** take \`preview_snapshot\` evidence for visual consistency and state coverage, then use \`preview_evaluate\` to check for console/runtime errors.
5. **Persist evidence:** save a case artifact with kind=preview-verification containing routes visited, flows exercised, snapshots taken, console/runtime results, and every issue found or fixed.

If the change has no UI or route surface, explicitly record that fact in the implementation result instead of silently skipping browser verification.`
        : `## Browser verification availability

This session does not have the preview capability. Finish repository checks and the quality audit, then explicitly report that browser preview verification was unavailable; do not imply that a click-through passed.`
      : "";

  const scout = guidance.scout === undefined ? undefined : input.resolved.scout;
  const worker = guidance.worker === undefined ? undefined : input.resolved.worker;
  const consensusPanel =
    guidance.consensus === undefined || (input.workflow === "plan" && !input.consensusAvailable)
      ? []
      : input.resolved.consensusPanel;
  const planNeedsFallback =
    input.workflow === "plan" &&
    (!input.consensusAvailable || input.resolved.consensusPanel.length === 0);
  const consensusSection = planNeedsFallback
    ? `## Plan consensus audit availability

No external consensus panel is available in this session. Self-review the draft plan against the original request for missing implementation parts and unhandled edge cases, record in the plan that external consensus was unavailable, then persist the final plan and present it via engine_report_render (kind="styled-plan").`
    : "";

  const trailingSections = [consensusSection, previewSection]
    .filter((section) => section !== "")
    .map((section) => `\n\n${section}`)
    .join("");

  if (scout === undefined && worker === undefined && consensusPanel.length === 0) {
    const nativeModel =
      input.providerDriver === undefined
        ? undefined
        : NATIVE_SUBAGENT_MODEL_BY_DRIVER[
            input.providerDriver as keyof typeof NATIVE_SUBAGENT_MODEL_BY_DRIVER
          ];
    const nativeHint =
      nativeModel === undefined
        ? ""
        : ` Use your native subagent facility with model \`${nativeModel}\` for Scout/Worker steps.`;
    return `## Subagent delegation

No tracked subagents are available in this session for this workflow.${nativeHint} Otherwise perform all steps yourself. Do not substitute untracked shell commands or another delegation mechanism.${trailingSections}`;
  }

  const targets = [
    scout === undefined ? undefined : renderTarget("Scout", scout),
    worker === undefined ? undefined : renderTarget("Worker", worker),
    ...(guidance.consensus !== undefined &&
    (input.workflow === "consensus" ||
      workflowGuidance[input.workflow as EngineWorkflowName] === undefined)
      ? renderConsensusPanelTargets(consensusPanel).split("\n").filter(Boolean)
      : []),
  ].filter((line): line is string => line !== undefined);
  const roleSteps = [
    guidance.scout === undefined ? undefined : `- **Scout-delegable:** ${guidance.scout}`,
    guidance.worker === undefined ? undefined : `- **Worker-delegable:** ${guidance.worker}`,
    guidance.consensus === undefined || consensusPanel.length === 0
      ? undefined
      : `- **Consensus-delegable:** ${guidance.consensus}`,
    `- **Judge-only:** ${guidance.judge}`,
  ].filter((line): line is string => line !== undefined);

  return `## Subagent delegation

### Resolved tracked targets
${targets.join("\n")}

### Workflow split
${roleSteps.join("\n")}

### Guardrails
- Call the resolved provider-specific \`cursor_start\`, \`codex_start\`, or \`claude_start\` tool with a stable idempotency key. Start every selected independent target, then end the main-thread turn; results arrive automatically after runs finish.
- Never wait, poll, sleep, or create background polling commands while delegated runs are active.
- Subagents report findings or diffs to the Judge. They never mark chunks complete, write engine artifacts, or adjudicate findings.
- Parallelize only independent lanes. Concurrent Workers require dependency-ready chunks with complete, disjoint intentional edit sets; T3 does not reserve or enforce file ownership.
- Assign shared snapshots, fixtures, generated files, barrels, lockfiles, and configuration to exactly one Worker; otherwise keep the affected work sequential.
- After starting a Worker cohort, do not edit its intended files on the main thread until the cohort finishes.
- Verify every subagent result against source, tests, and artifacts. If verification fails, retry inline; do not re-delegate the same work more than once.${trailingSections}`;
}
