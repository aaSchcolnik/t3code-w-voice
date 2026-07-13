import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { EngineDelegationSkillOverride } from "./settings.ts";

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
});
export type SkillCreateInput = typeof SkillCreateInput.Type;

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
  ]),
  message: Schema.String,
}) {}
