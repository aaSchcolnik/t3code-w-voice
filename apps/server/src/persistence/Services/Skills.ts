import type {
  EngineDelegationSkillOverride,
  SkillCreateInput,
  SkillDetail,
  SkillError,
  SkillId,
  SkillRecord,
  SkillSaveVersionInput,
  SkillSetActiveVersionInput,
  SkillSlug,
  SkillSource,
  SkillSummary,
  SkillUpdateMetaInput,
  SkillVersionCreator,
  SkillVersionMutationResult,
  SkillVersionRecord,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export interface DefaultSkillSeed {
  readonly slug: SkillSlug;
  readonly title: string;
  readonly description: string;
  readonly capability: string | null;
  readonly content: string;
  readonly delegation?: EngineDelegationSkillOverride | undefined;
}

export interface SkillRepositoryCreateInput extends SkillCreateInput {
  readonly source?: SkillSource | undefined;
  readonly capability?: string | null | undefined;
  readonly createdBy?: SkillVersionCreator | undefined;
  readonly importedFrom?: string | null | undefined;
}

export interface SkillsListOptions {
  readonly projectId?: ProjectId | undefined;
}

export interface SkillLookupOptions {
  readonly projectId?: ProjectId | undefined;
}

export interface SkillRepositoryShape {
  readonly list: (
    options?: SkillsListOptions,
  ) => Effect.Effect<ReadonlyArray<SkillSummary>, SkillError>;
  readonly get: (skillId: SkillId) => Effect.Effect<Option.Option<SkillDetail>, SkillError>;
  readonly getBySlug: (
    slug: string,
    options?: SkillLookupOptions,
  ) => Effect.Effect<Option.Option<SkillDetail>, SkillError>;
  readonly getVersions: (
    skillId: SkillId,
  ) => Effect.Effect<ReadonlyArray<SkillVersionRecord>, SkillError>;
  readonly getVersion: (
    skillId: SkillId,
    version: number,
  ) => Effect.Effect<Option.Option<SkillVersionRecord>, SkillError>;
  readonly create: (input: SkillRepositoryCreateInput) => Effect.Effect<SkillDetail, SkillError>;
  readonly addVersion: (
    input: SkillSaveVersionInput,
    createdBy: SkillVersionCreator,
  ) => Effect.Effect<SkillVersionMutationResult, SkillError>;
  readonly setActiveVersion: (
    input: SkillSetActiveVersionInput,
  ) => Effect.Effect<SkillDetail, SkillError>;
  readonly updateMeta: (input: SkillUpdateMetaInput) => Effect.Effect<SkillRecord, SkillError>;
  readonly delete: (skillId: SkillId) => Effect.Effect<void, SkillError>;
  readonly seedDefaults: (
    defaults: ReadonlyArray<DefaultSkillSeed>,
  ) => Effect.Effect<void, SkillError>;
  readonly restoreDefault: (skill: DefaultSkillSeed) => Effect.Effect<SkillDetail, SkillError>;
  readonly restoreDefaults: (
    defaults: ReadonlyArray<DefaultSkillSeed>,
  ) => Effect.Effect<ReadonlyArray<SkillDetail>, SkillError>;
}

export class SkillRepository extends Context.Service<SkillRepository, SkillRepositoryShape>()(
  "t3/persistence/Services/Skills/SkillRepository",
) {}
