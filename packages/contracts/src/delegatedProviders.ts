import * as Schema from "effect/Schema";

/**
 * Single source of truth for delegated-run providers. Catalogs, MCP toolkits,
 * settings rows, and shell-interception policy all derive from this table.
 *
 * Lives in its own module so `delegation.ts` and `delegatedRun.ts` can share it
 * without a circular import.
 */
export const DelegatedRunProvider = Schema.Literals([
  "codex",
  "cursor",
  "claudeAgent",
  "antigravity",
  "opencode",
]);
export type DelegatedRunProvider = typeof DelegatedRunProvider.Type;

export interface DelegatedProviderSpec {
  readonly label: string;
  readonly toolPrefix: string;
  readonly capability:
    | "codex-agent"
    | "cursor-agent"
    | "claude-agent"
    | "antigravity-agent"
    | "opencode-agent";
  readonly settingKey:
    | "codexAgent"
    | "cursorAgent"
    | "claudeAgent"
    | "antigravityAgent"
    | "opencodeAgent";
  readonly supportsQuestions: boolean;
}

export const DELEGATED_PROVIDERS = {
  codex: {
    label: "Codex",
    toolPrefix: "codex",
    capability: "codex-agent",
    settingKey: "codexAgent",
    supportsQuestions: false,
  },
  cursor: {
    label: "Cursor",
    toolPrefix: "cursor",
    capability: "cursor-agent",
    settingKey: "cursorAgent",
    supportsQuestions: true,
  },
  claudeAgent: {
    label: "Claude",
    toolPrefix: "claude",
    capability: "claude-agent",
    settingKey: "claudeAgent",
    supportsQuestions: false,
  },
  antigravity: {
    label: "Antigravity",
    toolPrefix: "antigravity",
    capability: "antigravity-agent",
    settingKey: "antigravityAgent",
    supportsQuestions: false,
  },
  opencode: {
    label: "OpenCode",
    toolPrefix: "opencode",
    capability: "opencode-agent",
    settingKey: "opencodeAgent",
    supportsQuestions: true,
  },
} as const satisfies Record<DelegatedRunProvider, DelegatedProviderSpec>;

export type DelegatedProviderSettingKey =
  (typeof DELEGATED_PROVIDERS)[DelegatedRunProvider]["settingKey"];

export type DelegatedProviderCapability =
  (typeof DELEGATED_PROVIDERS)[DelegatedRunProvider]["capability"];

export const delegatedToolName = <
  P extends DelegatedRunProvider,
  S extends "capabilities" | "start" | "cancel" | "respond",
>(
  provider: P,
  suffix: S,
) => `${DELEGATED_PROVIDERS[provider].toolPrefix}_${suffix}` as const;
