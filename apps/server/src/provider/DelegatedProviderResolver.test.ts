import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  describeDelegatedProviderCapabilities,
  resolveDelegatedProvider,
} from "./DelegatedProviderResolver.ts";

const makeSnapshot = (
  overrides: Omit<Partial<ServerProvider>, "instanceId"> & { instanceId: string },
): ServerProvider =>
  ({
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-11T00:00:00.000Z",
    models: [
      { slug: "composer-2.5", name: "Composer 2.5", isCustom: false, capabilities: null },
      { slug: "gpt-5.2", name: "GPT 5.2", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
    instanceId: ProviderInstanceId.make(overrides.instanceId),
  }) as ServerProvider;

const optionCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select" as const,
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    { id: "fastMode", label: "Fast mode", type: "boolean" as const },
  ],
};

const codexCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select" as const,
      options: [
        { id: "default", label: "Standard" },
        { id: "priority", label: "Fast", description: "Lower latency responses." },
        { id: "flex", label: "Flex", isDefault: true },
      ],
      currentValue: "flex",
    },
  ],
};

const makeCodexSnapshot = (): ServerProvider =>
  makeSnapshot({
    instanceId: "codex_work",
    driver: ProviderDriverKind.make("codex"),
    models: [
      {
        slug: "gpt-5.5",
        name: "GPT 5.5",
        isCustom: false,
        capabilities: codexCapabilities,
      },
    ],
  });

describe("resolveDelegatedProvider", () => {
  it("resolves the default cursor instance and default model", () => {
    const result = resolveDelegatedProvider({
      providers: [makeSnapshot({ instanceId: "cursor" })],
      provider: "cursor",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instance.instanceId).toBe("cursor");
    expect(result.value.resolvedModel).toBe("composer-2.5");
    expect(result.value.requestedModel).toBeUndefined();
  });

  it("resolves an Antigravity instance and preserves its discovered model slug", () => {
    const result = resolveDelegatedProvider({
      providers: [
        makeSnapshot({
          instanceId: "antigravity",
          driver: ProviderDriverKind.make("antigravity"),
          models: [
            {
              slug: "gemini-3.7-flash-high",
              name: "Gemini 3.7 Flash (High)",
              isCustom: false,
              capabilities: {},
            },
          ],
        }),
      ],
      provider: "antigravity",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instance.instanceId).toBe("antigravity");
    expect(result.value.resolvedModel).toBe("gemini-3.7-flash-high");
  });

  it("honors an explicit instance selection", () => {
    const result = resolveDelegatedProvider({
      providers: [
        makeSnapshot({ instanceId: "cursor" }),
        makeSnapshot({ instanceId: "cursor_work" }),
      ],
      provider: "cursor",
      providerInstanceId: ProviderInstanceId.make("cursor_work"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instance.instanceId).toBe("cursor_work");
  });

  it("prefers the default instance and falls back deterministically", () => {
    const preferred = resolveDelegatedProvider({
      providers: [
        makeSnapshot({ instanceId: "cursor_zeta" }),
        makeSnapshot({ instanceId: "cursor" }),
      ],
      provider: "cursor",
    });
    expect(preferred.ok && preferred.value.instance.instanceId).toBe("cursor");

    const deterministic = resolveDelegatedProvider({
      providers: [
        makeSnapshot({ instanceId: "cursor_zeta" }),
        makeSnapshot({ instanceId: "cursor_alpha" }),
      ],
      provider: "cursor",
    });
    expect(deterministic.ok && deterministic.value.instance.instanceId).toBe("cursor_alpha");
  });

  it("rejects disabled and unavailable instances with distinct reasons", () => {
    const disabled = resolveDelegatedProvider({
      providers: [makeSnapshot({ instanceId: "cursor", enabled: false, status: "disabled" })],
      provider: "cursor",
    });
    expect(disabled.ok).toBe(false);
    expect(!disabled.ok && disabled.message).toContain("disabled");
    expect(!disabled.ok && disabled.reasonCode).toBe("provider_disabled");

    const uninstalled = resolveDelegatedProvider({
      providers: [makeSnapshot({ instanceId: "cursor", installed: false })],
      provider: "cursor",
    });
    expect(!uninstalled.ok && uninstalled.message).toContain("not installed");
    expect(!uninstalled.ok && uninstalled.reasonCode).toBe("provider_uninstalled");

    const unavailable = resolveDelegatedProvider({
      providers: [
        makeSnapshot({
          instanceId: "cursor",
          enabled: false,
          installed: false,
          availability: "unavailable",
          unavailableReason: "Driver 'cursor' is not registered in this build.",
        }),
      ],
      provider: "cursor",
    });
    expect(!unavailable.ok && unavailable.message).toContain("not registered in this build");
    expect(!unavailable.ok && unavailable.reasonCode).toBe("provider_unavailable");

    const delegationUnavailable = resolveDelegatedProvider({
      providers: [
        makeSnapshot({
          instanceId: "cursor",
          delegation: { available: false, reason: "Upgrade the provider CLI." },
        }),
      ],
      provider: "cursor",
    });
    expect(!delegationUnavailable.ok && delegationUnavailable.message).toContain(
      "Upgrade the provider CLI",
    );
    expect(!delegationUnavailable.ok && delegationUnavailable.reasonCode).toBe(
      "provider_unavailable",
    );

    const missing = resolveDelegatedProvider({ providers: [], provider: "cursor" });
    expect(!missing.ok && missing.message).toContain("No cursor provider instance is configured");
    expect(!missing.ok && missing.reasonCode).toBe("provider_unavailable");
  });

  it("rejects instances owned by a different driver", () => {
    const result = resolveDelegatedProvider({
      providers: [makeSnapshot({ instanceId: "codex", driver: ProviderDriverKind.make("codex") })],
      provider: "cursor",
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("owned by driver 'codex'");
    expect(!result.ok && result.reasonCode).toBe("explicit_constraint_mismatch");
  });

  it("resolves composer 2.5 by slug and by display name", () => {
    const bySlug = resolveDelegatedProvider({
      providers: [makeSnapshot({ instanceId: "cursor" })],
      provider: "cursor",
      model: "composer-2.5",
    });
    expect(bySlug.ok && bySlug.value.resolvedModel).toBe("composer-2.5");
    expect(bySlug.ok && bySlug.value.requestedModel).toBe("composer-2.5");

    const byName = resolveDelegatedProvider({
      providers: [makeSnapshot({ instanceId: "cursor" })],
      provider: "cursor",
      model: "Composer 2.5",
    });
    expect(byName.ok && byName.value.resolvedModel).toBe("composer-2.5");
  });

  it("rejects unknown models with supported alternatives", () => {
    const result = resolveDelegatedProvider({
      providers: [makeSnapshot({ instanceId: "cursor" })],
      provider: "cursor",
      model: "composer-9000",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("model_unavailable");
    expect(result.message).toContain("composer-9000");
    expect(result.message).toContain("'composer-2.5'");
    expect(result.message).toContain("'gpt-5.2'");
  });

  it("returns a complete validated model selection", () => {
    const result = resolveDelegatedProvider({
      providers: [
        makeSnapshot({
          instanceId: "cursor_work",
          models: [
            {
              slug: "composer-2.5",
              name: "Composer 2.5",
              isCustom: false,
              capabilities: optionCapabilities,
            },
          ],
        }),
      ],
      provider: "cursor",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modelSelection).toEqual({
      instanceId: "cursor_work",
      model: "composer-2.5",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("rejects unknown, invalid, and duplicate options", () => {
    const provider = makeSnapshot({
      instanceId: "cursor",
      models: [
        {
          slug: "composer-2.5",
          name: "Composer 2.5",
          isCustom: false,
          capabilities: optionCapabilities,
        },
      ],
    });
    const resolve = (options: ReadonlyArray<{ id: string; value: string | boolean }>) =>
      resolveDelegatedProvider({ providers: [provider], provider: "cursor", options });

    expect(resolve([{ id: "missing", value: true }])).toMatchObject({
      ok: false,
      message: expect.stringContaining("missing"),
    });
    expect(resolve([{ id: "reasoningEffort", value: "extreme" }])).toMatchObject({
      ok: false,
      message: expect.stringContaining("'low', 'high'"),
    });
    expect(resolve([{ id: "fastMode", value: "true" }])).toMatchObject({
      ok: false,
      message: expect.stringContaining("boolean"),
    });
    expect(
      resolve([
        { id: "fastMode", value: true },
        { id: "fastMode", value: false },
      ]),
    ).toMatchObject({ ok: false, message: expect.stringContaining("more than once") });
  });

  it("distinguishes unavailable Cursor capability discovery", () => {
    const result = resolveDelegatedProvider({
      providers: [
        makeSnapshot({
          instanceId: "cursor",
          models: [
            {
              slug: "custom-model",
              name: "custom-model",
              isCustom: true,
              capabilities: { optionDescriptors: [] },
            },
          ],
        }),
      ],
      provider: "cursor",
      options: [{ id: "reasoning", value: "high" }],
    });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("could not be discovered"),
    });
  });

  it("materializes only the effective Codex service tier and captures stable labels", () => {
    const result = resolveDelegatedProvider({
      providers: [makeCodexSnapshot()],
      provider: "codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedOptions).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(result.value.resolvedOptions).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "flex" },
    ]);
    expect(result.value.resolvedOptionDetails).toEqual([
      { id: "reasoningEffort", label: "Reasoning", value: "high", valueLabel: "High" },
      { id: "serviceTier", label: "Service Tier", value: "flex", valueLabel: "Flex" },
    ]);
    expect(result.value.modelSelection?.instanceId).toBe("codex_work");
  });

  it("canonicalizes legacy Codex Fast while preserving the original request", () => {
    const result = resolveDelegatedProvider({
      providers: [makeCodexSnapshot()],
      provider: "codex",
      options: [{ id: "fastMode", value: true }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedOptions).toEqual([{ id: "fastMode", value: true }]);
    expect(result.value.resolvedOptions).toEqual([{ id: "serviceTier", value: "priority" }]);
    expect(result.value.resolvedOptionDetails?.[0]).toMatchObject({
      value: "priority",
      valueLabel: "Fast",
      description: "Lower latency responses.",
    });
  });

  it("materializes the Codex service tier when the caller supplies no options", () => {
    const result = resolveDelegatedProvider({
      providers: [makeCodexSnapshot()],
      provider: "codex",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedOptions).toBeUndefined();
    expect(result.value.resolvedOptions).toEqual([{ id: "serviceTier", value: "flex" }]);
  });
});

describe("describeDelegatedProviderCapabilities", () => {
  it("lists live instances with models and default model", () => {
    const capabilities = describeDelegatedProviderCapabilities({
      providers: [makeSnapshot({ instanceId: "cursor" })],
      provider: "cursor",
      supportsCancellation: true,
      supportsQuestions: true,
    });
    expect(capabilities.available).toBe(true);
    expect(capabilities.instances).toHaveLength(1);
    expect(capabilities.instances[0]).toMatchObject({
      providerInstanceId: "cursor",
      available: true,
      models: ["composer-2.5", "gpt-5.2"],
      defaultModel: "composer-2.5",
      modelDetails: [
        { model: "composer-2.5", displayName: "Composer 2.5", options: [] },
        { model: "gpt-5.2", displayName: "GPT 5.2", options: [] },
      ],
    });
  });

  it("reports distinct reasons for unusable instances", () => {
    const capabilities = describeDelegatedProviderCapabilities({
      providers: [
        makeSnapshot({ instanceId: "cursor_disabled", enabled: false }),
        makeSnapshot({ instanceId: "cursor_missing", installed: false }),
        makeSnapshot({
          instanceId: "cursor_gone",
          enabled: false,
          installed: false,
          availability: "unavailable",
          unavailableReason: "Driver 'cursor' is not registered in this build.",
        }),
      ],
      provider: "cursor",
      supportsCancellation: true,
      supportsQuestions: true,
    });
    expect(capabilities.available).toBe(false);
    expect(capabilities.reason).toContain("cursor");
    const reasons = new Map(
      capabilities.instances.map((instance) => [
        String(instance.providerInstanceId),
        instance.reason,
      ]),
    );
    expect(reasons.get("cursor_disabled")).toContain("disabled");
    expect(reasons.get("cursor_missing")).toContain("not installed");
    expect(reasons.get("cursor_gone")).toContain("not registered");
  });

  it("reports unconfigured providers", () => {
    const capabilities = describeDelegatedProviderCapabilities({
      providers: [],
      provider: "codex",
      supportsCancellation: true,
      supportsQuestions: false,
    });
    expect(capabilities.available).toBe(false);
    expect(capabilities.reason).toContain("No codex provider instance is configured");
    expect(capabilities.instances).toHaveLength(0);
  });
});
