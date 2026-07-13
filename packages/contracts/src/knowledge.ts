import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ProjectId } from "./baseSchemas.ts";
import { ModelSelection } from "./model.ts";
import {
  EngineDelegationRole,
  EngineDelegationSettings,
  EngineDelegationTarget,
  EngineWorkflowNameSchema,
  type SkillToggleProviderId,
} from "./settings.ts";
import { ProjectEngineDelegationOverrides } from "./projectMcpOverrides.ts";

export const KnowledgeStatus = Schema.Literals(["proposed", "confirmed", "rejected"]);
export type KnowledgeStatus = typeof KnowledgeStatus.Type;
export const KnowledgeSource = Schema.Literals(["bootstrap", "agent", "user"]);
export type KnowledgeSource = typeof KnowledgeSource.Type;
export const KnowledgeTable = Schema.Literals([
  "project_profile",
  "reusable_components",
  "lessons_learned",
  "rules",
  "audit_rules",
  "features",
]);
export type KnowledgeTable = typeof KnowledgeTable.Type;
export const SearchableKnowledgeTable = Schema.Literals([
  "reusable_components",
  "lessons_learned",
  "rules",
  "audit_rules",
  "features",
]);
export type SearchableKnowledgeTable = typeof SearchableKnowledgeTable.Type;

export const ImplementationCaseKind = Schema.Literals([
  "plan-brief",
  "plan",
  "implement",
  "audit",
  "pr-review",
  "hot-loops",
  "report-only",
]);
export type ImplementationCaseKind = typeof ImplementationCaseKind.Type;
export const ImplementationCaseStatus = Schema.Literals(["active", "completed", "abandoned"]);
export const ArtifactFormat = Schema.Literals(["markdown", "json", "html"]);
export const ArtifactKind = Schema.Literals([
  "plan",
  "knowledge",
  "context",
  "chunk-spec",
  "chunk-state",
  "stress-test",
  "plan-consensus",
  "consensus-report",
  "edge-cases",
  "concern-map",
  "lift-audit",
  "audit-report",
  "pr-review",
  "hot-loops",
  "preview-verification",
  "html-report",
  "knowledge-scan",
]);
export type ArtifactKind = typeof ArtifactKind.Type;

export class KnowledgeError extends Schema.TaggedErrorClass<KnowledgeError>()("KnowledgeError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const KnowledgeStatusInput = Schema.Struct({});
export const KnowledgeSearchInput = Schema.Struct({
  table: SearchableKnowledgeTable,
  query: Schema.String,
  scopePath: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const KnowledgeGetInput = Schema.Struct({
  table: KnowledgeTable,
  id: Schema.Union([Schema.Number, Schema.String]),
});
export const KnowledgeSaveInput = Schema.Struct({
  table: KnowledgeTable,
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  confirmed: Schema.optional(Schema.Boolean),
});
export const KnowledgeBootstrapInput = Schema.Struct({
  packs: Schema.optional(Schema.Array(Schema.Literals(["generic", "angular-signals"]))),
});

export const ScanLane = Schema.Literals([
  "project-profile",
  "reusable-components",
  "rules-conventions",
  "lessons-gotchas",
  "feature-map",
]);
export type ScanLane = typeof ScanLane.Type;

export const ScannerIdentity = Schema.Struct({
  provider: Schema.Literals(["inline", "codex", "cursor"]),
  model: Schema.String,
  providerInstanceId: Schema.optional(Schema.String),
});
export type ScannerIdentity = typeof ScannerIdentity.Type;

const ScannerEvidence = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);
export const ScannerProfileFact = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  evidence: ScannerEvidence,
});
export const ScannerReusableComponent = Schema.Struct({
  path: Schema.String,
  exportName: Schema.String,
  summary: Schema.String,
  reuseWhen: Schema.optional(Schema.String),
  evidence: ScannerEvidence,
});
export const ScannerRule = Schema.Struct({
  text: Schema.String,
  scopePath: Schema.optional(Schema.String),
  rationale: Schema.optional(Schema.String),
  evidence: ScannerEvidence,
});
export const ScannerLesson = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
  scopePath: Schema.optional(Schema.String),
  evidence: ScannerEvidence,
});
export const ScannerFeature = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  paths: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  evidence: ScannerEvidence,
});
export const ScannerReport = Schema.Struct({
  lane: Schema.optional(ScanLane),
  scanner: ScannerIdentity,
  profileFacts: Schema.Array(ScannerProfileFact),
  reusable_components: Schema.Array(ScannerReusableComponent),
  rules: Schema.Array(ScannerRule),
  lessons_learned: Schema.Array(ScannerLesson),
  features: Schema.Array(ScannerFeature),
  failures: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ScannerReport = typeof ScannerReport.Type;
export const EngineKnowledgeMergeReportsInput = Schema.Struct({
  reports: Schema.Array(ScannerReport),
});
export const EngineCaseOpenInput = Schema.Struct({
  caseSlug: Schema.String,
  title: Schema.String,
  kind: ImplementationCaseKind,
});
export const EngineArtifactSaveInput = Schema.Struct({
  caseSlug: Schema.String,
  kind: ArtifactKind,
  seq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  title: Schema.String,
  format: ArtifactFormat,
  content: Schema.String,
});
export const EngineArtifactGetInput = Schema.Struct({
  id: Schema.optional(Schema.Int),
  caseSlug: Schema.optional(Schema.String),
  kind: Schema.optional(ArtifactKind),
  seq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  headLines: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
});
export const EngineArtifactListInput = Schema.Struct({
  caseSlug: Schema.optional(Schema.String),
});

export const KnowledgeResult = Schema.Struct({
  data: Schema.Unknown,
});

export const EngineLane = Schema.Literals(["fast", "focused", "full"]);
export const EngineConsensusMode = Schema.Literals(["analysis", "decision"]);
export type EngineConsensusMode = typeof EngineConsensusMode.Type;
export const EngineWorkflowInput = Schema.Struct({
  task: Schema.String,
  caseSlug: Schema.optional(Schema.String),
  lane: Schema.optional(EngineLane),
  scopePath: Schema.optional(Schema.String),
});
export const EngineConsensusInput = Schema.Struct({
  task: Schema.String,
  mode: Schema.optional(EngineConsensusMode),
  caseSlug: Schema.optional(Schema.String),
  lane: Schema.optional(EngineLane),
  subject: Schema.optional(Schema.String),
  subjectArtifact: Schema.optional(
    Schema.Struct({
      kind: ArtifactKind,
      seq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  scopePath: Schema.optional(Schema.String),
});
export const EngineReportRenderInput = Schema.Struct({
  caseSlug: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  kind: Schema.Literals(["report", "styled-plan"]),
});
export const EngineChunksNextInput = Schema.Struct({
  caseSlug: Schema.String,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export const EngineChunksUpdateInput = Schema.Struct({
  caseSlug: Schema.String,
  chunkId: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed", "failed"]),
  error: Schema.optional(Schema.String),
});

export const EngineDelegationGetInput = Schema.Struct({});
export const EngineDelegationSetInput = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["project", "global"])),
  role: Schema.optional(EngineDelegationRole),
  workflow: Schema.optional(EngineWorkflowNameSchema),
  chain: Schema.Array(EngineDelegationTarget),
}).check(
  Schema.makeFilter((input) =>
    input.role === undefined
      ? "role is required when setting an engine delegation chain."
      : undefined,
  ),
);

export const EngineDelegationResolvedTarget = Schema.Struct({
  target: EngineDelegationTarget,
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
const EngineDelegationResolvedOverride = Schema.Struct({
  scout: Schema.optional(Schema.Array(EngineDelegationResolvedTarget)),
  worker: Schema.optional(Schema.Array(EngineDelegationResolvedTarget)),
  consensus: Schema.optional(Schema.Array(EngineDelegationResolvedTarget)),
  scanner: Schema.optional(Schema.Array(EngineDelegationResolvedTarget)),
});
export const EngineDelegationConfigurationResult = Schema.Struct({
  data: Schema.Struct({
    scope: Schema.Literals(["project", "global"]),
    global: EngineDelegationSettings,
    projectOverrides: Schema.optional(ProjectEngineDelegationOverrides),
    effective: EngineDelegationSettings,
    roles: Schema.Struct({
      scout: Schema.Array(EngineDelegationTarget),
      worker: Schema.Array(EngineDelegationTarget),
      consensus: Schema.Array(EngineDelegationTarget),
      scanner: Schema.Array(EngineDelegationTarget),
    }),
    skillOverrides: Schema.Record(Schema.String, Schema.Unknown),
    resolved: Schema.Struct({
      roles: Schema.Struct({
        scout: Schema.Array(EngineDelegationResolvedTarget),
        worker: Schema.Array(EngineDelegationResolvedTarget),
        consensus: Schema.Array(EngineDelegationResolvedTarget),
        scanner: Schema.Array(EngineDelegationResolvedTarget),
      }),
      skillOverrides: Schema.Record(Schema.String, EngineDelegationResolvedOverride),
    }),
  }),
});

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
export const KnowledgeListProjectsInput = Schema.Struct({});
export const KnowledgeProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  pendingCount: Schema.Number,
});
export const KnowledgeProjectList = Schema.Array(KnowledgeProjectSummary);
export const ProjectSkillSource = Schema.Literals(["claude", "agents", "cursor", "codex"]);
export type ProjectSkillSource = typeof ProjectSkillSource.Type;
export const ProjectSkillLocation = Schema.Struct({
  source: ProjectSkillSource,
  scope: Schema.Literals(["project", "user"]),
  path: Schema.String,
});
export type ProjectSkillLocation = typeof ProjectSkillLocation.Type;
export const SKILL_TOGGLE_CAPABILITIES = {
  claudeAgent: "full",
  codex: "full",
  opencode: "full",
  cursor: "none",
  grok: "globalOnly",
} as const satisfies Record<SkillToggleProviderId, "full" | "none" | "globalOnly">;
export const ProjectSkill = Schema.Struct({
  skillId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  locations: Schema.Array(ProjectSkillLocation),
});
export type ProjectSkill = typeof ProjectSkill.Type;
export const KnowledgeListSkillsInput = Schema.Struct({ projectId: ProjectId });
export const KnowledgeSkillsResult = Schema.Struct({
  skills: Schema.Array(ProjectSkill),
  agentFiles: Schema.Struct({
    claudeMd: Schema.Boolean,
    agentsMd: Schema.Boolean,
  }),
  scannedRoot: Schema.NullOr(Schema.String),
});
export type KnowledgeSkillsResult = typeof KnowledgeSkillsResult.Type;
export const KnowledgeScanAvailabilityInput = Schema.Struct({ projectId: ProjectId });
export const KnowledgeScanAvailabilityResult = Schema.Struct({
  engineKnowledgeEnabled: Schema.Boolean,
  hasCodebase: Schema.Boolean,
  knowledgePopulated: Schema.Boolean,
  availableScanners: Schema.Array(Schema.String),
  sourceFileCount: Schema.Number,
  lastScanAt: Schema.optional(Schema.String),
  lastScanReportCount: Schema.optional(Schema.Number),
  selectedModel: Schema.optional(ModelSelection),
});
export const KnowledgeQueryInput = Schema.Struct({
  projectId: ProjectId,
  table: KnowledgeTable,
  status: Schema.optional(KnowledgeStatus),
  query: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export const KnowledgeRowsResult = Schema.Struct({
  rows: Schema.Array(UnknownRecord),
  total: Schema.Number,
});
export const KnowledgeRecords = Schema.Array(UnknownRecord);
export const KnowledgeUpsertInput = Schema.Struct({
  projectId: ProjectId,
  table: KnowledgeTable,
  rows: Schema.Array(UnknownRecord),
  confirmed: Schema.optional(Schema.Boolean),
});
export const KnowledgeSetStatusInput = Schema.Struct({
  projectId: ProjectId,
  table: KnowledgeTable,
  ids: Schema.Array(Schema.Union([Schema.Number, Schema.String])),
  status: KnowledgeStatus,
});
export const KnowledgeDeleteRowInput = Schema.Struct({
  projectId: ProjectId,
  table: KnowledgeTable,
  id: Schema.Union([Schema.Number, Schema.String]),
});
export const KnowledgeProjectInput = Schema.Struct({ projectId: ProjectId });
export const KnowledgeProfileResult = Schema.NullOr(UnknownRecord);
export const KnowledgeUpdateProfileInput = Schema.Struct({
  projectId: ProjectId,
  profile: UnknownRecord,
});
export const KnowledgeListArtifactsInput = Schema.Struct({
  projectId: ProjectId,
  caseSlug: Schema.String,
});
export const KnowledgeGetArtifactRpcInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.Int,
});
export const KnowledgeDeleteCaseInput = Schema.Struct({
  projectId: ProjectId,
  caseSlug: Schema.String,
});
