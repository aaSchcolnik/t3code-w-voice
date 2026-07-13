import * as NodeCrypto from "node:crypto";

import {
  EngineDelegationSkillOverride,
  MAX_SKILL_CONTENT_BYTES,
  SkillError,
  SkillId,
  PositiveInt,
  SkillRecord,
  SkillSlug,
  TrimmedNonEmptyString,
  TrimmedString,
  type SkillDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  SkillRepository,
  type DefaultSkillSeed,
  type SkillRepositoryCreateInput,
  type SkillRepositoryShape,
} from "../Services/Skills.ts";

const SkillDbRow = Schema.Struct({
  skillId: SkillId,
  slug: SkillSlug,
  title: TrimmedNonEmptyString,
  description: TrimmedString,
  source: Schema.Literals(["builtin", "user", "agent"]),
  capability: Schema.NullOr(Schema.String),
  activeVersion: PositiveInt,
  enabled: Schema.BooleanFromBit,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const SkillVersionDbRow = Schema.Struct({
  skillId: SkillId,
  version: Schema.Int,
  content: Schema.String,
  delegation: Schema.NullOr(Schema.fromJsonString(EngineDelegationSkillOverride)),
  contentHash: Schema.String,
  changeNote: Schema.NullOr(Schema.String),
  createdBy: Schema.Literals(["seed", "user", "agent"]),
  createdAt: Schema.String,
});

const skillError = (reason: SkillError["reason"], message: string) =>
  new SkillError({ reason, message });
const isSkillError = Schema.is(SkillError);
const encodeDelegation = Schema.encodeSync(Schema.fromJsonString(EngineDelegationSkillOverride));

const mapPersistenceError = (operation: string) => (cause: unknown) =>
  skillError("persistence", `${operation} failed: ${String(cause)}`);

const contentHash = (content: string, delegation: EngineDelegationSkillOverride | null): string =>
  NodeCrypto.createHash("sha256")
    .update(content)
    .update("\0")
    .update(delegation === null ? "null" : encodeDelegation(delegation))
    .digest("hex");

const ensureContentSize = (content: string) =>
  Buffer.byteLength(content, "utf8") <= MAX_SKILL_CONTENT_BYTES
    ? Effect.void
    : Effect.fail(
        skillError(
          "content_too_large",
          `Skill content exceeds the ${MAX_SKILL_CONTENT_BYTES / 1024} KiB limit.`,
        ),
      );

const currentTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const makeSkillRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SkillDbRow,
    execute: () => sql`
      SELECT skill_id AS "skillId", slug, title, description, source, capability,
        active_version AS "activeVersion", enabled, created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM skills
      ORDER BY CASE source WHEN 'builtin' THEN 0 ELSE 1 END, created_at, slug
    `,
  });
  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ skillId: SkillId }),
    Result: SkillDbRow,
    execute: ({ skillId }) => sql`
      SELECT skill_id AS "skillId", slug, title, description, source, capability,
        active_version AS "activeVersion", enabled, created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM skills WHERE skill_id = ${skillId}
    `,
  });
  const getRowBySlug = SqlSchema.findOneOption({
    Request: Schema.Struct({ slug: Schema.String }),
    Result: SkillDbRow,
    execute: ({ slug }) => sql`
      SELECT skill_id AS "skillId", slug, title, description, source, capability,
        active_version AS "activeVersion", enabled, created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM skills WHERE slug = ${slug}
    `,
  });
  const listVersionRows = SqlSchema.findAll({
    Request: Schema.Struct({ skillId: SkillId }),
    Result: SkillVersionDbRow,
    execute: ({ skillId }) => sql`
      SELECT skill_id AS "skillId", version, content, delegation_json AS delegation,
        content_hash AS "contentHash", change_note AS "changeNote",
        created_by AS "createdBy", created_at AS "createdAt"
      FROM skill_versions WHERE skill_id = ${skillId} ORDER BY version DESC
    `,
  });
  const getVersionRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ skillId: SkillId, version: Schema.Int }),
    Result: SkillVersionDbRow,
    execute: ({ skillId, version }) => sql`
      SELECT skill_id AS "skillId", version, content, delegation_json AS delegation,
        content_hash AS "contentHash", change_note AS "changeNote",
        created_by AS "createdBy", created_at AS "createdAt"
      FROM skill_versions WHERE skill_id = ${skillId} AND version = ${version}
    `,
  });

  const list: SkillRepositoryShape["list"] = () =>
    listRows().pipe(Effect.mapError(mapPersistenceError("SkillRepository.list")));

  const getVersions: SkillRepositoryShape["getVersions"] = (skillId) =>
    listVersionRows({ skillId }).pipe(
      Effect.mapError(mapPersistenceError("SkillRepository.getVersions")),
    );

  const getVersion: SkillRepositoryShape["getVersion"] = (skillId, version) =>
    getVersionRow({ skillId, version }).pipe(
      Effect.mapError(mapPersistenceError("SkillRepository.getVersion")),
    );

  const hydrateDetail = Effect.fn("SkillRepository.hydrateDetail")(function* (skill: SkillRecord) {
    const versions = yield* getVersions(skill.skillId);
    const activeVersion = versions.find((version) => version.version === skill.activeVersion);
    if (activeVersion === undefined) {
      return yield* skillError(
        "invalid_version",
        `Active version v${skill.activeVersion} is missing for skill '${skill.slug}'.`,
      );
    }
    return { skill, activeVersion, versions } satisfies SkillDetail;
  });

  const get: SkillRepositoryShape["get"] = (skillId) =>
    getRow({ skillId }).pipe(
      Effect.mapError(mapPersistenceError("SkillRepository.get")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => hydrateDetail(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const getBySlug: SkillRepositoryShape["getBySlug"] = (slug) =>
    getRowBySlug({ slug }).pipe(
      Effect.mapError(mapPersistenceError("SkillRepository.getBySlug")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => hydrateDetail(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const insertSkill = Effect.fn("SkillRepository.insertSkill")(function* (
    input: SkillRepositoryCreateInput,
    options?: { readonly clearTombstone?: boolean },
  ) {
    yield* ensureContentSize(input.content);
    const skillId = SkillId.make(NodeCrypto.randomUUID());
    const timestamp = yield* currentTimestamp;
    const delegation = input.delegation ?? null;
    const source = input.source ?? "user";
    const createdBy = input.createdBy ?? (source === "agent" ? "agent" : "user");
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (options?.clearTombstone === true) {
          yield* sql`DELETE FROM skills_tombstones WHERE slug = ${input.slug}`;
        }
        yield* sql`
          INSERT INTO skills (
            skill_id, slug, title, description, source, capability, active_version,
            enabled, created_at, updated_at
          ) VALUES (
            ${skillId}, ${input.slug}, ${input.title}, ${input.description ?? ""}, ${source},
            ${input.capability ?? null}, 1, 1, ${timestamp}, ${timestamp}
          )
        `;
        yield* sql`
          INSERT INTO skill_versions (
            skill_id, version, content, delegation_json, content_hash, change_note,
            created_by, created_at
          ) VALUES (
            ${skillId}, 1, ${input.content}, ${delegation === null ? null : encodeDelegation(delegation)},
            ${contentHash(input.content, delegation)}, ${input.changeNote ?? null},
            ${createdBy}, ${timestamp}
          )
        `;
      }),
    );
    const created = yield* get(skillId);
    return yield* Option.match(created, {
      onNone: () => skillError("persistence", "Created skill could not be reloaded."),
      onSome: Effect.succeed,
    });
  });

  const create: SkillRepositoryShape["create"] = (input) =>
    insertSkill(input).pipe(
      Effect.catch((cause) => {
        if (isSkillError(cause)) return Effect.fail(cause);
        const detail = String(cause);
        return Effect.fail(
          detail.includes("UNIQUE")
            ? skillError("already_exists", `A skill with slug '${input.slug}' already exists.`)
            : mapPersistenceError("SkillRepository.create")(cause),
        );
      }),
    );

  const addVersion: SkillRepositoryShape["addVersion"] = (input, createdBy) =>
    Effect.gen(function* () {
      yield* ensureContentSize(input.content);
      const current = yield* get(input.skillId);
      const detail = yield* Option.match(current, {
        onNone: () => skillError("not_found", "Skill not found."),
        onSome: Effect.succeed,
      });
      const delegation =
        input.delegation === undefined ? detail.activeVersion.delegation : input.delegation;
      const hash = contentHash(input.content, delegation);
      if (hash === detail.activeVersion.contentHash) {
        return { version: detail.activeVersion, created: false };
      }
      const timestamp = yield* currentTimestamp;
      const nextVersion = yield* sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly version: number }>`
            INSERT INTO skill_versions (
              skill_id, version, content, delegation_json, content_hash, change_note,
              created_by, created_at
            ) SELECT
              ${input.skillId}, COALESCE(MAX(version), 0) + 1, ${input.content},
              ${delegation === null ? null : encodeDelegation(delegation)}, ${hash},
              ${input.changeNote ?? null}, ${createdBy}, ${timestamp}
            FROM skill_versions
            WHERE skill_id = ${input.skillId}
            RETURNING version
          `;
          const insertedVersion = inserted[0]?.version;
          if (insertedVersion === undefined) {
            return yield* skillError("persistence", "Skill version insert returned no version.");
          }
          yield* sql`
            UPDATE skills SET active_version = ${insertedVersion}, updated_at = ${timestamp}
            WHERE skill_id = ${input.skillId}
          `;
          return insertedVersion;
        }),
      );
      const version = yield* getVersion(input.skillId, nextVersion);
      return yield* Option.match(version, {
        onNone: () => skillError("persistence", "Created skill version could not be reloaded."),
        onSome: (record) => Effect.succeed({ version: record, created: true }),
      });
    }).pipe(
      Effect.catch((cause) =>
        isSkillError(cause)
          ? Effect.fail(cause)
          : Effect.fail(mapPersistenceError("SkillRepository.addVersion")(cause)),
      ),
    );

  const setActiveVersion: SkillRepositoryShape["setActiveVersion"] = (input) =>
    Effect.gen(function* () {
      const version = yield* getVersion(input.skillId, input.version);
      if (Option.isNone(version)) {
        return yield* skillError(
          "invalid_version",
          `Skill version v${input.version} does not exist.`,
        );
      }
      const timestamp = yield* currentTimestamp;
      yield* sql`UPDATE skills SET active_version = ${input.version}, updated_at = ${timestamp} WHERE skill_id = ${input.skillId}`;
      const updated = yield* get(input.skillId);
      return yield* Option.match(updated, {
        onNone: () => skillError("not_found", "Skill not found."),
        onSome: Effect.succeed,
      });
    }).pipe(
      Effect.catch((cause) =>
        isSkillError(cause)
          ? Effect.fail(cause)
          : Effect.fail(mapPersistenceError("SkillRepository.setActiveVersion")(cause)),
      ),
    );

  const updateMeta: SkillRepositoryShape["updateMeta"] = (input) =>
    Effect.gen(function* () {
      const current = yield* get(input.skillId);
      const detail = yield* Option.match(current, {
        onNone: () => skillError("not_found", "Skill not found."),
        onSome: Effect.succeed,
      });
      const updated = {
        title: input.title ?? detail.skill.title,
        description: input.description ?? detail.skill.description,
        enabled: input.enabled ?? detail.skill.enabled,
      };
      const timestamp = yield* currentTimestamp;
      yield* sql`
        UPDATE skills SET title = ${updated.title}, description = ${updated.description},
          enabled = ${updated.enabled ? 1 : 0}, updated_at = ${timestamp}
        WHERE skill_id = ${input.skillId}
      `;
      const reloaded = yield* getRow({ skillId: input.skillId });
      return yield* Option.match(reloaded, {
        onNone: () => skillError("not_found", "Skill not found."),
        onSome: Effect.succeed,
      });
    }).pipe(
      Effect.catch((cause) =>
        isSkillError(cause)
          ? Effect.fail(cause)
          : Effect.fail(mapPersistenceError("SkillRepository.updateMeta")(cause)),
      ),
    );

  const deleteSkill: SkillRepositoryShape["delete"] = (skillId) =>
    Effect.gen(function* () {
      const current = yield* get(skillId);
      const detail = yield* Option.match(current, {
        onNone: () => skillError("not_found", "Skill not found."),
        onSome: Effect.succeed,
      });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (detail.skill.source === "builtin") {
            yield* sql`INSERT OR IGNORE INTO skills_tombstones (slug) VALUES (${detail.skill.slug})`;
          }
          yield* sql`DELETE FROM skills WHERE skill_id = ${skillId}`;
        }),
      );
    }).pipe(
      Effect.catch((cause) =>
        isSkillError(cause)
          ? Effect.fail(cause)
          : Effect.fail(mapPersistenceError("SkillRepository.delete")(cause)),
      ),
    );

  const seedOne = (seed: DefaultSkillSeed, clearTombstone: boolean) =>
    insertSkill(
      {
        slug: seed.slug,
        title: seed.title,
        description: seed.description,
        content: seed.content,
        ...(seed.delegation === undefined ? {} : { delegation: seed.delegation }),
        source: "builtin",
        capability: seed.capability,
        createdBy: "seed",
      },
      { clearTombstone },
    );

  const seedDefaults: SkillRepositoryShape["seedDefaults"] = (defaults) =>
    Effect.forEach(
      defaults,
      (seed) =>
        Effect.gen(function* () {
          const existing = yield* getBySlug(seed.slug);
          if (Option.isSome(existing)) return;
          const tombstones = yield* sql<{
            readonly slug: string;
          }>`SELECT slug FROM skills_tombstones WHERE slug = ${seed.slug}`;
          if (tombstones.length > 0) return;
          yield* seedOne(seed, false);
        }),
      { discard: true },
    ).pipe(
      Effect.catch((cause) =>
        isSkillError(cause)
          ? Effect.fail(cause)
          : Effect.fail(mapPersistenceError("SkillRepository.seedDefaults")(cause)),
      ),
    );

  const restoreDefault: SkillRepositoryShape["restoreDefault"] = (seed) =>
    Effect.gen(function* () {
      const existing = yield* getBySlug(seed.slug);
      if (Option.isSome(existing)) return existing.value;
      return yield* seedOne(seed, true);
    }).pipe(
      Effect.catch((cause) =>
        isSkillError(cause)
          ? Effect.fail(cause)
          : Effect.fail(mapPersistenceError("SkillRepository.restoreDefault")(cause)),
      ),
    );

  const restoreDefaults: SkillRepositoryShape["restoreDefaults"] = (defaults) =>
    Effect.forEach(defaults, restoreDefault);

  return {
    list,
    get,
    getBySlug,
    getVersions,
    getVersion,
    create,
    addVersion,
    setActiveVersion,
    updateMeta,
    delete: deleteSkill,
    seedDefaults,
    restoreDefault,
    restoreDefaults,
  } satisfies SkillRepositoryShape;
});

export const SkillRepositoryLive = Layer.effect(SkillRepository, makeSkillRepository);
