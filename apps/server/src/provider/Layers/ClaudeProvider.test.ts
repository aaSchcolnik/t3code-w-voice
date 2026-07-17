import { describe, expect, it } from "vite-plus/test";

import {
  resolveClaudeDisplayModelId,
  resolveClaudeNativeSubagentModelId,
} from "./ClaudeProvider.ts";

describe("Claude model presentation", () => {
  it("keeps API context modifiers out of display model ids", () => {
    expect(resolveClaudeDisplayModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
  });

  it("reports a native subagent's requested model instead of its parent model", () => {
    expect(resolveClaudeNativeSubagentModelId("sonnet", "claude-fable-5[1m]")).toBe("sonnet");
    expect(resolveClaudeNativeSubagentModelId(undefined, "claude-fable-5[1m]")).toBe(
      "claude-fable-5",
    );
  });
});
