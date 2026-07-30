import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type DelegationPolicySource,
  type DelegationReasonCode,
  type DelegationRouteGroupId,
  type DelegationTaskKind,
  type DelegationTaskSpec,
  type EngineDelegationSettings,
  type EngineDelegationSkillOverride,
  type EngineWorkflowName,
  type ProviderOptionSelections,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import corpusFixture from "./fixtures/delegation-routing-cases.json" with { type: "json" };
import {
  evaluateDelegationBatch,
  makeTrustedRoutingContext,
  type DelegationRouterProvider,
} from "./DelegationRouter.ts";
import type { ProviderDelegationCapabilities } from "./Services/ProviderAdapter.ts";

type CapabilityProfile = "full" | "interactive" | "questions-only" | "attachments-only";

interface CorpusProvider {
  readonly id: string;
  readonly driver: string;
  readonly models: ReadonlyArray<string>;
  readonly capabilities: CapabilityProfile;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly availability?: "unavailable";
}

interface CorpusTarget {
  readonly provider: "codex" | "cursor" | "claudeAgent";
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly options?: ProviderOptionSelections;
}

interface CorpusExpectedSelection {
  readonly laneId: string;
  readonly provider: string;
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly options?: ProviderOptionSelections;
}

interface CorpusExpected {
  readonly selected?: ReadonlyArray<CorpusExpectedSelection>;
  readonly failure?: DelegationReasonCode;
  readonly policySource: DelegationPolicySource;
  readonly taskKind?: DelegationTaskKind;
  readonly rejected?: Readonly<Record<string, ReadonlyArray<DelegationReasonCode>>>;
  readonly explanationIncludes: string;
}

interface CorpusCase {
  readonly name: string;
  readonly providers?: ReadonlyArray<CorpusProvider>;
  readonly roles?: {
    readonly scout?: ReadonlyArray<CorpusTarget>;
    readonly worker?: ReadonlyArray<CorpusTarget>;
  };
  readonly workflowOverrides?: Readonly<Record<string, EngineDelegationSkillOverride>>;
  readonly trustedContext?: {
    readonly workflow?: EngineWorkflowName;
    readonly skillOverride?: EngineDelegationSkillOverride;
  };
  readonly invokedByDelegatedChild?: boolean;
  readonly tasks: ReadonlyArray<DelegationTaskSpec>;
  readonly expected: CorpusExpected;
}

interface RoutingCorpus {
  readonly defaults: {
    readonly providers: ReadonlyArray<CorpusProvider>;
    readonly roles: {
      readonly scout: ReadonlyArray<CorpusTarget>;
      readonly worker: ReadonlyArray<CorpusTarget>;
    };
  };
  readonly cases: ReadonlyArray<CorpusCase>;
}

const corpus = corpusFixture as unknown as RoutingCorpus;
const enabledRouterSettings = {
  ...DEFAULT_SERVER_SETTINGS.mcp.router,
  mode: "suggested" as const,
};

const capabilityProfiles: Record<CapabilityProfile, ProviderDelegationCapabilities> = {
  full: {
    delegatedExecution: true,
    cancellation: true,
    structuredQuestions: true,
    attachments: true,
    enforcedReadOnlyWorkspace: true,
    workspaceWriteSandboxContainment: true,
    instructionDelivery: { supported: true, channel: "developer" },
    providerThreadResume: true,
    definitelyNotAcceptedDispatchOutcome: "unsupported",
    usageReporting: "correlated",
  },
  interactive: {
    delegatedExecution: true,
    cancellation: true,
    structuredQuestions: true,
    attachments: true,
    enforcedReadOnlyWorkspace: false,
    workspaceWriteSandboxContainment: false,
    instructionDelivery: { supported: false, reason: "No trusted instruction channel." },
    providerThreadResume: true,
    definitelyNotAcceptedDispatchOutcome: "unsupported",
    usageReporting: "unsupported",
  },
  "questions-only": {
    delegatedExecution: true,
    cancellation: true,
    structuredQuestions: true,
    attachments: false,
    enforcedReadOnlyWorkspace: false,
    workspaceWriteSandboxContainment: false,
    instructionDelivery: { supported: false, reason: "No trusted instruction channel." },
    providerThreadResume: true,
    definitelyNotAcceptedDispatchOutcome: "unsupported",
    usageReporting: "unsupported",
  },
  "attachments-only": {
    delegatedExecution: true,
    cancellation: true,
    structuredQuestions: false,
    attachments: true,
    enforcedReadOnlyWorkspace: false,
    workspaceWriteSandboxContainment: false,
    instructionDelivery: { supported: false, reason: "No trusted instruction channel." },
    providerThreadResume: true,
    definitelyNotAcceptedDispatchOutcome: "unsupported",
    usageReporting: "unsupported",
  },
};

const optionDescriptors = [
  {
    id: "reasoningEffort",
    label: "Reasoning effort",
    type: "select" as const,
    options: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
  },
];

const makeProvider = (provider: CorpusProvider): DelegationRouterProvider => ({
  snapshot: {
    instanceId: ProviderInstanceId.make(provider.id),
    driver: ProviderDriverKind.make(provider.driver),
    enabled: provider.enabled ?? true,
    installed: provider.installed ?? true,
    version: "1.0.0",
    status: provider.enabled === false ? "disabled" : "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-29T00:00:00.000Z",
    models: provider.models.map((model) => ({
      slug: model,
      name: model,
      isCustom: false,
      capabilities: { optionDescriptors },
    })),
    slashCommands: [],
    skills: [],
    ...(provider.availability === undefined
      ? {}
      : {
          availability: provider.availability,
          unavailableReason: `Driver '${provider.driver}' is unavailable.`,
        }),
  } as ServerProvider,
  capabilities: capabilityProfiles[provider.capabilities],
});

const makeSettings = (testCase: CorpusCase): EngineDelegationSettings => ({
  roles: (testCase.roles ?? corpus.defaults.roles) as EngineDelegationSettings["roles"],
  skillOverrides: (testCase.workflowOverrides ?? {}) as EngineDelegationSettings["skillOverrides"],
});

const evaluateCase = (testCase: CorpusCase) =>
  evaluateDelegationBatch({
    routeGroupId: `corpus:${testCase.name}` as DelegationRouteGroupId,
    tasks: testCase.tasks,
    providers: (testCase.providers ?? corpus.defaults.providers).map(makeProvider),
    routerSettings: enabledRouterSettings,
    delegationSettings: makeSettings(testCase),
    ...(testCase.trustedContext === undefined
      ? {}
      : { trustedContext: makeTrustedRoutingContext(testCase.trustedContext) }),
    ...(testCase.invokedByDelegatedChild === undefined
      ? {}
      : { invokedByDelegatedChild: testCase.invokedByDelegatedChild }),
  });

const rejectionMap = (
  candidates: ReadonlyArray<{
    readonly candidate: { readonly providerInstanceId: string };
    readonly eligible: boolean;
    readonly reasonCodes: ReadonlyArray<DelegationReasonCode>;
  }>,
) =>
  Object.fromEntries(
    candidates
      .filter((candidate) => !candidate.eligible)
      .map((candidate) => [candidate.candidate.providerInstanceId, candidate.reasonCodes]),
  );

describe("delegation routing evaluation corpus", () => {
  it.each(corpus.cases)("$name", (testCase) => {
    const result = evaluateCase(testCase);
    if (testCase.expected.failure !== undefined) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      const failure = result.failures[0]!;
      expect(failure.reasonCode).toBe(testCase.expected.failure);
      expect(failure.policySource).toBe(testCase.expected.policySource);
      expect(failure.explanation).toContain(testCase.expected.explanationIncludes);
      if (testCase.expected.rejected !== undefined) {
        expect(rejectionMap(failure.candidates)).toEqual(testCase.expected.rejected);
      }
      return;
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions).toHaveLength(testCase.expected.selected?.length ?? 0);
    for (const [index, expected] of (testCase.expected.selected ?? []).entries()) {
      const decision = result.decisions[index]!;
      expect(decision.policyVersion).toBe(1);
      expect(decision.policySource).toBe(testCase.expected.policySource);
      expect(decision.explanation).toContain(testCase.expected.explanationIncludes);
      expect(decision.taskKind).toBe(
        testCase.expected.taskKind ?? testCase.tasks[index]?.kind ?? "general",
      );
      expect({
        laneId: testCase.tasks
          .map((task) => task.laneId)
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[index],
        provider: decision.selected.provider,
        providerInstanceId: decision.selected.providerInstanceId,
        model: decision.selected.model,
        options: decision.selected.options,
      }).toMatchObject(expected);
      expect(decision.fallbackChain).not.toContainEqual(decision.selected);
      if (testCase.expected.rejected !== undefined) {
        expect(rejectionMap(decision.candidates)).toEqual(testCase.expected.rejected);
      }
    }
  });
});

describe("evaluateDelegationBatch", () => {
  it("does not use task kind as a scoring input", () => {
    const base = corpus.cases.find((entry) => entry.name === "implementation")!;
    const selected = (
      [
        "research",
        "planning",
        "implementation",
        "debugging",
        "testing",
        "review",
        "documentation",
        "knowledge-scan",
        "general",
      ] satisfies ReadonlyArray<DelegationTaskKind>
    ).map((kind) => {
      const result = evaluateCase({
        ...base,
        tasks: [{ ...base.tasks[0]!, kind }],
      });
      expect(result.ok).toBe(true);
      return result.ok ? result.decisions[0]?.selected : undefined;
    });
    expect(selected.every((candidate) => candidate?.provider === "codex")).toBe(true);
    expect(new Set(selected.map((candidate) => candidate?.model))).toEqual(
      new Set(["codex-general"]),
    );
  });

  it("uses provider defaults only when the effective role chain is omitted", () => {
    const result = evaluateDelegationBatch({
      routeGroupId: "defaults" as DelegationRouteGroupId,
      tasks: [
        {
          laneId: "defaults" as DelegationTaskSpec["laneId"],
          title: "Defaults",
          task: "Use provider defaults",
          role: "worker",
          workspaceAccess: "workspace-write",
        },
      ],
      providers: [
        makeProvider({
          id: "codex",
          driver: "codex",
          models: ["gpt-5.6-terra", "gpt-5.6-sol"],
          capabilities: "full",
        }),
        makeProvider({
          id: "cursor",
          driver: "cursor",
          models: ["composer-2.5"],
          capabilities: "full",
        }),
      ],
      routerSettings: enabledRouterSettings,
      delegationSettings: { roles: {}, skillOverrides: {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0]?.policySource).toBe("provider_default");
  });

  it("does not apply workflow overrides without trusted invocation context", () => {
    const result = evaluateDelegationBatch({
      routeGroupId: "untrusted" as DelegationRouteGroupId,
      tasks: [
        {
          laneId: "untrusted" as DelegationTaskSpec["laneId"],
          title: "Untrusted",
          task: "Use the ordinary role chain",
          role: "worker",
          workspaceAccess: "workspace-write",
        },
      ],
      providers: corpus.defaults.providers.map(makeProvider),
      routerSettings: enabledRouterSettings,
      delegationSettings: {
        roles: corpus.defaults.roles as EngineDelegationSettings["roles"],
        skillOverrides: {
          plan: { worker: [{ provider: "codex", model: "codex-special" }] },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0]).toMatchObject({
      policySource: "role_chain",
      selected: { model: "codex-general" },
    });
  });

  it("applies explicit constraints before trusted skill and workflow policy", () => {
    const result = evaluateDelegationBatch({
      routeGroupId: "explicit-first" as DelegationRouteGroupId,
      tasks: [
        {
          laneId: "explicit-first" as DelegationTaskSpec["laneId"],
          title: "Explicit first",
          task: "Honor the caller constraint",
          role: "worker",
          workspaceAccess: "workspace-write",
          providerConstraint: {
            provider: ProviderDriverKind.make("codex"),
            model: "codex-special",
          },
        },
      ],
      providers: corpus.defaults.providers.map(makeProvider),
      routerSettings: enabledRouterSettings,
      delegationSettings: {
        roles: corpus.defaults.roles as EngineDelegationSettings["roles"],
        skillOverrides: {
          plan: { worker: [{ provider: "codex", model: "codex-general" }] },
        },
      },
      trustedContext: makeTrustedRoutingContext({
        workflow: "plan",
        skillOverride: {
          worker: [{ provider: "codex", model: "codex-general" }],
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0]).toMatchObject({
      policySource: "explicit_constraint",
      selected: { model: "codex-special" },
    });
  });

  it("rejects all lanes deterministically when routing is disabled", () => {
    const base = corpus.cases[0]!;
    const result = evaluateDelegationBatch({
      routeGroupId: "disabled" as DelegationRouteGroupId,
      tasks: base.tasks,
      providers: corpus.defaults.providers.map(makeProvider),
      routerSettings: { ...DEFAULT_SERVER_SETTINGS.mcp.router, mode: "off" },
      delegationSettings: makeSettings(base),
    });
    expect(result).toMatchObject({
      ok: false,
      failures: [{ reasonCode: "delegation_disabled" }],
    });
  });
});
