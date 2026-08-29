import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EngineConsensusInput } from "./knowledge.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  CONSENSUS_DEFAULTS,
  DEFAULT_CLIENT_SETTINGS,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_KNOWLEDGE_SCAN_MAIN_THREAD_MODEL_PREFERENCE,
  EngineDelegationSettings,
  ProjectMcpOverrides,
  SCANNER_DEFAULTS,
  SCOUT_DEFAULTS,
  defaultEnabledForDriver,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  WORKER_DEFAULTS,
  deriveDefaultDelegationRoles,
  resolveDelegationRoles,
  resolveEffectiveMcpSettings,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeEngineDelegationSettings = Schema.decodeUnknownSync(EngineDelegationSettings);
const decodeProjectMcpOverrides = Schema.decodeUnknownSync(ProjectMcpOverrides);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("ClaudeSettings auto-compaction", () => {
  it("uses Claude's default threshold when no override is configured", () => {
    expect(decodeClaudeSettings({}).autoCompactWindow).toBe("");
  });

  it.each(["100000", "300000", "1000000"])(
    "accepts a supported auto-compaction threshold: %s",
    (value) => {
      expect(decodeClaudeSettings({ autoCompactWindow: value }).autoCompactWindow).toBe(value);
    },
  );

  it.each(["99999", "1000001", "300k", "invalid"])(
    "rejects an unsupported auto-compaction threshold: %s",
    (value) => {
      expect(() => decodeClaudeSettings({ autoCompactWindow: value })).toThrow();
    },
  );

  it("rejects an unsupported threshold at the settings patch boundary", () => {
    expect(() =>
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300k" } } }),
    ).toThrow();
    expect(
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300000" } } }),
    ).toBeDefined();
  });
});

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("Voice settings", () => {
  it("defaults per-device inference settings without changing legacy clients", () => {
    const settings = decodeClientSettings({});

    expect(settings.voiceInferenceMode).toBe("auto");
    expect(settings.voiceModelId).toBe("");
    expect(settings.voiceModelQuant).toBe("");
  });

  it("defaults the server voice engine and dictionary", () => {
    const voice = decodeServerSettings({}).voice;

    expect(voice.engine).toBe("sidecar");
    expect(voice.dictionary).toEqual([]);
  });

  it("decodes voice inference and dictionary patches", () => {
    expect(
      decodeClientSettingsPatch({
        voiceInferenceMode: "local",
        voiceModelId: "parakeet-tdt-0.6b-v3",
        voiceModelQuant: "Q8_0",
      }),
    ).toMatchObject({ voiceInferenceMode: "local", voiceModelQuant: "Q8_0" });
    expect(
      decodeServerSettingsPatch({
        voice: {
          engine: "transcribecpp",
          dictionary: [
            {
              id: "complyq",
              type: "alias",
              originals: ["comply q"],
              replacement: "ComplyQ",
            },
          ],
        },
      }).voice,
    ).toMatchObject({
      engine: "transcribecpp",
      dictionary: [
        {
          id: "complyq",
          caseSensitive: false,
          fuzzy: false,
          enabled: true,
        },
      ],
    });
  });

  it("rejects malformed aliases, term replacements, and duplicate IDs at the server boundary", () => {
    expect(() =>
      decodeServerSettingsPatch({
        voice: {
          dictionary: [{ id: "alias", type: "alias", originals: ["spoken"] }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        voice: {
          dictionary: [{ id: "term", type: "term", originals: ["ComplyQ"], replacement: "other" }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        voice: {
          dictionary: [
            { id: "duplicate", type: "term", originals: ["first"] },
            { id: "duplicate", type: "term", originals: ["second"] },
          ],
        },
      }),
    ).toThrow();
  });

  it("bounds dictionary entry counts, variants, and text lengths", () => {
    expect(() =>
      decodeServerSettingsPatch({
        voice: {
          dictionary: Array.from({ length: 257 }, (_, index) => ({
            id: `term-${index}`,
            type: "term",
            originals: ["term"],
          })),
        },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        voice: {
          dictionary: [
            {
              id: "too-many-originals",
              type: "term",
              originals: Array.from({ length: 17 }, (_, index) => `term-${index}`),
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        voice: {
          dictionary: [{ id: "long", type: "term", originals: ["x".repeat(257)] }],
        },
      }),
    ).toThrow();
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 100, 150, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings desktop notifications", () => {
  const primaryDefaults = {
    enabled: true,
    attention: true,
    agentCompletion: true,
    subagentCompletion: true,
    failures: true,
    stopped: false,
    sound: true,
    notifyWhileViewingThread: false,
  };

  it("hydrates backward-compatible defaults for legacy settings", () => {
    expect(decodeClientSettings({}).desktopNotifications).toEqual(primaryDefaults);
    expect(DEFAULT_CLIENT_SETTINGS.desktopNotifications).toEqual(primaryDefaults);
  });

  it("hydrates omitted nested preferences while preserving explicit choices", () => {
    expect(
      decodeClientSettings({
        desktopNotifications: {
          sound: false,
          stopped: true,
        },
      }).desktopNotifications,
    ).toEqual({
      ...primaryDefaults,
      sound: false,
      stopped: true,
    });
  });

  it("accepts a partial nested notification settings patch with defaults", () => {
    expect(
      decodeClientSettingsPatch({
        desktopNotifications: {
          notifyWhileViewingThread: true,
        },
      }).desktopNotifications,
    ).toEqual({
      ...primaryDefaults,
      notifyWhileViewingThread: true,
    });
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to the current sidebar with automatic merge and inactivity settling", () => {
    const settings = decodeClientSettings({});
    expect(settings.legacySidebarEnabled).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded.legacySidebarEnabled).toBe(false);
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("preserves an explicit legacy sidebar opt-in", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(
      true,
    );
  });

  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it("allows auto-settle on merge to be disabled", () => {
    expect(decodeClientSettings({ sidebarAutoSettleOnMerge: false }).sidebarAutoSettleOnMerge).toBe(
      false,
    );
    expect(
      decodeClientSettingsPatch({ sidebarAutoSettleOnMerge: false }).sidebarAutoSettleOnMerge,
    ).toBe(false);
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("disables Cursor by default until the user enables it", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providers.cursor.enabled).toBe(false);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("provider enabled defaults", () => {
  it("keeps Grok and OpenCode opt-in by default", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.claudeAgent.enabled).toBe(true);
    expect(decoded.providers.cursor.enabled).toBe(false);
    expect(decoded.providers.grok.enabled).toBe(false);
    expect(decoded.providers.opencode.enabled).toBe(false);
  });

  it("derives per-driver defaults from the settings schemas", () => {
    expect(defaultEnabledForDriver(ProviderDriverKind.make("codex"))).toBe(true);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("cursor"))).toBe(false);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("grok"))).toBe(false);
    // Unknown fork drivers stay enabled; their own build decides otherwise.
    expect(defaultEnabledForDriver(ProviderDriverKind.make("ollama"))).toBe(true);
  });

  it("keeps Cursor enabled when an existing user explicitly opted in", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorId = ProviderInstanceId.make("cursor");
    const decoded = decodeServerSettings({
      providers: { cursor: { enabled: true } },
      providerInstances: {
        [cursorId]: { driver: cursor, enabled: true, config: {} },
      },
    });

    expect(decoded.providers.cursor.enabled).toBe(true);
    expect(resolveProviderInstanceEnabled(decoded.providerInstances[cursorId]!)).toBe(true);
  });

  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    // No flags anywhere: driver default applies.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    // Envelope flag wins over the driver default.
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    // Legacy in-config flag fills in when the envelope is silent.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    // Conflicting flags: the explicit false wins, whichever side it is on.
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettings skill toggles", () => {
  it("decodes disabled-by-default settings for every built-in provider", () => {
    expect(decodeServerSettings({}).skills).toEqual({
      disableAllProviders: false,
      providers: {
        claudeAgent: { disableAll: false, disabledSkills: [] },
        codex: { disableAll: false, disabledSkills: [] },
        opencode: { disableAll: false, disabledSkills: [] },
        cursor: { disableAll: false, disabledSkills: [] },
        grok: { disableAll: false, disabledSkills: [] },
      },
    });
  });

  it("round-trips sparse nested provider patches", () => {
    const patch = {
      skills: {
        disableAllProviders: true,
        providers: {
          claudeAgent: { disabledSkills: ["shadcn"] },
          codex: { disableAll: true },
        },
      },
    };

    expect(decodeServerSettingsPatch(patch)).toEqual(patch);
  });
});

describe("ServerSettings MCP engine", () => {
  it("defaults every Implementation Engine ability on with delegation roles left automatic", () => {
    expect(decodeServerSettings({}).mcp.engine).toEqual({
      planning: true,
      consensus: false,
      enrich: true,
      implement: true,
      quality: true,
      performance: true,
      typescript: true,
      delegation: {
        roles: {},
        skillOverrides: {},
      },
      knowledgeScan: {
        mainThreadModelPreference: DEFAULT_KNOWLEDGE_SCAN_MAIN_THREAD_MODEL_PREFERENCE,
      },
    });
  });

  it("round-trips partial engine patches", () => {
    expect(
      decodeServerSettingsPatch({ mcp: { engine: { planning: true, typescript: true } } }),
    ).toEqual({ mcp: { engine: { planning: true, typescript: true } } });
  });

  it("normalizes obsolete router settings out of patches", () => {
    const patch = decodeServerSettingsPatch({
      mcp: { router: { mode: "off", maxBatchSize: 2, fallback: "none" } },
    });
    expect(patch).toEqual({ mcp: {} });
  });

  it("round-trips custom delegation chains and workflow overrides", () => {
    const input = {
      mcp: {
        engine: {
          delegation: {
            roles: {
              scout: [{ provider: "codex" as const, model: "gpt-5.4-mini" }],
              worker: [{ provider: "cursor" as const, providerInstanceId: "cursor_work" }],
              consensus: [
                {
                  provider: "codex" as const,
                  model: "gpt-5.6-terra",
                  options: [{ id: "reasoningEffort", value: "high" }],
                },
              ],
              scanner: [
                { provider: "claudeAgent" as const, model: "claude-opus-4-8" },
                { provider: "cursor" as const, model: "glm-5.2" },
              ],
            },
            skillOverrides: {
              plan: { scout: [], consensus: [{ provider: "cursor" as const, model: "grok-4.5" }] },
              implement: {
                worker: [
                  {
                    provider: "codex" as const,
                    model: "gpt-5.4",
                    options: [{ id: "reasoningEffort", value: "xhigh" }],
                  },
                ],
              },
            },
          },
        },
      },
    };

    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });

  it("rejects unknown delegation providers and workflow override keys", () => {
    expect(() =>
      decodeServerSettingsPatch({
        mcp: { engine: { delegation: { roles: { scout: [{ provider: "claude" }] } } } },
      }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        mcp: {
          engine: {
            delegation: { skillOverrides: { "not-a-workflow": { scout: [] } } },
          },
        },
      }),
    ).toThrow();
  });

  it("normalizes legacy auditor settings and preserves focus lenses", () => {
    const decoded = decodeEngineDelegationSettings({
      roles: {
        auditor: [{ provider: "codex", model: "gpt-5.6-sol", focus: "hidden risks" }],
      },
      skillOverrides: {
        consensus: { auditor: [{ provider: "cursor", model: "grok-4.5" }] },
      },
    });

    expect(decoded.roles.consensus).toEqual([
      { provider: "codex", model: "gpt-5.6-sol", focus: "hidden risks" },
    ]);
    expect(decoded.skillOverrides.consensus?.consensus).toEqual([
      { provider: "cursor", model: "grok-4.5" },
    ]);
    expect(decoded.roles).not.toHaveProperty("auditor");
  });

  it("validates consensus mode and artifact sequence", () => {
    const decodeConsensus = Schema.decodeUnknownSync(EngineConsensusInput);
    expect(decodeConsensus({ task: "audit", mode: "decision" }).mode).toBe("decision");
    expect(() => decodeConsensus({ task: "audit", mode: "unknown" })).toThrow();
    expect(() =>
      decodeConsensus({ task: "audit", subjectArtifact: { kind: "plan", seq: -1 } }),
    ).toThrow();
  });
});

describe("per-project MCP settings", () => {
  it("defaults and round-trips the Claude delegation toggle", () => {
    expect(decodeServerSettings({}).mcp.claudeAgent).toBe(true);
    expect(decodeServerSettingsPatch({ mcp: { claudeAgent: false } }).mcp?.claudeAgent).toBe(false);
    expect(decodeProjectMcpOverrides({ claudeAgent: false })).toEqual({ claudeAgent: false });
  });

  it("decodes an empty override as inherit-all", () => {
    expect(decodeProjectMcpOverrides({})).toEqual({});
  });

  it("normalizes obsolete router settings out of project overrides", () => {
    expect(decodeProjectMcpOverrides({ router: { mode: "off" } })).toEqual({});
  });

  it("resolves sparse booleans, role replacement, and per-workflow overrides", () => {
    const global = decodeServerSettings({
      mcp: {
        preview: false,
        engine: {
          quality: true,
          delegation: {
            roles: { scout: [{ provider: "cursor", model: "global-scout" }] },
            skillOverrides: {
              plan: { scout: [{ provider: "codex", model: "global-plan" }] },
              implement: { worker: [{ provider: "codex", model: "global-worker" }] },
            },
          },
        },
      },
    }).mcp;

    const effective = resolveEffectiveMcpSettings(global, {
      preview: true,
      engine: {
        quality: false,
        delegation: {
          roles: { scout: [] },
          skillOverrides: {
            plan: { scout: [{ provider: "cursor", model: "project-plan" }] },
          },
        },
      },
    });

    expect(effective.preview).toBe(true);
    expect(effective.engine.quality).toBe(false);
    expect(effective.engine.planning).toBe(true);
    expect(effective.engine.delegation.roles.scout).toEqual([]);
    expect(effective.engine.delegation.skillOverrides).toEqual({
      plan: { scout: [{ provider: "cursor", model: "project-plan" }] },
      implement: { worker: [{ provider: "codex", model: "global-worker" }] },
    });
  });

  it.each([
    {
      providers: ["claudeAgent", "codex", "cursor"] as const,
      scout: ["cursor", "codex"],
      worker: ["codex", "codex", "cursor"],
      consensus: ["codex", "cursor"],
      scanner: ["claudeAgent", "codex", "cursor", "cursor"],
    },
    {
      providers: ["codex", "cursor"] as const,
      scout: ["cursor", "codex"],
      worker: ["codex", "codex", "cursor"],
      consensus: ["codex", "cursor"],
      scanner: ["codex", "cursor", "cursor"],
    },
    {
      providers: ["codex"] as const,
      scout: ["codex"],
      worker: ["codex", "codex"],
      consensus: ["codex"],
      scanner: ["codex"],
    },
    {
      providers: ["cursor"] as const,
      scout: ["cursor"],
      worker: ["cursor"],
      consensus: ["cursor"],
      scanner: ["cursor", "cursor"],
    },
    {
      providers: ["claudeAgent"] as const,
      scout: [],
      worker: [],
      consensus: [],
      scanner: ["claudeAgent"],
    },
    { providers: ["inline"] as const, scout: [], worker: [], consensus: [], scanner: [] },
    { providers: [] as const, scout: [], worker: [], consensus: [], scanner: [] },
  ])(
    "derives delegation roles for $providers",
    ({ providers, scout, worker, consensus, scanner }) => {
      const roles = deriveDefaultDelegationRoles(new Set(providers));
      expect(roles.scout?.map((target) => target.provider)).toEqual(scout);
      expect(roles.worker?.map((target) => target.provider)).toEqual(worker);
      expect(roles.consensus?.map((target) => target.provider)).toEqual(consensus);
      expect(roles.scanner?.map((target) => target.provider)).toEqual(scanner);
    },
  );

  it("materializes automatic delegation defaults while preserving explicit empty roles", () => {
    const automatic = resolveDelegationRoles(
      decodeEngineDelegationSettings({}),
      new Set(["claudeAgent", "codex", "cursor"]),
    );
    expect(automatic.scout).toEqual(SCOUT_DEFAULTS);
    expect(automatic.worker).toEqual(WORKER_DEFAULTS);
    expect(automatic.consensus).toEqual(CONSENSUS_DEFAULTS);
    expect(automatic.scanner).toEqual(SCANNER_DEFAULTS);

    const disabledScout = resolveDelegationRoles(
      decodeEngineDelegationSettings({ roles: { scout: [] } }),
      new Set(["claudeAgent", "codex", "cursor"]),
    );
    expect(disabledScout.scout).toEqual([]);
    expect(disabledScout.worker).toEqual(WORKER_DEFAULTS);
  });

  it("materializes only defaults supported by the supplied providers", () => {
    const resolved = resolveDelegationRoles(
      decodeEngineDelegationSettings({}),
      new Set(["claudeAgent", "codex"]),
    );
    expect(resolved.scout.map((target) => target.provider)).toEqual(["codex"]);
    expect(resolved.consensus.map((target) => target.provider)).toEqual(["codex"]);
    expect(resolved.scanner.map((target) => target.provider)).toEqual(["claudeAgent", "codex"]);
  });

  it("migrates a persisted inline scanner to Claude delegation", () => {
    const resolved = resolveDelegationRoles(
      decodeEngineDelegationSettings({
        roles: { scanner: [{ provider: "inline", model: "claude-opus-4-8" }] },
      }),
      new Set(["claudeAgent"]),
    );
    expect(resolved.scanner).toEqual([{ provider: "claudeAgent", model: "claude-opus-4-8" }]);
  });

  it("round-trips scan thread model preferences", () => {
    const input = {
      mcp: {
        engine: {
          knowledgeScan: {
            mainThreadModelPreference: [
              {
                instanceId: "claudeAgent",
                model: "claude-opus-4-8",
                options: [{ id: "effort", value: "max" }],
              },
              { instanceId: "codex", model: "gpt-5.6-terra" },
            ],
          },
        },
      },
    };
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });

  it("preserves legacy persisted role chains as explicit customization", () => {
    const decoded = decodeServerSettings({
      mcp: {
        engine: {
          delegation: { roles: { scout: [{ provider: "codex", model: "legacy" }] } },
        },
      },
    });
    expect(decoded.mcp.engine.delegation.roles.scout).toEqual([
      { provider: "codex", model: "legacy" },
    ]);
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
