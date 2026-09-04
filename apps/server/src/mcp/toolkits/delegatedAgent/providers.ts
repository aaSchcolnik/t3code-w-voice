import { makeDelegatedAgentToolkit } from "./makeDelegatedAgentToolkit.ts";

export const codexAgent = makeDelegatedAgentToolkit({
  provider: "codex",
  shellCommandHint: "codex exec",
});

export const cursorAgent = makeDelegatedAgentToolkit({
  provider: "cursor",
  shellCommandHint: "cursor-agent",
});

export const claudeAgent = makeDelegatedAgentToolkit({
  provider: "claudeAgent",
  shellCommandHint: "claude -p",
});

export const antigravityAgent = makeDelegatedAgentToolkit({
  provider: "antigravity",
  shellCommandHint: "the ACP executable",
  startNotes: "The provider's configured Google identity and permission settings apply.",
});

export const opencodeAgent = makeDelegatedAgentToolkit({
  provider: "opencode",
  shellCommandHint: "opencode run",
  startNotes:
    'Select the OpenCode agent persona and reasoning effort through `options`: `{ id: "agent", value: "build" | "plan" | <custom workspace agent> }` and `{ id: "variant", value: "low" | "medium" | "high" | "xhigh" }`. `interactionMode: "plan"` is shorthand for the plan agent. OpenCode has no fixed default model, so call opencode_capabilities and pass `model` explicitly.',
});

export const DELEGATED_AGENT_TOOLKITS = [
  codexAgent,
  cursorAgent,
  claudeAgent,
  antigravityAgent,
  opencodeAgent,
] as const;
