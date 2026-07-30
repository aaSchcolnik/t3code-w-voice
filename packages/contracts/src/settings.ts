import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { DelegationRouterSettings, DelegationRouterSettingsOverride } from "./delegationRouter.ts";
import { DEFAULT_TEXT_GENERATION_MODEL, ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";
import { ProjectMcpOverrides } from "./projectMcpOverrides.ts";
export { ProjectEngineDelegationOverrides, ProjectMcpOverrides } from "./projectMcpOverrides.ts";
import { DelegatedRunProvider, DelegationProfile } from "./delegatedRun.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;
export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
export const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;
export const EnvironmentIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

export const VoiceInferenceMode = Schema.Literals(["auto", "local", "server"]);
export type VoiceInferenceMode = typeof VoiceInferenceMode.Type;

export const DesktopNotificationPreferences = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  attention: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  agentCompletion: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  subagentCompletion: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  failures: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  stopped: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sound: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  notifyWhileViewingThread: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type DesktopNotificationPreferences = typeof DesktopNotificationPreferences.Type;

export const ENGINE_WORKFLOW_NAMES = [
  "plan-brief",
  "plan",
  "consensus",
  "enrich",
  "implement",
  "quality-audit",
  "quality-quick",
  "quality-pr",
  "hot-loops",
  "typescript",
] as const;
export const EngineWorkflowNameSchema = Schema.Literals(ENGINE_WORKFLOW_NAMES);
export type EngineWorkflowName = typeof EngineWorkflowNameSchema.Type;

export const EngineDelegationTarget = Schema.Struct({
  provider: Schema.Union([DelegatedRunProvider, Schema.Literal("inline")]),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
  focus: Schema.optional(TrimmedNonEmptyString),
});
export type EngineDelegationTarget = typeof EngineDelegationTarget.Type;

export const EngineDelegationRole = Schema.Literals(["scout", "worker", "consensus", "scanner"]);
export type EngineDelegationRole = typeof EngineDelegationRole.Type;

export const SCOUT_DEFAULTS: ReadonlyArray<EngineDelegationTarget> = [
  { provider: "cursor", model: "composer-2.5" },
  {
    provider: "codex",
    model: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "low" }],
  },
];

export const WORKER_DEFAULTS: ReadonlyArray<EngineDelegationTarget> = [
  {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  {
    provider: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "medium" }],
  },
  { provider: "cursor", model: "composer-2.5" },
];

// Consensus panel, not a fallback chain: every available entry runs in parallel.
export const CONSENSUS_DEFAULTS: ReadonlyArray<EngineDelegationTarget> = [
  {
    provider: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  { provider: "cursor", model: "grok-4.5" },
];

// Scanner panel, not a fallback chain: every available delegated entry runs in parallel.
export const SCANNER_DEFAULTS: ReadonlyArray<EngineDelegationTarget> = [
  {
    provider: "claudeAgent",
    model: "claude-opus-4-8",
    options: [{ id: "effort", value: "max" }],
    focus: "Run the complete codebase scan in a dedicated Claude Opus 4.8 subagent.",
  },
  {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: [{ id: "reasoningEffort", value: "xhigh" }],
  },
  { provider: "cursor", model: "grok-4.5" },
  { provider: "cursor", model: "glm-5.2" },
];

export const DEFAULT_KNOWLEDGE_SCAN_MAIN_THREAD_MODEL_PREFERENCE: ReadonlyArray<ModelSelection> = [
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-4-8",
    options: [{ id: "effort", value: "max" }],
  },
  {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-terra",
    options: [{ id: "reasoningEffort", value: "xhigh" }],
  },
  { instanceId: ProviderInstanceId.make("cursor"), model: "grok-4.5" },
];

const EngineDelegationSkillOverrideCanonical = Schema.Struct({
  scout: Schema.optional(Schema.Array(EngineDelegationTarget)),
  worker: Schema.optional(Schema.Array(EngineDelegationTarget)),
  consensus: Schema.optional(Schema.Array(EngineDelegationTarget)),
  scanner: Schema.optional(Schema.Array(EngineDelegationTarget)),
});

export const EngineDelegationSkillOverride = Schema.Struct({
  scout: Schema.optional(Schema.Unknown),
  worker: Schema.optional(Schema.Unknown),
  consensus: Schema.optional(Schema.Unknown),
  scanner: Schema.optional(Schema.Unknown),
  auditor: Schema.optional(Schema.Unknown),
}).pipe(
  Schema.decodeTo(
    EngineDelegationSkillOverrideCanonical,
    SchemaTransformation.transformOrFail({
      decode: (input) => {
        const { auditor, consensus, ...override } = input as Record<string, unknown>;
        return Effect.succeed({
          ...override,
          ...((consensus ?? auditor) === undefined ? {} : { consensus: consensus ?? auditor }),
        });
      },
      // The encoded side widens branded provider instance ids back to strings.
      encode: (override) => Effect.succeed(override as any),
    }) as any,
  ),
);
export type EngineDelegationSkillOverride = typeof EngineDelegationSkillOverride.Type;

const engineWorkflowNameSet = new Set<string>(ENGINE_WORKFLOW_NAMES);
export const EngineDelegationSkillOverrides = Schema.Record(
  Schema.String,
  EngineDelegationSkillOverride,
).check(
  Schema.makeFilter((overrides) => {
    const invalidKey = Object.keys(overrides).find((key) => !engineWorkflowNameSet.has(key));
    return invalidKey === undefined
      ? undefined
      : { path: [invalidKey], issue: `Unknown engine workflow '${invalidKey}'.` };
  }),
);

const EngineDelegationRolesCanonical = Schema.Struct({
  scout: Schema.optional(Schema.Array(EngineDelegationTarget)),
  worker: Schema.optional(Schema.Array(EngineDelegationTarget)),
  consensus: Schema.optional(Schema.Array(EngineDelegationTarget)),
  scanner: Schema.optional(Schema.Array(EngineDelegationTarget)),
});

const EngineDelegationRoles = Schema.Struct({
  scout: Schema.optional(Schema.Unknown),
  worker: Schema.optional(Schema.Unknown),
  consensus: Schema.optional(Schema.Unknown),
  scanner: Schema.optional(Schema.Unknown),
  auditor: Schema.optional(Schema.Unknown),
}).pipe(
  Schema.decodeTo(
    EngineDelegationRolesCanonical,
    SchemaTransformation.transformOrFail({
      decode: (input) => {
        const { auditor, consensus, ...roles } = input as Record<string, unknown>;
        return Effect.succeed({
          ...roles,
          ...((consensus ?? auditor) === undefined ? {} : { consensus: consensus ?? auditor }),
        });
      },
      // The encoded side widens branded provider instance ids back to strings.
      encode: (roles) => Effect.succeed(roles as any),
    }) as any,
  ),
);

export const EngineDelegationSettings = Schema.Struct({
  roles: EngineDelegationRoles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  skillOverrides: EngineDelegationSkillOverrides.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type EngineDelegationSettings = typeof EngineDelegationSettings.Type;

export const KnowledgeScanSettings = Schema.Struct({
  mainThreadModelPreference: Schema.Array(ModelSelection).pipe(
    Schema.withDecodingDefault(
      Effect.succeed([...DEFAULT_KNOWLEDGE_SCAN_MAIN_THREAD_MODEL_PREFERENCE]),
    ),
  ),
});
export type KnowledgeScanSettings = typeof KnowledgeScanSettings.Type;

export const McpEngineSettings = Schema.Struct({
  planning: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  consensus: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enrich: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  implement: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  quality: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  performance: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  typescript: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  delegation: EngineDelegationSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  knowledgeScan: KnowledgeScanSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type McpEngineSettings = typeof McpEngineSettings.Type;

export const McpSettings = Schema.Struct({
  preview: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  codexAgent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  cursorAgent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  claudeAgent: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  router: DelegationRouterSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  engine: McpEngineSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type McpSettings = typeof McpSettings.Type;

export const DELEGATION_SUBAGENT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.5",
  cursor: "composer-2.5",
  claudeAgent: "claude-sonnet-5",
} as const;

export const NATIVE_SUBAGENT_MODEL_BY_DRIVER = {
  claudeAgent: "claude-sonnet-5",
  codex: "gpt-5.5",
} as const;

export function deriveDefaultDelegationRoles(
  availableProviders: ReadonlySet<DelegatedRunProvider | "inline">,
): EngineDelegationSettings["roles"] {
  const available = (target: EngineDelegationTarget) =>
    target.provider === "inline"
      ? availableProviders.has("inline")
      : availableProviders.has(target.provider);
  return {
    scout: SCOUT_DEFAULTS.filter(available),
    worker: WORKER_DEFAULTS.filter(available),
    consensus: CONSENSUS_DEFAULTS.filter(available),
    scanner: SCANNER_DEFAULTS.filter(available),
  };
}

export interface ResolvedEngineDelegationRoles {
  readonly scout: ReadonlyArray<EngineDelegationTarget>;
  readonly worker: ReadonlyArray<EngineDelegationTarget>;
  readonly consensus: ReadonlyArray<EngineDelegationTarget>;
  readonly scanner: ReadonlyArray<EngineDelegationTarget>;
}

/**
 * Materializes automatic role defaults without losing the distinction between
 * an omitted role (automatic) and an explicit empty chain (disabled).
 */
export function resolveDelegationRoles(
  settings: EngineDelegationSettings,
  availableProviders: ReadonlySet<DelegatedRunProvider | "inline">,
): ResolvedEngineDelegationRoles {
  const defaults = deriveDefaultDelegationRoles(availableProviders);
  const scanner = settings.roles.scanner ?? defaults.scanner ?? [];
  return {
    scout: settings.roles.scout ?? defaults.scout ?? [],
    worker: settings.roles.worker ?? defaults.worker ?? [],
    consensus: settings.roles.consensus ?? defaults.consensus ?? [],
    // Preserve decoding compatibility for existing settings while removing the
    // old behavior: a persisted inline scanner now resolves to a real Claude run.
    scanner: scanner.map((target) =>
      target.provider === "inline" ? { ...target, provider: "claudeAgent" } : target,
    ),
  };
}

export function resolveEffectiveMcpSettings(
  global: McpSettings,
  overrides: ProjectMcpOverrides | undefined,
): McpSettings {
  if (overrides === undefined) return global;

  const engineOverrides = overrides.engine;
  const delegationOverrides = engineOverrides?.delegation;
  const globalDelegation = global.engine.delegation;

  return {
    preview: overrides.preview ?? global.preview,
    codexAgent: overrides.codexAgent ?? global.codexAgent,
    cursorAgent: overrides.cursorAgent ?? global.cursorAgent,
    claudeAgent: overrides.claudeAgent ?? global.claudeAgent,
    router: {
      mode: overrides.router?.mode ?? global.router.mode,
      maxBatchSize: overrides.router?.maxBatchSize ?? global.router.maxBatchSize,
      maxConcurrentPerParent:
        overrides.router?.maxConcurrentPerParent ?? global.router.maxConcurrentPerParent,
      maxConcurrentEnvironment:
        overrides.router?.maxConcurrentEnvironment ?? global.router.maxConcurrentEnvironment,
      defaultTimeoutMs: overrides.router?.defaultTimeoutMs ?? global.router.defaultTimeoutMs,
      diversity: overrides.router?.diversity ?? global.router.diversity,
      fallback: overrides.router?.fallback ?? global.router.fallback,
      explanation: overrides.router?.explanation ?? global.router.explanation,
    },
    engine: {
      planning: engineOverrides?.planning ?? global.engine.planning,
      consensus: engineOverrides?.consensus ?? global.engine.consensus,
      enrich: engineOverrides?.enrich ?? global.engine.enrich,
      implement: engineOverrides?.implement ?? global.engine.implement,
      quality: engineOverrides?.quality ?? global.engine.quality,
      performance: engineOverrides?.performance ?? global.engine.performance,
      typescript: engineOverrides?.typescript ?? global.engine.typescript,
      knowledgeScan: global.engine.knowledgeScan,
      delegation: {
        roles: {
          ...globalDelegation.roles,
          ...delegationOverrides?.roles,
        },
        skillOverrides: {
          ...globalDelegation.skillOverrides,
          ...delegationOverrides?.skillOverrides,
        },
      },
    },
  };
}

export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoOpenSubagentsPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  desktopNotifications: DesktopNotificationPreferences.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  sidebarV2Enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Whether `sidebarV2Enabled` reflects an explicit choice in Settings → Beta.
  // Client settings persist as a whole blob, so every user who has ever touched
  // any setting already has `sidebarV2Enabled: false` stored — without this bit
  // there is no way to tell that apart from "left alone", and a channel-derived
  // default could never reach them. Mirrors `updateChannelConfiguredByUser`.
  sidebarV2ConfiguredByUser: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  /** Per-device inference preference; server settings remain shared. */
  voiceInferenceMode: VoiceInferenceMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("auto" as const satisfies VoiceInferenceMode)),
  ),
  voiceModelId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  voiceModelQuant: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("cursor-agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "cursor-agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

export const MAX_VOICE_DICTIONARY_ENTRIES = 256;
export const MAX_VOICE_DICTIONARY_ORIGINALS = 16;
export const MAX_VOICE_DICTIONARY_TEXT_LENGTH = 256;

const VoiceDictionaryText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_VOICE_DICTIONARY_TEXT_LENGTH),
);

export const VoiceDictionaryEntry = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  type: Schema.Literals(["term", "alias"]),
  originals: Schema.Array(VoiceDictionaryText).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_VOICE_DICTIONARY_ORIGINALS),
  ),
  replacement: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(MAX_VOICE_DICTIONARY_TEXT_LENGTH)),
  ),
  caseSensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  fuzzy: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.type === "alias"
        ? entry.replacement !== undefined && entry.replacement.length > 0
        : entry.replacement === undefined,
    {
      message:
        "Alias dictionary entries require a non-empty replacement; term entries must omit it.",
    },
  ),
);
export type VoiceDictionaryEntry = typeof VoiceDictionaryEntry.Type;

export const VoiceDictionary = Schema.Array(VoiceDictionaryEntry).check(
  Schema.isMaxLength(MAX_VOICE_DICTIONARY_ENTRIES),
  Schema.makeFilter(
    (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
    { message: "Voice dictionary entry IDs must be unique." },
  ),
);

export const VoiceEngine = Schema.Literals(["sidecar", "transcribecpp"]);
export type VoiceEngine = typeof VoiceEngine.Type;

export const VoiceSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Default language hint passed to the ASR sidecar (e.g. "es", "en"). Empty = auto. */
  language: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Path to the ASR sidecar binary. Empty = bundled default lookup. */
  sidecarPath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Minutes of no audio before the sidecar process is killed to free memory. */
  idleTimeoutMinutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefault(Effect.succeed(5)),
  ),
  dictionary: VoiceDictionary.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  engine: VoiceEngine.pipe(
    Schema.withDecodingDefault(Effect.succeed("sidecar" as const satisfies VoiceEngine)),
  ),
});
export type VoiceSettings = typeof VoiceSettings.Type;

export const SKILL_TOGGLE_PROVIDER_IDS = [
  "claudeAgent",
  "codex",
  "opencode",
  "cursor",
  "grok",
] as const;
export const SkillToggleProviderId = Schema.Literals(SKILL_TOGGLE_PROVIDER_IDS);
export type SkillToggleProviderId = typeof SkillToggleProviderId.Type;

export const SkillProviderToggles = Schema.Struct({
  disableAll: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  disabledSkills: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SkillProviderToggles = typeof SkillProviderToggles.Type;

export const SkillToggleSettings = Schema.Struct({
  disableAllProviders: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  providers: Schema.Struct({
    claudeAgent: SkillProviderToggles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    codex: SkillProviderToggles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: SkillProviderToggles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: SkillProviderToggles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: SkillProviderToggles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type SkillToggleSettings = typeof SkillToggleSettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,
  // Legacy flat fields retained for old settings files and old clients. New
  // consumers should resolve `backgroundActivity` instead.
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),
  sourceControlWritingStyle: SourceControlWritingStyleSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  voice: VoiceSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  skills: SkillToggleSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  mcp: McpSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  delegationProfiles: Schema.Array(DelegationProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  launchArgs: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const SkillProviderTogglesPatch = Schema.Struct({
  disableAll: Schema.optionalKey(Schema.Boolean),
  disabledSkills: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  voice: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      language: Schema.optionalKey(TrimmedString),
      sidecarPath: Schema.optionalKey(TrimmedString),
      idleTimeoutMinutes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      dictionary: Schema.optionalKey(VoiceDictionary),
      engine: Schema.optionalKey(VoiceEngine),
    }),
  ),
  skills: Schema.optionalKey(
    Schema.Struct({
      disableAllProviders: Schema.optionalKey(Schema.Boolean),
      providers: Schema.optionalKey(
        Schema.Struct({
          claudeAgent: Schema.optionalKey(SkillProviderTogglesPatch),
          codex: Schema.optionalKey(SkillProviderTogglesPatch),
          opencode: Schema.optionalKey(SkillProviderTogglesPatch),
          cursor: Schema.optionalKey(SkillProviderTogglesPatch),
          grok: Schema.optionalKey(SkillProviderTogglesPatch),
        }),
      ),
    }),
  ),
  mcp: Schema.optionalKey(
    Schema.Struct({
      preview: Schema.optionalKey(Schema.Boolean),
      codexAgent: Schema.optionalKey(Schema.Boolean),
      cursorAgent: Schema.optionalKey(Schema.Boolean),
      claudeAgent: Schema.optionalKey(Schema.Boolean),
      router: Schema.optionalKey(DelegationRouterSettingsOverride),
      engine: Schema.optionalKey(
        Schema.Struct({
          planning: Schema.optionalKey(Schema.Boolean),
          consensus: Schema.optionalKey(Schema.Boolean),
          enrich: Schema.optionalKey(Schema.Boolean),
          implement: Schema.optionalKey(Schema.Boolean),
          quality: Schema.optionalKey(Schema.Boolean),
          performance: Schema.optionalKey(Schema.Boolean),
          typescript: Schema.optionalKey(Schema.Boolean),
          delegation: Schema.optionalKey(
            Schema.Struct({
              roles: Schema.optionalKey(
                Schema.Struct({
                  scout: Schema.optionalKey(Schema.Array(EngineDelegationTarget)),
                  worker: Schema.optionalKey(Schema.Array(EngineDelegationTarget)),
                  consensus: Schema.optionalKey(Schema.Array(EngineDelegationTarget)),
                  scanner: Schema.optionalKey(Schema.Array(EngineDelegationTarget)),
                }),
              ),
              skillOverrides: Schema.optionalKey(EngineDelegationSkillOverrides),
            }),
          ),
          knowledgeScan: Schema.optionalKey(
            Schema.Struct({
              mainThreadModelPreference: Schema.optionalKey(Schema.Array(ModelSelection)),
            }),
          ),
        }),
      ),
    }),
  ),
  delegationProfiles: Schema.optionalKey(Schema.Array(DelegationProfile)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  autoOpenSubagentsPanel: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  desktopNotifications: Schema.optionalKey(DesktopNotificationPreferences),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  sidebarV2Enabled: Schema.optionalKey(Schema.Boolean),
  sidebarV2ConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  voiceInferenceMode: Schema.optionalKey(VoiceInferenceMode),
  voiceModelId: Schema.optionalKey(TrimmedString),
  voiceModelQuant: Schema.optionalKey(TrimmedString),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
