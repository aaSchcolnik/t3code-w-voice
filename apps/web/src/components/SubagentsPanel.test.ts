import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  type SubagentRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  flattenSubagentRunTree,
  partitionSubagentRuns,
  subagentRunIdForActivation,
  SubagentsPanel,
} from "./SubagentsPanel";
import {
  findNewActiveSubagentRun,
  hasDetailedSubagentTranscript,
  isActiveSubagentStatus,
  resolveSubagentMetadata,
  subagentStatusLabel,
} from "./subagents/subagentRunPresentation";

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

  it("hides descendants when a parent is collapsed", () => {
    const root = run("root");
    const child = run("child", { parentRunId: root.id, depth: 1 });
    const flattened = flattenSubagentRunTree([root, child], new Set(["root"]));
    expect(flattened.map(({ run }) => run.id)).toEqual(["root"]);
    expect(flattened[0]).toMatchObject({ hasChildren: true, collapsed: true });
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
