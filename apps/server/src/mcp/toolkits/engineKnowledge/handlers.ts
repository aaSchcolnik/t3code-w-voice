import {
  CommandId,
  type EngineDelegationSettings,
  type EngineDelegationTarget,
  KnowledgeError,
  ProjectMcpOverrides,
  type ProjectEngineDelegationOverrides,
  type ProviderDriverKind,
  resolveDelegationRoles,
  resolveEffectiveMcpSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  getArtifact,
  getKnowledge,
  importAuditPacks,
  knowledgeStatus,
  listArtifacts,
  openCase,
  saveArtifact,
  saveKnowledge,
  recordKnowledgeScan,
  searchKnowledge,
} from "../../../knowledge/KnowledgeRepository.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EngineKnowledgeToolkit } from "./tools.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import type { McpCapability } from "../../McpInvocationContext.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { mergeScannerReports } from "../../../knowledge/mergeScannerReports.ts";
import { selectBootstrapWorkflow, workspaceHasCodebase } from "../../../knowledge/bootstrapScan.ts";

const fail = (operation: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new KnowledgeError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  );

const requireCapability = McpInvocationContext.requireMcpCapability("engine-knowledge").pipe(
  Effect.mapError(
    () =>
      new KnowledgeError({
        operation: "authorize",
        message: "This session does not grant the Implementation Engine knowledge capability.",
      }),
  ),
);
const decodeProjectMcpOverrides = Schema.decodeEffect(ProjectMcpOverrides);

const bootstrapWorkflow = `# Implementation Engine knowledge bootstrap

1. Read the project's package manifests and framework/compiler/build configuration. Identify language, framework, package manager, test runner, async model, state management, styling, i18n, and default branch.
2. Read lint configuration plus CONTRIBUTING, README, AGENTS, and equivalent project guidance. Extract conventions; do not infer rules from a single example.
3. Map source layers, path aliases, file suffixes, and allowed import directions. Verify the matrix against actual imports.
4. Inventory durable knowledge entities across architecture, capabilities, reusable building blocks, contracts, data, integrations, and operations. Include UI primitives, services, repositories, clients, schemas, design tokens, animations, infrastructure, tests, deployment, and recovery when present. Rank reusable items by consumers and record when each should be reused.
5. Record relationships between those entities, then search recurring fixes and tests for lessons, gotchas, and high-risk rules.
6. Save discoveries with engine_knowledge_save as proposed. Present the proposed profile and important rules to the user. Only after explicit approval, save them again with confirmed=true.

Keep evidence in summaries. Do not write bootstrap files into the repository.`;

const providerCapability = {
  codex: "codex-agent",
  cursor: "cursor-agent",
  claudeAgent: "claude-agent",
  antigravity: "antigravity-agent",
} as const;

const targetAvailable = (
  target: EngineDelegationTarget,
  capabilities: ReadonlySet<McpCapability>,
  providerDriver?: ProviderDriverKind,
): boolean =>
  target.provider === "inline" ||
  (target.provider === "claudeAgent" && providerDriver === "claudeAgent") ||
  capabilities.has(providerCapability[target.provider]);

const availableDelegationProviders = (
  capabilities: ReadonlySet<McpCapability>,
  providerDriver?: ProviderDriverKind,
) => {
  const providers = new Set<EngineDelegationTarget["provider"]>(["inline"]);
  if (providerDriver === "claudeAgent" || capabilities.has("claude-agent")) {
    providers.add("claudeAgent");
  }
  if (capabilities.has("codex-agent")) providers.add("codex");
  if (capabilities.has("cursor-agent")) providers.add("cursor");
  if (capabilities.has("antigravity-agent")) providers.add("antigravity");
  return providers;
};

const resolveTargets = (
  chain: ReadonlyArray<EngineDelegationTarget>,
  capabilities: ReadonlySet<McpCapability>,
  providerDriver?: ProviderDriverKind,
) =>
  chain.map((target) => {
    const capability =
      target.provider === "inline" ? undefined : providerCapability[target.provider];
    const available = targetAvailable(target, capabilities, providerDriver);
    return {
      target,
      available,
      ...(available ? {} : { reason: `Session capability '${capability}' is unavailable.` }),
    };
  });

const delegationConfiguration = (
  settings: EngineDelegationSettings,
  capabilities: ReadonlySet<McpCapability>,
  providerDriver?: ProviderDriverKind,
) => {
  const roles = resolveDelegationRoles(
    settings,
    availableDelegationProviders(capabilities, providerDriver),
  );
  return {
    roles,
    skillOverrides: settings.skillOverrides,
    resolved: {
      roles: {
        scout: resolveTargets(roles.scout, capabilities, providerDriver),
        worker: resolveTargets(roles.worker, capabilities, providerDriver),
        consensus: resolveTargets(roles.consensus, capabilities, providerDriver),
        scanner: resolveTargets(roles.scanner, capabilities, providerDriver),
      },
      skillOverrides: Object.fromEntries(
        Object.entries(settings.skillOverrides).map(([workflow, override]) => [
          workflow,
          {
            ...(override.scout === undefined
              ? {}
              : { scout: resolveTargets(override.scout, capabilities, providerDriver) }),
            ...(override.worker === undefined
              ? {}
              : { worker: resolveTargets(override.worker, capabilities, providerDriver) }),
            ...(override.consensus === undefined
              ? {}
              : { consensus: resolveTargets(override.consensus, capabilities, providerDriver) }),
            ...(override.scanner === undefined
              ? {}
              : { scanner: resolveTargets(override.scanner, capabilities, providerDriver) }),
          },
        ]),
      ),
    },
  };
};

const updateDelegation = (
  delegation: EngineDelegationSettings,
  input: {
    readonly role: "scout" | "worker" | "consensus" | "scanner";
    readonly workflow?: string | undefined;
    readonly chain: ReadonlyArray<EngineDelegationTarget>;
    readonly emptyMeansDelete: boolean;
  },
): EngineDelegationSettings => {
  if (input.workflow === undefined) {
    const roles = { ...delegation.roles };
    if (input.emptyMeansDelete && input.chain.length === 0) delete roles[input.role];
    else roles[input.role] = input.chain;
    return { ...delegation, roles };
  }
  const existing = delegation.skillOverrides[input.workflow] ?? {};
  const updated = { ...existing };
  if (input.chain.length === 0) delete updated[input.role];
  else updated[input.role] = input.chain;
  const skillOverrides = { ...delegation.skillOverrides };
  if (
    updated.scout === undefined &&
    updated.worker === undefined &&
    updated.consensus === undefined &&
    updated.scanner === undefined
  ) {
    delete skillOverrides[input.workflow];
  } else {
    skillOverrides[input.workflow] = updated;
  }
  return { ...delegation, skillOverrides };
};

const configurationResult = (input: {
  readonly scope: "project" | "global";
  readonly global: EngineDelegationSettings;
  readonly projectOverrides?: ProjectEngineDelegationOverrides | undefined;
  readonly effective: EngineDelegationSettings;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly providerDriver?: ProviderDriverKind;
}) => ({
  scope: input.scope,
  global: input.global,
  ...(input.projectOverrides === undefined ? {} : { projectOverrides: input.projectOverrides }),
  effective: input.effective,
  ...delegationConfiguration(input.effective, input.capabilities, input.providerDriver),
});

const normalizeProjectDelegation = (
  delegation: ProjectEngineDelegationOverrides | undefined,
): EngineDelegationSettings => ({
  roles: delegation?.roles ?? {},
  skillOverrides: delegation?.skillOverrides ?? {},
});

const COMPACT_KNOWLEDGE_SCOPES = [
  "rules",
  "lessons",
  "architecture",
  "capabilities",
  "building-blocks",
  "contracts",
  "integrations",
] as const;
type CompactKnowledgeScope = (typeof COMPACT_KNOWLEDGE_SCOPES)[number];

const scopeQuery = (
  scope: CompactKnowledgeScope,
  input: {
    readonly projectId: NonNullable<McpInvocationContext.McpInvocationScope["projectId"]>;
    readonly query: string;
    readonly scopePath?: string | undefined;
    readonly limit: number;
  },
) => {
  switch (scope) {
    case "rules":
      return searchKnowledge(input.projectId, {
        table: "rules",
        query: input.query,
        limit: input.limit,
      });
    case "lessons":
      return searchKnowledge(input.projectId, {
        table: "lessons_learned",
        query: input.query,
        scopePath: input.scopePath,
        limit: input.limit,
      });
    case "architecture":
      return searchKnowledge(input.projectId, {
        table: "knowledge_entities",
        category: "architecture",
        query: input.query,
        limit: input.limit,
      });
    case "capabilities":
      return searchKnowledge(input.projectId, {
        table: "knowledge_entities",
        category: "capability",
        query: input.query,
        limit: input.limit,
      });
    case "building-blocks":
      return searchKnowledge(input.projectId, {
        table: "knowledge_entities",
        category: "building-block",
        query: input.query,
        limit: input.limit,
      });
    case "contracts":
      return searchKnowledge(input.projectId, {
        table: "knowledge_entities",
        category: "contract",
        query: input.query,
        limit: input.limit,
      });
    case "integrations":
      return searchKnowledge(input.projectId, {
        table: "knowledge_entities",
        category: "integration",
        query: input.query,
        limit: input.limit,
      });
  }
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" && value.length > 0
      ? [value]
      : [];

const compactExcerpt = (
  scope: CompactKnowledgeScope,
  row: Record<string, unknown>,
  maxChars: number,
): string => {
  const candidates =
    scope === "rules"
      ? [row.rule_text, row.concern, row.risk, row.gotchas]
      : scope === "lessons"
        ? [row.title, row.body]
        : [row.name, row.summary, row.reuse_guidance, row.public_api];
  const text = candidates.flatMap(strings).join(" — ").replace(/\s+/gu, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
};

const evidencePaths = (
  scope: CompactKnowledgeScope,
  row: Record<string, unknown>,
): ReadonlyArray<string> => {
  const paths = [
    ...strings(row.locations),
    ...strings(row.evidence),
    ...(scope === "rules" ? strings(row.imports) : []),
    ...(scope === "lessons" ? strings(row.scope_glob) : []),
  ];
  return [...new Set(paths)].slice(0, 8).map((path) => path.slice(0, 240));
};

const compactKnowledgeSearch = Effect.fn("engineKnowledge.compactSearch")(function* (input: {
  readonly projectId: NonNullable<McpInvocationContext.McpInvocationScope["projectId"]>;
  readonly query: string;
  readonly scopes?: ReadonlyArray<CompactKnowledgeScope> | undefined;
  readonly scopePath?: string | undefined;
  readonly limit?: number | undefined;
  readonly excerptChars?: number | undefined;
  readonly budgetChars?: number | undefined;
}) {
  const scopes = input.scopes?.length ? input.scopes : COMPACT_KNOWLEDGE_SCOPES;
  const limit = Math.max(1, Math.min(input.limit ?? 10, 20));
  const excerptChars = Math.max(120, Math.min(input.excerptChars ?? 360, 1_000));
  const budgetChars = Math.max(500, Math.min(input.budgetChars ?? 4_000, 8_000));
  const rowsByScope = yield* Effect.all(
    scopes.map((scope) =>
      scopeQuery(scope, {
        projectId: input.projectId,
        query: input.query,
        scopePath: input.scopePath,
        limit,
      }).pipe(Effect.map((rows) => ({ scope, rows }))),
    ),
    { concurrency: "unbounded" },
  );

  const results: Array<{
    readonly scope: CompactKnowledgeScope;
    readonly handle: string;
    readonly excerpt: string;
    readonly evidencePaths: ReadonlyArray<string>;
  }> = [];
  let usedChars = 0;
  let truncated = false;
  for (const { scope, rows } of rowsByScope) {
    for (const row of rows) {
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      let excerpt = compactExcerpt(scope, row, excerptChars);
      if (excerpt.length === 0) continue;
      const paths = evidencePaths(scope, row);
      const pathCost = paths.reduce((sum, path) => sum + path.length, 0);
      const remainingExcerptChars = budgetChars - usedChars - pathCost;
      if (remainingExcerptChars <= 0) {
        truncated = true;
        continue;
      }
      if (excerpt.length > remainingExcerptChars) {
        truncated = true;
        excerpt =
          remainingExcerptChars === 1 ? "…" : `${excerpt.slice(0, remainingExcerptChars - 1)}…`;
      }
      const cost = excerpt.length + pathCost;
      const stableId =
        row.entity_key ?? row.relationship_key ?? row.id ?? `${scope}-${results.length + 1}`;
      results.push({
        scope,
        handle: `knowledge/${scope}/${encodeURIComponent(String(stableId))}`,
        excerpt,
        evidencePaths: paths,
      });
      usedChars += cost;
    }
  }
  return {
    query: input.query,
    scopes,
    results,
    resultCount: results.length,
    budget: { maxChars: budgetChars, usedChars, truncated },
  };
});

export const EngineKnowledgeToolkitHandlersLive = EngineKnowledgeToolkit.toLayer({
  engine_knowledge_status: () =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return { data: yield* knowledgeStatus(scope.projectId!).pipe(fail("status")) };
    }),
  engine_knowledge_search: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return { data: yield* searchKnowledge(scope.projectId!, input).pipe(fail("search")) };
    }),
  knowledge_search: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return {
        data: yield* compactKnowledgeSearch({
          projectId: scope.projectId!,
          ...input,
        }).pipe(fail("compact-search")),
      };
    }),
  engine_knowledge_get: ({ table, id }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return { data: yield* getKnowledge(scope.projectId!, table, id).pipe(fail("get")) };
    }),
  engine_knowledge_save: ({ table, rows, confirmed }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return {
        data: {
          ids: yield* saveKnowledge(scope.projectId!, table, rows, confirmed).pipe(fail("save")),
        },
      };
    }),
  engine_knowledge_bootstrap: ({ packs }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      const selected = packs ?? ["generic"];
      const imported = yield* importAuditPacks(scope.projectId!, selected).pipe(fail("bootstrap"));
      const projects = yield* ProjectionProjectRepository;
      const project = yield* projects
        .getById({ projectId: scope.projectId! })
        .pipe(fail("bootstrap"));
      if (Option.isNone(project) || !workspaceHasCodebase(project.value.workspaceRoot)) {
        return {
          data: {
            workflow: selectBootstrapWorkflow({
              hasCodebase: false,
              scanners: [],
              legacyWorkflow: bootstrapWorkflow,
            }),
            importedRules: imported,
            packs: selected,
          },
        };
      }
      const serverSettings = yield* ServerSettingsService;
      const settings = yield* serverSettings.getSettings.pipe(fail("bootstrap"));
      const effective = resolveEffectiveMcpSettings(
        settings.mcp,
        project.value.mcpOverrides ?? undefined,
      );
      const scanners = resolveDelegationRoles(
        effective.engine.delegation,
        availableDelegationProviders(scope.capabilities, scope.providerDriver),
      ).scanner.filter((target) =>
        targetAvailable(target, scope.capabilities, scope.providerDriver),
      );
      return {
        data: {
          workflow: selectBootstrapWorkflow({
            hasCodebase: true,
            scanners,
            legacyWorkflow: bootstrapWorkflow,
            nativeClaudeSubagents: scope.providerDriver === "claudeAgent",
          }),
          importedRules: imported,
          packs: selected,
        },
      };
    }),
  engine_knowledge_merge_reports: ({ reports }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      const crypto = yield* Crypto.Crypto;
      const scanRunId = yield* crypto.randomUUIDv4.pipe(fail("merge-reports"));
      const merged = mergeScannerReports(reports, { scanRunId });
      yield* Effect.all(
        [
          saveKnowledge(scope.projectId!, "project_profile", merged.candidates.project_profile),
          saveKnowledge(
            scope.projectId!,
            "knowledge_entities",
            merged.candidates.knowledge_entities,
          ),
          saveKnowledge(
            scope.projectId!,
            "knowledge_relationships",
            merged.candidates.knowledge_relationships,
          ),
          saveKnowledge(scope.projectId!, "rules", merged.candidates.rules),
          saveKnowledge(scope.projectId!, "lessons_learned", merged.candidates.lessons_learned),
        ],
        { concurrency: 1 },
      ).pipe(fail("merge-reports"));
      yield* recordKnowledgeScan(scope.projectId!, {
        scanRunId,
        reportCount: reports.length,
        conflictCount: merged.conflicts.length,
        failureCount: merged.failures.length,
        markMissingStale: reports.some((report) => report.failures.length === 0),
      }).pipe(fail("merge-reports"));
      return { data: { ...merged, scanRunId, persisted: true } };
    }),
  engine_case_open: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return { data: yield* openCase(scope.projectId!, input).pipe(fail("case-open")) };
    }),
  engine_artifact_save: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return { data: yield* saveArtifact(scope.projectId!, input).pipe(fail("artifact-save")) };
    }),
  engine_artifact_get: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return { data: yield* getArtifact(scope.projectId!, input).pipe(fail("artifact-get")) };
    }),
  engine_artifact_list: ({ caseSlug }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return { data: yield* listArtifacts(scope.projectId!, caseSlug).pipe(fail("artifact-list")) };
    }),
  engine_delegation_get: () =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      const serverSettings = yield* ServerSettingsService;
      const settings = yield* serverSettings.getSettings.pipe(fail("delegation-get"));
      const projects = yield* ProjectionProjectRepository;
      const project = yield* projects
        .getById({ projectId: scope.projectId! })
        .pipe(fail("delegation-get"));
      const projectOverrides = Option.isSome(project)
        ? project.value.mcpOverrides?.engine?.delegation
        : undefined;
      const effective = resolveEffectiveMcpSettings(
        settings.mcp,
        Option.isSome(project) ? (project.value.mcpOverrides ?? undefined) : undefined,
      ).engine.delegation;
      return {
        data: configurationResult({
          scope: projectOverrides === undefined ? "global" : "project",
          global: settings.mcp.engine.delegation,
          projectOverrides,
          effective,
          capabilities: scope.capabilities,
          ...(scope.providerDriver === undefined ? {} : { providerDriver: scope.providerDriver }),
        }),
      };
    }),
  engine_delegation_set: ({ scope: requestedScope, role, workflow, chain }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      if (role === undefined) {
        return yield* new KnowledgeError({
          operation: "delegation-set",
          message: "A Scout, Worker, Consensus, or Scanner role is required.",
        });
      }
      const serverSettings = yield* ServerSettingsService;
      const current = yield* serverSettings.getSettings.pipe(fail("delegation-set"));
      const targetScope = requestedScope ?? "project";
      if (targetScope === "global") {
        const next = updateDelegation(current.mcp.engine.delegation, {
          role,
          workflow,
          chain,
          emptyMeansDelete: false,
        });
        const persistedNext = {
          ...next,
          roles: {
            ...(next.roles.scout === undefined ? {} : { scout: next.roles.scout }),
            ...(next.roles.worker === undefined ? {} : { worker: next.roles.worker }),
            ...(next.roles.consensus === undefined ? {} : { consensus: next.roles.consensus }),
            ...(next.roles.scanner === undefined ? {} : { scanner: next.roles.scanner }),
          },
        };
        const updatedSettings = yield* serverSettings
          .updateSettings({ mcp: { engine: { delegation: persistedNext } } })
          .pipe(fail("delegation-set"));
        return {
          data: configurationResult({
            scope: "global",
            global: updatedSettings.mcp.engine.delegation,
            effective: updatedSettings.mcp.engine.delegation,
            capabilities: scope.capabilities,
            ...(scope.providerDriver === undefined ? {} : { providerDriver: scope.providerDriver }),
          }),
        };
      }
      const projects = yield* ProjectionProjectRepository;
      const project = yield* projects
        .getById({ projectId: scope.projectId! })
        .pipe(fail("delegation-set"));
      if (Option.isNone(project)) {
        return yield* new KnowledgeError({
          operation: "delegation-set",
          message: "The current project no longer exists.",
        });
      }
      const existingOverrides = project.value.mcpOverrides ?? {};
      const existingDelegation = normalizeProjectDelegation(existingOverrides.engine?.delegation);
      const nextDelegation = updateDelegation(existingDelegation, {
        role,
        workflow,
        chain,
        emptyMeansDelete: true,
      });
      const nextOverrides = yield* decodeProjectMcpOverrides({
        ...existingOverrides,
        engine: {
          ...existingOverrides.engine,
          delegation: nextDelegation,
        },
      }).pipe(fail("delegation-set"));
      const orchestration = yield* OrchestrationEngineService;
      const crypto = yield* Crypto.Crypto;
      const commandId = yield* crypto.randomUUIDv4.pipe(Effect.map(CommandId.make), Effect.orDie);
      yield* orchestration
        .dispatch({
          type: "project.update-mcp-settings",
          commandId,
          projectId: scope.projectId!,
          mcpOverrides: nextOverrides,
        })
        .pipe(fail("delegation-set"));
      const effective = resolveEffectiveMcpSettings(current.mcp, nextOverrides).engine.delegation;
      return {
        data: configurationResult({
          scope: "project",
          global: current.mcp.engine.delegation,
          projectOverrides: nextDelegation,
          effective,
          capabilities: scope.capabilities,
          ...(scope.providerDriver === undefined ? {} : { providerDriver: scope.providerDriver }),
        }),
      };
    }),
});
