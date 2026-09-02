import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ProjectDelegationTarget = Schema.Struct({
  provider: Schema.Literals(["codex", "cursor", "claudeAgent", "antigravity", "inline"]),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
  focus: Schema.optional(TrimmedNonEmptyString),
});

const ProjectEngineDelegationSkillOverride = Schema.Struct({
  scout: Schema.optional(Schema.Array(ProjectDelegationTarget)),
  worker: Schema.optional(Schema.Array(ProjectDelegationTarget)),
  consensus: Schema.optional(Schema.Array(ProjectDelegationTarget)),
  scanner: Schema.optional(Schema.Array(ProjectDelegationTarget)),
});

export const ProjectEngineDelegationSkillOverrides = Schema.Record(
  Schema.String,
  ProjectEngineDelegationSkillOverride,
);

export const ProjectEngineDelegationOverrides = Schema.Struct({
  roles: Schema.optional(
    Schema.Struct({
      scout: Schema.optional(Schema.Array(ProjectDelegationTarget)),
      worker: Schema.optional(Schema.Array(ProjectDelegationTarget)),
      consensus: Schema.optional(Schema.Array(ProjectDelegationTarget)),
      scanner: Schema.optional(Schema.Array(ProjectDelegationTarget)),
    }),
  ),
  skillOverrides: Schema.optional(ProjectEngineDelegationSkillOverrides),
});
export type ProjectEngineDelegationOverrides = typeof ProjectEngineDelegationOverrides.Type;

/** Per-project skill enablement keyed by skillId. Absent keys inherit the skill's global `enabled` flag. */
export const ProjectSkillOverrides = Schema.Record(Schema.String, Schema.Boolean);
export type ProjectSkillOverrides = typeof ProjectSkillOverrides.Type;

export const ProjectMcpOverrides = Schema.Struct({
  preview: Schema.optional(Schema.Boolean),
  codexAgent: Schema.optional(Schema.Boolean),
  cursorAgent: Schema.optional(Schema.Boolean),
  claudeAgent: Schema.optional(Schema.Boolean),
  antigravityAgent: Schema.optional(Schema.Boolean),
  skills: Schema.optional(ProjectSkillOverrides),
  engine: Schema.optional(
    Schema.Struct({
      planning: Schema.optional(Schema.Boolean),
      consensus: Schema.optional(Schema.Boolean),
      enrich: Schema.optional(Schema.Boolean),
      implement: Schema.optional(Schema.Boolean),
      quality: Schema.optional(Schema.Boolean),
      performance: Schema.optional(Schema.Boolean),
      typescript: Schema.optional(Schema.Boolean),
      delegation: Schema.optional(ProjectEngineDelegationOverrides),
    }),
  ),
});
export type ProjectMcpOverrides = typeof ProjectMcpOverrides.Type;
