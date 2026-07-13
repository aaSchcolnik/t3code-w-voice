import {
  MAX_SKILL_CONTENT_BYTES,
  ProjectId,
  SkillError,
  SkillSlug,
  type ProjectSkillLocation,
  type SkillDetail,
  type SkillImportCandidate,
  type SkillImportItemResult,
  type SkillImportResult,
  type SkillImportScanResult,
  type SkillImportTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectSkillScanner } from "../ProjectSkillScanner.ts";
import { contentHash as repositoryContentHash } from "../../persistence/Layers/Skills.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { SkillRepository } from "../../persistence/Services/Skills.ts";

const SOURCE_PRIORITY = {
  claude: 0,
  agents: 1,
  cursor: 2,
  codex: 3,
} as const;

const skillError = (reason: SkillError["reason"], message: string) =>
  new SkillError({ reason, message });

const normalizeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

const isValidSlug = (value: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

const sortLocations = (
  locations: ReadonlyArray<ProjectSkillLocation>,
): Array<ProjectSkillLocation> =>
  Array.from(locations).sort(
    (left, right) =>
      SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] ||
      left.path.localeCompare(right.path),
  );

const candidatePriority = (candidate: SkillImportCandidate): number =>
  Math.min(...candidate.locations.map((location) => SOURCE_PRIORITY[location.source]));

const exactTargetSkill = (
  detail: Option.Option<SkillDetail>,
  target: SkillImportTarget,
  projectId: ProjectId,
): Option.Option<SkillDetail> => {
  if (Option.isNone(detail)) return detail;
  const expectedProjectId = target === "project" ? projectId : null;
  return detail.value.skill.projectId === expectedProjectId ? detail : Option.none();
};

export interface SkillImportServiceShape {
  readonly scanCandidates: (
    projectId: ProjectId,
    target: SkillImportTarget,
  ) => Effect.Effect<SkillImportScanResult, SkillError>;
  readonly importSelected: (
    projectId: ProjectId,
    target: SkillImportTarget,
    candidateIds: ReadonlyArray<string>,
  ) => Effect.Effect<SkillImportResult, SkillError>;
}

export class SkillImportService extends Context.Service<
  SkillImportService,
  SkillImportServiceShape
>()("t3/knowledge/skills/importService/SkillImportService") {}

export const make = Effect.gen(function* () {
  const scanner = yield* ProjectSkillScanner;
  const projects = yield* ProjectionProjectRepository;
  const skills = yield* SkillRepository;

  const findTargetSkill = Effect.fn("SkillImportService.findTargetSkill")(function* (
    slug: string,
    projectId: ProjectId,
    target: SkillImportTarget,
  ) {
    const found = yield* skills.getBySlug(slug, target === "project" ? { projectId } : undefined);
    return exactTargetSkill(found, target, projectId);
  });

  const scanCandidates: SkillImportServiceShape["scanCandidates"] = Effect.fn(
    "SkillImportService.scanCandidates",
  )(function* (projectId, target) {
    const project = yield* projects
      .getById({ projectId })
      .pipe(
        Effect.mapError((cause) =>
          skillError("scan_failed", `Failed to load project '${projectId}': ${String(cause)}`),
        ),
      );
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* skillError("scan_failed", `Project '${projectId}' was not found.`);
    }

    const scan = yield* scanner.scan(project.value.workspaceRoot);
    if (scan.scannedRoot === null) {
      return yield* skillError(
        "scan_failed",
        `Workspace '${project.value.workspaceRoot}' could not be scanned.`,
      );
    }

    const candidates = yield* Effect.forEach(
      scan.skills,
      Effect.fn("SkillImportService.toCandidate")(function* (scanned) {
        const locations = sortLocations(
          scanned.locations.filter((location) => location.scope === "project"),
        );
        if (locations.length === 0) return Option.none<SkillImportCandidate>();

        const normalizedName = normalizeSlug(scanned.name);
        const fallbackSlug = normalizeSlug(scanned.skillId);
        const slug = isValidSlug(normalizedName) ? normalizedName : fallbackSlug;
        const valid = isValidSlug(slug);
        const existing = valid
          ? yield* findTargetSkill(slug, projectId, target)
          : Option.none<SkillDetail>();
        const dbHash = repositoryContentHash(scanned.content, null);

        return Option.some<SkillImportCandidate>({
          candidateId: scanned.contentHash,
          slug,
          title: scanned.name.trim() || scanned.skillId,
          description: scanned.description.trim() || null,
          contentHash: scanned.contentHash,
          contentBytes: Buffer.byteLength(scanned.content, "utf8"),
          contentPreview: scanned.content.slice(0, 500),
          locations,
          existing: Option.match(existing, {
            onNone: () => null,
            onSome: (detail) => ({
              skillId: detail.skill.skillId,
              state: detail.activeVersion.contentHash === dbHash ? "unchanged" : "differs",
            }),
          }),
          valid,
          ...(valid
            ? {}
            : { invalidReason: "The skill name and directory do not produce a valid slug." }),
        });
      }),
      { concurrency: 8 },
    );

    return {
      scannedRoot: scan.scannedRoot,
      candidates: candidates
        .filter(Option.isSome)
        .map((candidate) => candidate.value)
        .sort(
          (left, right) =>
            candidatePriority(left) - candidatePriority(right) ||
            left.slug.localeCompare(right.slug) ||
            left.candidateId.localeCompare(right.candidateId),
        ),
    };
  });

  const importSelected: SkillImportServiceShape["importSelected"] = Effect.fn(
    "SkillImportService.importSelected",
  )(function* (projectId, target, candidateIds) {
    const scan = yield* scanCandidates(projectId, target);
    const byId = new Map(scan.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const selectedIds = new Set(candidateIds);
    const selected = scan.candidates.filter((candidate) => selectedIds.has(candidate.candidateId));
    const sourceScan = yield* scanner.scan(scan.scannedRoot);
    const sourceSkills = new Map(
      sourceScan.skills
        .filter((skill) => skill.locations.some((location) => location.scope === "project"))
        .map((skill) => [skill.contentHash, skill]),
    );

    const importOne = Effect.fn("SkillImportService.importOne")(function* (
      candidate: SkillImportCandidate,
    ): Effect.fn.Return<SkillImportItemResult, SkillError> {
      if (!candidate.valid) {
        return {
          candidateId: candidate.candidateId,
          slug: candidate.slug,
          outcome: "error",
          message: candidate.invalidReason ?? "Invalid skill candidate.",
        };
      }
      if (candidate.contentBytes > MAX_SKILL_CONTENT_BYTES) {
        return {
          candidateId: candidate.candidateId,
          slug: candidate.slug,
          outcome: "error",
          message: `Skill content exceeds the ${MAX_SKILL_CONTENT_BYTES / 1024} KiB limit.`,
        };
      }

      const location = candidate.locations[0];
      if (location === undefined) {
        return {
          candidateId: candidate.candidateId,
          slug: candidate.slug,
          outcome: "error",
          message: "No project-scoped source location is available.",
        };
      }
      const scanned = scan.candidates.find((entry) => entry.candidateId === candidate.candidateId);
      if (scanned === undefined) {
        return {
          candidateId: candidate.candidateId,
          slug: candidate.slug,
          outcome: "missing",
        };
      }

      const sourceSkill = sourceSkills.get(candidate.candidateId);
      if (sourceSkill === undefined) {
        return {
          candidateId: candidate.candidateId,
          slug: candidate.slug,
          outcome: "missing",
        };
      }
      const changeNote = `Imported from ${location.path}`;
      const existing = yield* findTargetSkill(candidate.slug, projectId, target);
      if (Option.isSome(existing)) {
        const saved = yield* skills.addVersion(
          {
            skillId: existing.value.skill.skillId,
            content: sourceSkill.content,
            delegation: null,
            changeNote,
          },
          "user",
        );
        return {
          candidateId: candidate.candidateId,
          slug: candidate.slug,
          outcome: saved.created ? "new_version" : "unchanged",
          skillId: existing.value.skill.skillId,
          version: saved.version.version,
        };
      }

      const create = skills.create({
        slug: SkillSlug.make(candidate.slug),
        title: candidate.title,
        description: candidate.description ?? "",
        content: sourceSkill.content,
        delegation: undefined,
        changeNote,
        projectId: target === "project" ? projectId : undefined,
        importedFrom: location.path,
        source: "user",
        createdBy: "user",
      });
      const created = yield* create.pipe(
        Effect.map((detail) => ({
          detail,
          version: detail.activeVersion.version,
          created: true as const,
          versionCreated: false,
        })),
        Effect.catchIf(
          (error) => error.reason === "already_exists",
          () =>
            Effect.gen(function* () {
              const raced = yield* findTargetSkill(candidate.slug, projectId, target);
              if (Option.isNone(raced)) {
                return yield* skillError(
                  "already_exists",
                  `Skill '${candidate.slug}' was created concurrently but could not be reloaded.`,
                );
              }
              const saved = yield* skills.addVersion(
                {
                  skillId: raced.value.skill.skillId,
                  content: sourceSkill.content,
                  delegation: null,
                  changeNote,
                },
                "user",
              );
              return {
                detail: raced.value,
                version: saved.version.version,
                created: false as const,
                versionCreated: saved.created,
              };
            }),
        ),
      );
      return {
        candidateId: candidate.candidateId,
        slug: candidate.slug,
        outcome: created.created
          ? "created"
          : created.versionCreated === true
            ? "new_version"
            : "unchanged",
        skillId: created.detail.skill.skillId,
        version: created.version,
      };
    });

    const imported = yield* Effect.forEach(selected, (candidate) =>
      importOne(candidate).pipe(
        Effect.match({
          onFailure: (cause): SkillImportItemResult => ({
            candidateId: candidate.candidateId,
            slug: candidate.slug,
            outcome: "error",
            message: cause.message,
          }),
          onSuccess: (result) => result,
        }),
      ),
    );
    const missing = candidateIds
      .filter((candidateId) => !byId.has(candidateId))
      .map(
        (candidateId): SkillImportItemResult => ({
          candidateId,
          slug: "",
          outcome: "missing",
        }),
      );
    return { items: [...imported, ...missing] };
  });

  return SkillImportService.of({ scanCandidates, importSelected });
});

export const layer = Layer.effect(SkillImportService, make);
