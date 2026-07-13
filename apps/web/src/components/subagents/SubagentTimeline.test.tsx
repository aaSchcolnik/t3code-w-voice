import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (row: { id: string }) => string;
    renderItem: (input: { item: { id: string } }) => ReactNode;
  }) => (
    <div>
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));

import type { SubagentEntry } from "../../session-logic";
import { SubagentTimeline } from "./SubagentTimeline";
import { subagentTimelineFixtures } from "./SubagentTimeline.test-fixtures";

const completedEntry: SubagentEntry = {
  id: "subagent-1",
  name: "Inspector",
  lastMessage: "The project is healthy.",
  status: "done",
  outcome: "completed",
  turnId: "turn-1" as never,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:12.000Z",
  providerInstanceId: null,
  source: "delegated",
  providerDriver: null,
  model: null,
  reasoningEffort: null,
  agentType: null,
  transcriptId: "transcript-1",
};

describe("SubagentTimeline", () => {
  it("renders a completed transcript with an accessible fold and visible final answer", () => {
    const html = renderToStaticMarkup(
      <SubagentTimeline
        transcript={subagentTimelineFixtures.completedTurn.transcript}
        entry={completedEntry}
        cwd="/workspace/project/packages/app"
        workspaceRoot="/workspace/project"
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Expand Worked for 12s"');
    expect(html).toContain("The project is healthy.");
    expect(html).not.toContain("I will inspect the relevant files.");
  });
});
