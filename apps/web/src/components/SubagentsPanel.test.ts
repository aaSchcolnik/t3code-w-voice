import {
  EnvironmentId,
  DelegationAttemptId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  type SubagentRun,
  type SubagentRunDetails,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { BrainIcon, SearchIcon, ShieldCheckIcon, WorkflowIcon, WrenchIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  flattenSubagentRunTree,
  groupWorkflowChildrenByPhase,
  partitionSubagentRuns,
  reconcileWorkflowCollapseState,
  subagentRunIdForActivation,
  SubagentsPanel,
  workflowIconFor,
} from "./SubagentsPanel";
import {
  findNewActiveSubagentRun,
  hasDetailedSubagentTranscript,
  isActiveSubagentStatus,
  resolveSubagentMetadata,
  resolveSubagentRunDiagnostics,
  subagentPhaseLabel,
  subagentSummaryResult,
  subagentStatusLabel,
} from "./subagents/subagentRunPresentation";
import {
  SubagentInputResponseForm,
  SubagentRunDiagnostics,
} from "./subagents/SubagentTranscriptPanel";
import { updateDiagnosticsCollapse } from "./subagents/subagentDiagnosticsCollapse";

const run = (id: string, overrides: Partial<SubagentRun> = {}): SubagentRun => ({
  id: SubagentRunId.make(id),
  source: "native",
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  rootThreadId: ThreadId.make("thread-1"),
  depth: 0,
  title: id,
  taskPreview: id,
  modelResolution: "reported",
  status: "running",
  lastSummary: null,
  finalMessage: null,
  error: null,
  capabilities: {
    canCancel: false,
    canSteer: false,
    canRespond: false,
    canResume: false,
    transcriptQuality: "live",
  },
  createdAt: `2026-07-14T00:00:0${id.length}.000Z`,
  startedAt: "2026-07-14T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-07-14T00:00:00.000Z",
  sequence: 0,
  ...overrides,
});

const routedRun = (overrides: Partial<SubagentRun> = {}): SubagentRun =>
  run("routed", {
    source: "delegated",
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex-primary"),
    resolvedModel: "gpt-5.6-sol",
    dispatchState: "allocated",
    ...overrides,
  });

describe("flattenSubagentRunTree", () => {
  it("keeps children grouped beneath parents within a section", () => {
    const root = run("root");
    const child = run("child", {
      parentRunId: root.id,
      depth: 1,
    });
    const sibling = run("sibling");

    expect(
      flattenSubagentRunTree([child, sibling, root], new Set()).map(({ run, depth }) => [
        run.id,
        depth,
      ]),
    ).toEqual([
      ["sibling", 0],
      ["root", 0],
      ["child", 1],
    ]);
  });

  it("resets display depth when a parent belongs to another section", () => {
    const child = run("child", { depth: 1 });
    expect(flattenSubagentRunTree([child], new Set())[0]).toMatchObject({ depth: 0 });
  });

  it("separates active and terminal runs into their status buckets", () => {
    const running = run("running");
    const waiting = run("waiting", { status: "waiting_for_input" });
    const completed = run("completed", { status: "completed" });
    const failed = run("failed", { status: "failed" });

    const partitioned = partitionSubagentRuns([completed, running, failed, waiting]);
    expect(partitioned.active.map(({ id }) => id)).toEqual(["running", "waiting"]);
    expect(partitioned.done.map(({ id }) => id)).toEqual(["completed", "failed"]);
  });

  it("pulls workflow roots and descendants out of active and done sections", () => {
    const workflow = run("workflow", {
      runKind: "workflow",
      workflow: { runId: "wf_example" },
    });
    const completedAgent = run("workflow-agent", {
      parentRunId: workflow.id,
      depth: 1,
      status: "completed",
      workflow: { runId: "wf_example", agentIndex: 1 },
    });
    const nested = run("workflow-descendant", {
      parentRunId: completedAgent.id,
      depth: 2,
    });
    const regular = run("regular");

    const partitioned = partitionSubagentRuns([completedAgent, nested, regular, workflow]);
    expect(partitioned.workflows.map(({ id }) => id)).toEqual([
      "workflow-agent",
      "workflow-descendant",
      "workflow",
    ]);
    expect(partitioned.active.map(({ id }) => id)).toEqual(["regular"]);
    expect(partitioned.done).toEqual([]);
  });

  it("hides descendants when a parent is collapsed", () => {
    const root = run("root");
    const child = run("child", { parentRunId: root.id, depth: 1 });
    const flattened = flattenSubagentRunTree([root, child], new Set(["root"]));
    expect(flattened.map(({ run }) => run.id)).toEqual(["root"]);
    expect(flattened[0]).toMatchObject({ hasChildren: true, collapsed: true });
  });
});

describe("groupWorkflowChildrenByPhase", () => {
  it("sorts phases and agents while keeping phase-less agents in an untitled final group", () => {
    const phaseTwoAgentTwo = run("phase-2-agent-2", {
      workflow: { runId: "wf_example", phaseIndex: 2, phaseTitle: "Review", agentIndex: 4 },
    });
    const phaseOne = run("phase-1", {
      workflow: { runId: "wf_example", phaseIndex: 1, phaseTitle: "Plan", agentIndex: 1 },
    });
    const phaseTwoAgentOne = run("phase-2-agent-1", {
      workflow: { runId: "wf_example", phaseIndex: 2, phaseTitle: "Review", agentIndex: 3 },
    });
    const unphased = run("unphased", {
      workflow: { runId: "wf_example", agentIndex: 2 },
    });

    const groups = groupWorkflowChildrenByPhase([
      phaseTwoAgentTwo,
      unphased,
      phaseOne,
      phaseTwoAgentOne,
    ]);
    expect(
      groups.map((group) => ({
        phaseIndex: group.phaseIndex,
        phaseTitle: group.phaseTitle,
        ids: group.children.map(({ id }) => id),
      })),
    ).toEqual([
      { phaseIndex: 1, phaseTitle: "Plan", ids: ["phase-1"] },
      {
        phaseIndex: 2,
        phaseTitle: "Review",
        ids: ["phase-2-agent-1", "phase-2-agent-2"],
      },
      { phaseIndex: null, phaseTitle: null, ids: ["unphased"] },
    ]);
  });
});

describe("workflowIconFor", () => {
  it("maps workflow intent keywords to semantic icons", () => {
    expect(workflowIconFor("Plan the migration")).toBe(BrainIcon);
    expect(workflowIconFor("Verify implementation")).toBe(ShieldCheckIcon);
    expect(workflowIconFor("Research dependencies")).toBe(SearchIcon);
    expect(workflowIconFor("Fix the adapter")).toBe(WrenchIcon);
    expect(workflowIconFor("Coordinate agents")).toBe(WorkflowIcon);
  });
});

describe("reconcileWorkflowCollapseState", () => {
  it("auto-collapses only on terminal transitions and preserves a user expansion", () => {
    const terminalWorkflow = run("workflow", {
      runKind: "workflow",
      workflow: { runId: "wf_example" },
      status: "completed",
    });
    const transitioned = reconcileWorkflowCollapseState(
      [terminalWorkflow],
      new Set(),
      new Set(),
      new Set(),
    );
    expect([...transitioned.collapsedIds]).toEqual(["workflow"]);

    const userExpanded = reconcileWorkflowCollapseState(
      [terminalWorkflow, run("unrelated")],
      new Set(),
      new Set(),
      transitioned.terminalWorkflowIds,
    );
    expect([...userExpanded.collapsedIds]).toEqual([]);
  });

  it("re-expands an automatically collapsed workflow when it retries", () => {
    const runningWorkflow = run("workflow", {
      runKind: "workflow",
      workflow: { runId: "wf_example" },
      status: "running",
    });
    const retried = reconcileWorkflowCollapseState(
      [runningWorkflow],
      new Set(["workflow"]),
      new Set(["workflow"]),
      new Set(["workflow"]),
    );

    expect([...retried.collapsedIds]).toEqual([]);
    expect([...retried.autoCollapsedIds]).toEqual([]);
  });
});

describe("SubagentsPanel", () => {
  it("selects a notified run when present and safely falls back when it is gone", () => {
    const notification = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      runId: SubagentRunId.make("notified"),
      nonce: 1,
    };

    expect(subagentRunIdForActivation([run("notified")], notification)).toBe("notified");
    expect(subagentRunIdForActivation([], notification)).toBeNull();
  });

  it("renders active and terminal runs in separate sections", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsPanel, {
        runs: [run("running"), run("completed", { status: "completed" })],
        provider: undefined,
        providers: [],
        fallbackDriverKind: ProviderDriverKind.make("codex"),
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    );

    expect(html).toContain('aria-label="Active subagents"');
    expect(html).toContain('aria-label="Done subagents"');
  });

  it("renders dynamic workflows first with stats and phase-grouped agent rows", () => {
    const workflow = run("workflow", {
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      runKind: "workflow",
      workflow: {
        runId: "wf_example",
        name: "Verify migration",
        scriptPath: "/tmp/workflows/verify.js",
      },
      title: "Verify migration",
      taskPreview: "Verify the migration",
      stats: { agentCount: 2, totalTokens: 900, totalToolCalls: 11 },
      capabilities: {
        canCancel: true,
        canSteer: false,
        canRespond: false,
        canResume: false,
        transcriptQuality: "summary",
      },
    });
    const workflowAgent = run("workflow-agent", {
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      parentRunId: workflow.id,
      depth: 1,
      title: "verify:contracts",
      workflow: {
        runId: "wf_example",
        phaseIndex: 1,
        phaseTitle: "Verify",
        agentIndex: 1,
      },
      capabilities: {
        canCancel: false,
        canSteer: false,
        canRespond: false,
        canResume: false,
        transcriptQuality: "summary",
      },
    });
    const active = run("regular-active");

    const html = renderToStaticMarkup(
      createElement(SubagentsPanel, {
        runs: [active, workflowAgent, workflow],
        provider: undefined,
        providers: [],
        fallbackDriverKind: ProviderDriverKind.make("claudeAgent"),
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    );

    expect(html).toContain('aria-label="Dynamic workflow subagents"');
    expect(html).toContain("2 agents · 900 tokens");
    expect(html).toContain('aria-label="View Verify migration workflow script"');
    expect(html).toContain(">Verify<");
    expect(html).toContain("verify:contracts");
    expect(html.indexOf("Dynamic workflow")).toBeLessThan(html.indexOf("Active subagents"));
  });

  it("collapses workflows that are already terminal", () => {
    const workflow = run("terminal-workflow", {
      runKind: "workflow",
      workflow: { runId: "wf_terminal" },
      status: "completed",
    });
    const child = run("hidden-workflow-agent", {
      parentRunId: workflow.id,
      depth: 1,
      status: "completed",
      workflow: { runId: "wf_terminal", agentIndex: 1 },
    });

    const html = renderToStaticMarkup(
      createElement(SubagentsPanel, {
        runs: [child, workflow],
        provider: undefined,
        providers: [],
        fallbackDriverKind: ProviderDriverKind.make("claudeAgent"),
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    );

    expect(html).toContain("Expand terminal-workflow subagents");
    expect(html).not.toContain("hidden-workflow-agent");
  });

  it("renders plain metadata without provider or transcript badges", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsPanel, {
        runs: [
          run("metadata", {
            resolvedModel: "gpt-5.6-sol",
            resolvedOptionDetails: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                value: "medium",
                valueLabel: "Medium",
              },
              {
                id: "serviceTier",
                label: "Service Tier",
                value: "default",
                valueLabel: "Standard",
              },
            ],
          }),
        ],
        provider: undefined,
        providers: [],
        fallbackDriverKind: ProviderDriverKind.make("codex"),
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    );

    expect(html).toContain("GPT 5.6 Sol · Medium Reasoning · Standard");
    expect(html).not.toContain("Live transcript");
    expect(html).not.toContain(">Codex<");
  });
});

describe("subagent status presentation", () => {
  it("uses the summary view when a provider cannot supply detailed child events", () => {
    expect(hasDetailedSubagentTranscript("live")).toBe(true);
    expect(hasDetailedSubagentTranscript("replay")).toBe(true);
    expect(hasDetailedSubagentTranscript("summary")).toBe(false);
    expect(hasDetailedSubagentTranscript("none")).toBe(false);
  });

  it("uses non-color labels for waiting, paused, unknown, and terminal states", () => {
    expect(subagentStatusLabel("waiting_for_input")).toBe("Waiting for input");
    expect(subagentStatusLabel("paused")).toBe("Paused");
    expect(subagentStatusLabel("unknown")).toBe("State unknown");
    expect(subagentStatusLabel("cancelled")).toBe("Cancelled");
    expect(isActiveSubagentStatus("paused")).toBe(true);
    expect(isActiveSubagentStatus("failed")).toBe(false);
  });

  it("detects the first newly started run for panel auto-open", () => {
    const existing = run("existing");
    const started = run("started", { status: "starting" });
    expect(findNewActiveSubagentRun([existing, started], new Set(["existing"]))?.id).toBe(
      "started",
    );
    expect(findNewActiveSubagentRun([existing], new Set(["existing"]))).toBeUndefined();
  });

  it("reports routed dispatch phases without claiming allocation is running", () => {
    expect(subagentPhaseLabel(routedRun({ dispatchState: "allocated" }))).toBe("Allocated");
    expect(subagentPhaseLabel(routedRun({ dispatchState: "session_starting" }))).toBe(
      "Session starting",
    );
    expect(subagentPhaseLabel(routedRun({ dispatchState: "session_started" }))).toBe(
      "Session started",
    );
    expect(subagentPhaseLabel(routedRun({ dispatchState: "dispatch_started" }))).toBe(
      "Dispatch started",
    );
    expect(subagentPhaseLabel(routedRun({ dispatchState: "turn_accepted" }))).toBe("Turn accepted");
    expect(
      subagentPhaseLabel(
        routedRun({ dispatchState: "turn_accepted", status: "waiting_for_input" }),
      ),
    ).toBe("Waiting for input");
  });

  it("renders direct provider metadata and a truthful allocation phase in the live list", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentsPanel, {
        runs: [routedRun()],
        provider: undefined,
        providers: [],
        fallbackDriverKind: ProviderDriverKind.make("codex"),
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    );

    expect(html).toContain("GPT 5.6 Sol");
    expect(html).toContain("Allocated");
    expect(html).not.toContain(">Running<");
  });
});

describe("subagent metadata presentation", () => {
  it("orders model, reasoning, and mode as plain-language metadata", () => {
    const metadataRun = run("metadata", {
      resolvedModel: "gpt-5.6-sol",
      resolvedOptionDetails: [
        {
          id: "serviceTier",
          label: "Service Tier",
          value: "default",
          valueLabel: "Standard",
        },
        {
          id: "reasoningEffort",
          label: "Reasoning",
          value: "medium",
          valueLabel: "Medium",
        },
      ],
    });

    expect(resolveSubagentMetadata(metadataRun)).toEqual([
      "GPT 5.6 Sol",
      "Medium Reasoning",
      "Standard",
    ]);
  });

  it("removes Claude context transport suffixes from historical runs", () => {
    expect(resolveSubagentMetadata(run("claude", { resolvedModel: "claude-fable-5[1m]" }))).toEqual(
      ["Claude Fable 5"],
    );
  });

  it("uses a catalog model name without tag-like slug separators", () => {
    const metadataRun = run("catalog", { resolvedModel: "gpt-5.6-sol" });
    const provider = {
      instanceId: ProviderInstanceId.make("codex"),
      models: [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6-Sol",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ],
    };

    expect(resolveSubagentMetadata(metadataRun, provider)).toEqual(["GPT 5.6 Sol"]);
  });
});

describe("delegated run diagnostics", () => {
  it("renders direct dispatch attempts without legacy routing metadata", () => {
    const delegated = routedRun({
      terminalEventSeen: true,
      resultCompleteness: "terminal_message",
    });
    const details = {
      runId: delegated.id,
      source: "delegated",
      attempts: [
        {
          attemptId: DelegationAttemptId.make("attempt-1"),
          target: {
            provider: "codex",
            providerInstanceId: ProviderInstanceId.make("codex-primary"),
            model: "gpt-5.6-sol",
          },
          dispatchState: "turn_accepted",
          allocatedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    } as SubagentRunDetails;

    expect(resolveSubagentRunDiagnostics(delegated, details)).toMatchObject({
      attempts: [{ target: "codex-primary / gpt-5.6-sol", phase: "Turn accepted" }],
    });
    const html = renderToStaticMarkup(
      createElement(SubagentRunDiagnostics, { run: delegated, details }),
    );
    expect(html).toContain("Run diagnostics");
    expect(html).toContain("Attempt history");
    expect(html).not.toContain("Worker route");
    expect(html).not.toContain("Route decision");
  });
});

describe("subagent diagnostics collapse behavior", () => {
  it("auto-collapses after user scrolling and expands again at the top", () => {
    const initial = { manual: false, automatic: false };
    const scrolled = updateDiagnosticsCollapse(initial, {
      type: "user-scroll",
      atTop: false,
    });
    expect(scrolled).toEqual({ manual: false, automatic: true });
    expect(
      updateDiagnosticsCollapse(scrolled, {
        type: "user-scroll",
        atTop: true,
      }),
    ).toEqual(initial);
  });

  it("keeps a manual collapse closed across scroll position changes", () => {
    const collapsed = updateDiagnosticsCollapse(
      { manual: false, automatic: false },
      { type: "toggle" },
    );
    expect(collapsed).toEqual({ manual: true, automatic: false });
    expect(
      updateDiagnosticsCollapse(collapsed, {
        type: "user-scroll",
        atTop: true,
      }),
    ).toBe(collapsed);
  });

  it("allows an automatically or manually collapsed diagnostics to be reopened", () => {
    expect(
      updateDiagnosticsCollapse(
        { manual: false, automatic: true },
        {
          type: "toggle",
        },
      ),
    ).toEqual({ manual: false, automatic: false });
    expect(
      updateDiagnosticsCollapse(
        { manual: true, automatic: false },
        {
          type: "toggle",
        },
      ),
    ).toEqual({ manual: false, automatic: false });
  });
});

describe("subagent input response", () => {
  it("renders server-authored options, custom answers, and the supported response action", () => {
    const waiting = routedRun({
      status: "waiting_for_input",
      capabilities: {
        canCancel: true,
        canSteer: false,
        canRespond: true,
        canResume: false,
        transcriptQuality: "live",
      },
      sequence: 7,
    });
    const details = {
      runId: waiting.id,
      source: "delegated",
      attempts: [],
      pendingQuestions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which packages should I inspect?",
          options: [
            { label: "Server", description: "Inspect server orchestration." },
            { label: "Web", description: "Inspect the web client." },
          ],
          multiSelect: true,
        },
      ],
    } satisfies SubagentRunDetails;

    const html = renderToStaticMarkup(
      createElement(SubagentInputResponseForm, {
        run: waiting,
        details,
        onSubmit: () => Promise.resolve(),
      }),
    );

    expect(html).toContain("Input required");
    expect(html).toContain("Which packages should I inspect?");
    expect(html).toContain("Server");
    expect(html).toContain("Or type a custom answer");
    expect(html).toContain("Submit answers");
  });

  it("does not expose an action without server-authored response capability", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentInputResponseForm, {
        run: routedRun({ status: "waiting_for_input" }),
        details: {
          runId: SubagentRunId.make("routed"),
          source: "delegated",
          attempts: [],
          pendingQuestions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which package?",
              options: [{ label: "Server", description: "Inspect the server." }],
              multiSelect: false,
            },
          ],
        },
        onSubmit: () => Promise.resolve(),
      }),
    );

    expect(html).toBe("");
  });
});

describe("subagent summary result", () => {
  it("prefers the error for failed agents even when progress summaries exist", () => {
    expect(
      subagentSummaryResult(
        run("failed-agent", {
          status: "failed",
          error: "Contract verification failed",
          finalMessage: "A stale final message",
          lastSummary: "Running contract verification",
        }),
      ),
    ).toBe("Contract verification failed");
  });
});
