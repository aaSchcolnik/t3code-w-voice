import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ClaudeStartTool } from "../claudeAgent/tools.ts";
import { CodexStartTool } from "../codexAgent/tools.ts";
import { CursorStartTool } from "../cursorAgent/tools.ts";
import { DelegateStartTool } from "./tools.ts";

it("requires idempotency for neutral starts and keeps compatibility keys optional", () => {
  const neutral = Tool.getJsonSchema(DelegateStartTool);
  expect(neutral.required).toEqual(expect.arrayContaining(["idempotencyKey", "tasks"]));
  expect(neutral).toMatchObject({
    properties: {
      tasks: {
        items: {
          properties: {
            workspaceAccess: { description: expect.stringContaining("read-only") },
          },
          required: expect.arrayContaining(["laneId", "workspaceAccess"]),
        },
      },
    },
  });

  for (const tool of [CodexStartTool, CursorStartTool, ClaudeStartTool]) {
    const schema = Tool.getJsonSchema(tool);
    expect(schema.properties).toHaveProperty("idempotencyKey");
    expect(schema.required).not.toContain("idempotencyKey");
    expect(tool.description).toContain("no retry deduplication");
  }
});

it("describes allocation without claiming provider acceptance", () => {
  expect(DelegateStartTool.description).toContain("requires all four fields");
  expect(DelegateStartTool.description).toContain("workspaceAccess");
  expect(DelegateStartTool.description).toContain("durable allocation only");
  expect(DelegateStartTool.description).toContain("does not claim");
});
