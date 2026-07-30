import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  UNSUPPORTED_PROVIDER_DELEGATION_CAPABILITIES,
  type ProviderDelegationCapabilities,
} from "../Services/ProviderAdapter.ts";
import { CLAUDE_DELEGATION_CAPABILITIES, CLAUDE_INSTRUCTION_DELIVERY } from "./ClaudeAdapter.ts";
import { CODEX_DELEGATION_CAPABILITIES, CODEX_INSTRUCTION_DELIVERY } from "./CodexAdapter.ts";
import { CURSOR_DELEGATION_CAPABILITIES, CURSOR_INSTRUCTION_DELIVERY } from "./CursorAdapter.ts";
import { GROK_DELEGATION_CAPABILITIES, GROK_INSTRUCTION_DELIVERY } from "./GrokAdapter.ts";
import {
  OPENCODE_DELEGATION_CAPABILITIES,
  OPENCODE_INSTRUCTION_DELIVERY,
} from "./OpenCodeAdapter.ts";
import { enumerateDelegatedProviderCandidates } from "./ProviderRegistry.ts";

const makeSnapshot = (
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-29T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const makeCandidateInstance = (
  instanceId: string,
  driver: string,
  delegation: ProviderDelegationCapabilities,
) => {
  const driverKind = ProviderDriverKind.make(driver);
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind,
    adapter: {
      provider: driverKind,
      capabilities: {
        sessionModelSwitch: "in-session" as const,
        delegation,
      },
    },
  };
};

describe("provider delegation capability declarations", () => {
  it("enables delegated execution only for Codex, Claude, and Cursor", () => {
    expect({
      codex: CODEX_DELEGATION_CAPABILITIES.delegatedExecution,
      claudeAgent: CLAUDE_DELEGATION_CAPABILITIES.delegatedExecution,
      cursor: CURSOR_DELEGATION_CAPABILITIES.delegatedExecution,
      grok: GROK_DELEGATION_CAPABILITIES.delegatedExecution,
      opencode: OPENCODE_DELEGATION_CAPABILITIES.delegatedExecution,
    }).toEqual({
      codex: true,
      claudeAgent: true,
      cursor: true,
      grok: false,
      opencode: false,
    });
  });

  it("declares the tested execution, workspace, resume, and usage matrix", () => {
    const summarize = (capabilities: ProviderDelegationCapabilities) => ({
      cancellation: capabilities.cancellation,
      structuredQuestions: capabilities.structuredQuestions,
      attachments: capabilities.attachments,
      enforcedReadOnlyWorkspace: capabilities.enforcedReadOnlyWorkspace,
      workspaceWriteSandboxContainment: capabilities.workspaceWriteSandboxContainment,
      providerThreadResume: capabilities.providerThreadResume,
      usageReporting: capabilities.usageReporting,
    });

    expect({
      codex: summarize(CODEX_DELEGATION_CAPABILITIES),
      claudeAgent: summarize(CLAUDE_DELEGATION_CAPABILITIES),
      cursor: summarize(CURSOR_DELEGATION_CAPABILITIES),
      grok: summarize(GROK_DELEGATION_CAPABILITIES),
      opencode: summarize(OPENCODE_DELEGATION_CAPABILITIES),
    }).toEqual({
      codex: {
        cancellation: true,
        structuredQuestions: true,
        attachments: true,
        enforcedReadOnlyWorkspace: true,
        workspaceWriteSandboxContainment: true,
        providerThreadResume: true,
        usageReporting: "correlated",
      },
      claudeAgent: {
        cancellation: true,
        structuredQuestions: true,
        attachments: true,
        enforcedReadOnlyWorkspace: false,
        workspaceWriteSandboxContainment: false,
        providerThreadResume: true,
        usageReporting: "correlated",
      },
      cursor: {
        cancellation: true,
        structuredQuestions: true,
        attachments: true,
        enforcedReadOnlyWorkspace: false,
        workspaceWriteSandboxContainment: false,
        providerThreadResume: true,
        usageReporting: "unsupported",
      },
      grok: {
        cancellation: true,
        structuredQuestions: true,
        attachments: true,
        enforcedReadOnlyWorkspace: false,
        workspaceWriteSandboxContainment: false,
        providerThreadResume: true,
        usageReporting: "unsupported",
      },
      opencode: {
        cancellation: true,
        structuredQuestions: true,
        attachments: true,
        enforcedReadOnlyWorkspace: false,
        workspaceWriteSandboxContainment: false,
        providerThreadResume: true,
        usageReporting: "unsupported",
      },
    });
  });

  it("keeps instruction delivery adapter-owned and preserves the provider exports", () => {
    expect(CODEX_DELEGATION_CAPABILITIES.instructionDelivery).toBe(CODEX_INSTRUCTION_DELIVERY);
    expect(CLAUDE_DELEGATION_CAPABILITIES.instructionDelivery).toBe(CLAUDE_INSTRUCTION_DELIVERY);
    expect(CURSOR_DELEGATION_CAPABILITIES.instructionDelivery).toBe(CURSOR_INSTRUCTION_DELIVERY);
    expect(GROK_DELEGATION_CAPABILITIES.instructionDelivery).toBe(GROK_INSTRUCTION_DELIVERY);
    expect(OPENCODE_DELEGATION_CAPABILITIES.instructionDelivery).toBe(
      OPENCODE_INSTRUCTION_DELIVERY,
    );
  });

  it("defaults definitely_not_accepted dispatch outcomes to unsupported", () => {
    expect(UNSUPPORTED_PROVIDER_DELEGATION_CAPABILITIES.definitelyNotAcceptedDispatchOutcome).toBe(
      "unsupported",
    );
    for (const capabilities of [
      CODEX_DELEGATION_CAPABILITIES,
      CLAUDE_DELEGATION_CAPABILITIES,
      CURSOR_DELEGATION_CAPABILITIES,
      GROK_DELEGATION_CAPABILITIES,
      OPENCODE_DELEGATION_CAPABILITIES,
    ]) {
      expect(capabilities.definitelyNotAcceptedDispatchOutcome).toBe("unsupported");
    }
  });
});

describe("enumerateDelegatedProviderCandidates", () => {
  it("uses concrete adapter declarations without a provider-kind allowlist", () => {
    const providers = [
      makeSnapshot("codex_work", "codex"),
      makeSnapshot("claude_personal", "claudeAgent"),
      makeSnapshot("cursor", "cursor"),
      makeSnapshot("grok", "grok"),
      makeSnapshot("opencode", "opencode"),
    ];
    const instances = [
      makeCandidateInstance("codex_work", "codex", CODEX_DELEGATION_CAPABILITIES),
      makeCandidateInstance("claude_personal", "claudeAgent", CLAUDE_DELEGATION_CAPABILITIES),
      makeCandidateInstance("cursor", "cursor", CURSOR_DELEGATION_CAPABILITIES),
      makeCandidateInstance("grok", "grok", GROK_DELEGATION_CAPABILITIES),
      makeCandidateInstance("opencode", "opencode", OPENCODE_DELEGATION_CAPABILITIES),
    ];

    expect(
      enumerateDelegatedProviderCandidates({ providers, instances }).map(
        (candidate) => candidate.snapshot.instanceId,
      ),
    ).toEqual(["codex_work", "claude_personal", "cursor"]);
  });

  it("excludes disabled, uninstalled, unavailable, and uncorrelated snapshots", () => {
    const providers = [
      makeSnapshot("codex_disabled", "codex", { enabled: false }),
      makeSnapshot("codex_missing", "codex", { installed: false }),
      makeSnapshot("codex_unavailable", "codex", {
        availability: "unavailable",
        unavailableReason: "not registered",
      }),
      makeSnapshot("codex_uncorrelated", "codex"),
      makeSnapshot("codex_ready", "codex"),
    ];
    const instances = [
      makeCandidateInstance("codex_disabled", "codex", CODEX_DELEGATION_CAPABILITIES),
      makeCandidateInstance("codex_missing", "codex", CODEX_DELEGATION_CAPABILITIES),
      makeCandidateInstance("codex_unavailable", "codex", CODEX_DELEGATION_CAPABILITIES),
      makeCandidateInstance("codex_ready", "codex", CODEX_DELEGATION_CAPABILITIES),
    ];

    expect(
      enumerateDelegatedProviderCandidates({ providers, instances }).map(
        (candidate) => candidate.snapshot.instanceId,
      ),
    ).toEqual(["codex_ready"]);
  });
});
