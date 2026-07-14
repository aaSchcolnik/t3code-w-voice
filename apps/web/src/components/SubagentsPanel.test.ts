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

import { flattenSubagentRunTree, partitionSubagentRuns, SubagentsPanel } from "./SubagentsPanel";
import {
  findNewActiveSubagentRun,
  isActiveSubagentStatus,
  subagentStatusLabel,
  resolveSubagentServiceTierPresentation,
} from "./subagents/subagentRunPresentation";
import { SubagentServiceTierBadge } from "./subagents/SubagentServiceTierBadge";

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
});

describe("subagent status presentation", () => {
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

describe("subagent service tier presentation", () => {
  it("prefers stable stored labels and renders an accessible shared badge", () => {
    const fastRun = run("fast", {
      resolvedOptionDetails: [
        {
          id: "serviceTier",
          label: "Service Tier",
          value: "priority",
          valueLabel: "Fast",
          description: "Lower latency responses.",
        },
      ],
    });
    expect(resolveSubagentServiceTierPresentation(fastRun)).toEqual({
      label: "Fast",
      description: "Lower latency responses.",
    });
    const html = renderToStaticMarkup(createElement(SubagentServiceTierBadge, { run: fastRun }));
    expect(html).toContain('aria-label="Service Tier: Fast"');
    expect(html).toContain("Fast");
  });

  it("reconstructs old raw records only from a matching live descriptor", () => {
    const oldRun = run("old", {
      resolvedModel: "gpt-5.5",
      resolvedOptions: [{ id: "serviceTier", value: "flex" }],
    });
    const provider = {
      instanceId: ProviderInstanceId.make("codex"),
      models: [
        {
          slug: "gpt-5.5",
          name: "GPT 5.5",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "serviceTier",
                label: "Service Tier",
                type: "select" as const,
                options: [{ id: "flex", label: "Flex" }],
              },
            ],
          },
        },
      ],
    };
    expect(resolveSubagentServiceTierPresentation(oldRun, provider)).toEqual({ label: "Flex" });
    expect(resolveSubagentServiceTierPresentation(oldRun)).toBeNull();
  });
});
