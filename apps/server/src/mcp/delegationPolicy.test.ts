import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  detectUntrackedDelegationAttempt,
  trackedDelegationInstructions,
  untrackedDelegationDenialMessage,
} from "./delegationPolicy.ts";
import type { McpCapability } from "./McpInvocationContext.ts";

const capabilities = (...values: McpCapability[]) => new Set(values);

describe("trackedDelegationInstructions", () => {
  it("lists callable direct tools and explains safe parallel starts", () => {
    const instructions = trackedDelegationInstructions(
      capabilities("codex-agent", "cursor-agent"),
      ProviderDriverKind.make("codex"),
      true,
    );
    expect(instructions).toContain("codex_start");
    expect(instructions).toContain("cursor_start");
    expect(instructions).not.toContain("delegate_start");
    expect(instructions).toContain("stable idempotency key");
    expect(instructions).toContain("Subagents panel");
    expect(instructions).toContain("start every needed run before ending the turn");
    expect(instructions).toContain("arrive automatically");
    expect(instructions).toContain("never wait, poll, sleep");
    expect(instructions).toContain("disjoint work");
    expect(instructions).toContain("keep shared files sequential");
    expect(instructions).toContain("Git read-only");
    expect(instructions).toContain("Codex collaboration tools");
    expect(instructions).not.toContain("claude_start");
  });

  it("does not add guidance without a delegation capability", () => {
    expect(trackedDelegationInstructions(capabilities("preview"))).toBeUndefined();
  });

  it("names only callable cross-provider tools and the native same-provider path", () => {
    const instructions = trackedDelegationInstructions(
      capabilities("codex-agent", "claude-agent"),
      ProviderDriverKind.make("cursor"),
      true,
    );
    expect(instructions).toContain("codex_start");
    expect(instructions).toContain("claude_start");
    expect(instructions).not.toContain("cursor_start");
    expect(instructions).toContain("Cursor's native Task mechanism");
  });

  it("does not rank providers and honors explicit provider requests", () => {
    const instructions = trackedDelegationInstructions(
      capabilities("codex-agent", "cursor-agent", "claude-agent"),
      ProviderDriverKind.make("cursor"),
      true,
    );

    if (instructions === undefined) throw new Error("Expected delegation instructions.");
    expect(instructions).toContain("codex_start");
    expect(instructions).toContain("cursor_start");
    expect(instructions).toContain("claude_start");
    expect(instructions).toContain("explicit provider request");
    expect(instructions).toContain("stable idempotency key");
    expect(instructions).not.toContain("1. Codex");
    expect(instructions).not.toContain("delegate_start");
  });
});

describe("detectUntrackedDelegationAttempt", () => {
  it("detects a headless Cursor agent launched through Bash", () => {
    const attempt = detectUntrackedDelegationAttempt(
      "Bash",
      {
        command: "cd /repo && cursor-agent -p --model composer-2.5 'research this'",
        run_in_background: true,
      },
      capabilities("cursor-agent"),
    );
    expect(attempt).toEqual({ provider: "cursor", trackedTool: "cursor_start" });
    expect(untrackedDelegationDenialMessage(attempt!)).toContain("cursor_start");
  });

  it("detects a headless Codex agent launched through a shell", () => {
    expect(
      detectUntrackedDelegationAttempt(
        "shell_command",
        { command: "codex exec --full-auto 'review this repository'" },
        capabilities("codex-agent"),
      ),
    ).toEqual({ provider: "codex", trackedTool: "codex_start" });
  });

  it("detects a Codex companion script launched through Bash", () => {
    expect(
      detectUntrackedDelegationAttempt(
        "Bash",
        {
          command:
            'node "/Users/dev/.claude/plugins/cache/openai-codex/codex/1.0.5/scripts/codex-companion.mjs" task --model gpt-5.6-codex-terra "research this"',
        },
        capabilities("codex-agent"),
      ),
    ).toEqual({ provider: "codex", trackedTool: "codex_start" });
  });

  it("detects provider-specific Claude subagents", () => {
    expect(
      detectUntrackedDelegationAttempt(
        "Agent",
        { subagent_type: "codex:codex-rescue", prompt: "research this" },
        capabilities("codex-agent"),
      ),
    ).toEqual({ provider: "codex", trackedTool: "codex_start" });
    expect(
      detectUntrackedDelegationAttempt(
        "Task",
        { subagentType: "cursor-agent" },
        capabilities("cursor-agent"),
      ),
    ).toEqual({ provider: "cursor", trackedTool: "cursor_start" });
  });

  it("allows ordinary CLI operations and providers without tracked capability", () => {
    expect(
      detectUntrackedDelegationAttempt(
        "Bash",
        { command: "cursor-agent --version" },
        capabilities("cursor-agent"),
      ),
    ).toBeUndefined();
    expect(
      detectUntrackedDelegationAttempt(
        "Bash",
        { command: "cursor-agent -p 'research this'" },
        capabilities("preview"),
      ),
    ).toBeUndefined();
    expect(
      detectUntrackedDelegationAttempt(
        "Agent",
        { subagent_type: "Explore", prompt: "inspect this repository" },
        capabilities("codex-agent"),
      ),
    ).toBeUndefined();
  });
});
