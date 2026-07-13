import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { EngineDelegationSkillOverride } from "./settings.ts";
import { ProjectSkillLocation } from "./knowledge.ts";

export const MAX_SKILL_CONTENT_BYTES = 256 * 1024;

export const SkillId = TrimmedNonEmptyString.pipe(Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

export const SkillSlug = TrimmedNonEmptyString.check(
  Schema.makeFilter((slug) =>
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      ? undefined
      : "Use lowercase letters, numbers, and single hyphens.",
  ),
);
export type SkillSlug = typeof SkillSlug.Type;

export const SkillSource = Schema.Literals(["builtin", "user", "agent"]);
export type SkillSource = typeof SkillSource.Type;

export const SkillVersionCreator = Schema.Literals(["seed", "user", "agent"]);
export type SkillVersionCreator = typeof SkillVersionCreator.Type;

export const SkillRecord = Schema.Struct({
  skillId: SkillId,
  slug: SkillSlug,
  title: TrimmedNonEmptyString,
  description: TrimmedString,
  source: SkillSource,
  capability: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  importedFrom: Schema.NullOr(Schema.String),
  activeVersion: PositiveInt,
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SkillRecord = typeof SkillRecord.Type;

export const SkillVersionRecord = Schema.Struct({
  skillId: SkillId,
  version: PositiveInt,
  content: Schema.String,
  delegation: Schema.NullOr(EngineDelegationSkillOverride),
  contentHash: Schema.String,
  changeNote: Schema.NullOr(Schema.String),
  createdBy: SkillVersionCreator,
  createdAt: IsoDateTime,
});
export type SkillVersionRecord = typeof SkillVersionRecord.Type;

export const SkillSummary = SkillRecord;
export type SkillSummary = typeof SkillSummary.Type;

export const SkillDetail = Schema.Struct({
  skill: SkillRecord,
  activeVersion: SkillVersionRecord,
  versions: Schema.Array(SkillVersionRecord),
});
export type SkillDetail = typeof SkillDetail.Type;

export const SkillVersionMutationResult = Schema.Struct({
  version: SkillVersionRecord,
  created: Schema.Boolean,
});
export type SkillVersionMutationResult = typeof SkillVersionMutationResult.Type;

export const SkillCreateInput = Schema.Struct({
  slug: SkillSlug,
  title: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedString),
  content: Schema.String,
  delegation: Schema.optional(EngineDelegationSkillOverride),
  changeNote: Schema.optional(TrimmedString),
  projectId: Schema.optional(ProjectId),
});
export type SkillCreateInput = typeof SkillCreateInput.Type;

export const SkillsListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type SkillsListInput = typeof SkillsListInput.Type;

export const SkillImportTarget = Schema.Literals(["global", "project"]);
export type SkillImportTarget = typeof SkillImportTarget.Type;

export const SkillImportExisting = Schema.Struct({
  skillId: SkillId,
  state: Schema.Literals(["unchanged", "differs"]),
});
export type SkillImportExisting = typeof SkillImportExisting.Type;

export const SkillImportCandidate = Schema.Struct({
  candidateId: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  contentHash: Schema.String,
  contentBytes: Schema.Number,
  contentPreview: Schema.String,
  locations: Schema.Array(ProjectSkillLocation),
  existing: Schema.NullOr(SkillImportExisting),
  valid: Schema.Boolean,
  invalidReason: Schema.optional(Schema.String),
});
export type SkillImportCandidate = typeof SkillImportCandidate.Type;

export const SkillImportScanInput = Schema.Struct({
  projectId: ProjectId,
  target: SkillImportTarget,
});
export type SkillImportScanInput = typeof SkillImportScanInput.Type;

export const SkillImportScanResult = Schema.Struct({
  scannedRoot: Schema.String,
  candidates: Schema.Array(SkillImportCandidate),
});
export type SkillImportScanResult = typeof SkillImportScanResult.Type;

export const SkillImportInput = Schema.Struct({
  projectId: ProjectId,
  target: SkillImportTarget,
  candidateIds: Schema.Array(Schema.String),
});
export type SkillImportInput = typeof SkillImportInput.Type;

export const SkillImportItemResult = Schema.Struct({
  candidateId: Schema.String,
  slug: Schema.String,
  outcome: Schema.Literals(["created", "new_version", "unchanged", "missing", "error"]),
  skillId: Schema.optional(SkillId),
  version: Schema.optional(PositiveInt),
  message: Schema.optional(Schema.String),
});
export type SkillImportItemResult = typeof SkillImportItemResult.Type;

export const SkillImportResult = Schema.Struct({
  items: Schema.Array(SkillImportItemResult),
});
export type SkillImportResult = typeof SkillImportResult.Type;

export const SkillSaveVersionInput = Schema.Struct({
  skillId: SkillId,
  content: Schema.String,
  delegation: Schema.optional(Schema.NullOr(EngineDelegationSkillOverride)),
  changeNote: Schema.optional(TrimmedString),
});
export type SkillSaveVersionInput = typeof SkillSaveVersionInput.Type;

export const SkillSetActiveVersionInput = Schema.Struct({
  skillId: SkillId,
  version: PositiveInt,
});
export type SkillSetActiveVersionInput = typeof SkillSetActiveVersionInput.Type;

export const SkillUpdateMetaInput = Schema.Struct({
  skillId: SkillId,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedString),
  enabled: Schema.optional(Schema.Boolean),
});
export type SkillUpdateMetaInput = typeof SkillUpdateMetaInput.Type;

export const SkillDeleteInput = Schema.Struct({ skillId: SkillId });
export type SkillDeleteInput = typeof SkillDeleteInput.Type;

export const SkillGetInput = Schema.Struct({ skillId: SkillId });
export type SkillGetInput = typeof SkillGetInput.Type;

export class SkillError extends Schema.TaggedErrorClass<SkillError>()("SkillError", {
  reason: Schema.Literals([
    "not_found",
    "already_exists",
    "invalid_version",
    "content_too_large",
    "no_changes",
    "persistence",
    "scan_failed",
  ]),
  message: Schema.String,
}) {}
