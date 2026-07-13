import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import type {
  KnowledgeSkillsResult,
  ProjectSkill,
  ProjectSkillLocation,
  ProjectSkillSource,
} from "@t3tools/contracts";

const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILLS_PER_SOURCE = 100;
const SCAN_TIMEOUT = "2 seconds";

const emptyResult = (): KnowledgeSkillsResult => ({
  skills: [],
  agentFiles: {
    claudeMd: false,
    agentsMd: false,
  },
  scannedRoot: null,
});

const readFrontmatterValue = (frontmatter: string, field: "name" | "description") => {
  const match = frontmatter.match(new RegExp(`^\\s*${field}\\s*:\\s*(.*?)\\s*$`, "mi"));
  const value = match?.[1]?.trim();
  if (!value) return null;

  const firstCharacter = value.at(0);
  if ((firstCharacter === '"' || firstCharacter === "'") && value.at(-1) === firstCharacter) {
    return value.slice(1, -1).trim();
  }
  return value;
};

const parseSkillMetadata = (contents: string, fallbackName: string) => {
  const frontmatter = contents
    .replace(/^\uFEFF/, "")
    .match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/)?.[1];
  if (!frontmatter) {
    return { name: fallbackName, description: "" };
  }
  return {
    name: readFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: readFrontmatterValue(frontmatter, "description") ?? "",
  };
};

type ScannedProjectSkill = Omit<ProjectSkill, "locations"> & {
  readonly location: ProjectSkillLocation;
};

const mergeSkills = (skills: ReadonlyArray<ScannedProjectSkill>): Array<ProjectSkill> => {
  const skillsById = new Map<string, ProjectSkill>();

  for (const { skillId, location, ...skill } of skills) {
    const existing = skillsById.get(skillId);
    if (existing === undefined) {
      skillsById.set(skillId, { skillId, ...skill, locations: [location] });
      continue;
    }
    skillsById.set(skillId, { ...existing, locations: [...existing.locations, location] });
  }

  return Array.from(skillsById.values());
};

export class ProjectSkillScanner extends Context.Service<
  ProjectSkillScanner,
  {
    readonly scan: (
      workspaceRoot: string,
      userHomeOverride?: string,
    ) => Effect.Effect<KnowledgeSkillsResult>;
  }
>()("t3/knowledge/ProjectSkillScanner") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const isFile = Effect.fn("ProjectSkillScanner.isFile")(function* (filePath: string) {
    const stats = yield* fileSystem.stat(filePath).pipe(Effect.option);
    return Option.isSome(stats) && stats.value.type === "File";
  });

  const isDirectory = Effect.fn("ProjectSkillScanner.isDirectory")(function* (
    directoryPath: string,
  ) {
    const stats = yield* fileSystem.stat(directoryPath).pipe(Effect.option);
    return Option.isSome(stats) && stats.value.type === "Directory";
  });

  const readSkillFile = Effect.fn("ProjectSkillScanner.readSkillFile")(function* (
    filePath: string,
  ) {
    const stats = yield* fileSystem.stat(filePath).pipe(Effect.option);
    if (
      Option.isNone(stats) ||
      stats.value.type !== "File" ||
      stats.value.size > MAX_SKILL_FILE_BYTES
    ) {
      return Option.none<string>();
    }
    return yield* fileSystem.readFileString(filePath).pipe(Effect.option);
  });

  const scanSource = Effect.fn("ProjectSkillScanner.scanSource")(function* (
    root: string,
    source: ProjectSkillSource,
    scope: ProjectSkillLocation["scope"],
  ) {
    const sourceDirectory = path.join(root, `.${source}`, "skills");
    const entries = yield* fileSystem
      .readDirectory(sourceDirectory, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const skills: Array<ScannedProjectSkill> = [];

    for (const entry of Array.from(entries).sort().slice(0, MAX_SKILLS_PER_SOURCE)) {
      const skillDirectory = path.join(sourceDirectory, entry);
      if (!(yield* isDirectory(skillDirectory))) {
        continue;
      }
      const skillPath = path.join(skillDirectory, "SKILL.md");
      const contents = yield* readSkillFile(skillPath);
      if (Option.isNone(contents)) {
        continue;
      }
      const metadata = parseSkillMetadata(contents.value, entry);
      skills.push({
        ...metadata,
        skillId: entry,
        location: {
          path:
            scope === "user"
              ? path.join("~", `.${source}`, "skills", entry, "SKILL.md")
              : path.join(`.${source}`, "skills", entry, "SKILL.md"),
          source,
          scope,
        },
      });
    }

    return skills;
  });

  const scan: ProjectSkillScanner["Service"]["scan"] = Effect.fn("ProjectSkillScanner.scan")(
    function* (workspaceRoot, userHomeOverride) {
      const scanWorkspace = Effect.gen(function* () {
        const normalizedRoot = path.resolve(workspaceRoot);
        if (!(yield* isDirectory(normalizedRoot))) {
          return emptyResult();
        }

        const userHome = path.resolve(userHomeOverride ?? NodeOS.homedir());
        const [claudeMd, agentsMd, ...skillGroups] = yield* Effect.all([
          isFile(path.join(normalizedRoot, "CLAUDE.md")),
          isFile(path.join(normalizedRoot, "AGENTS.md")),
          scanSource(normalizedRoot, "claude", "project"),
          scanSource(normalizedRoot, "agents", "project"),
          scanSource(normalizedRoot, "cursor", "project"),
          scanSource(normalizedRoot, "codex", "project"),
          scanSource(userHome, "claude", "user"),
          scanSource(userHome, "agents", "user"),
          scanSource(userHome, "cursor", "user"),
          scanSource(userHome, "codex", "user"),
        ]);
        return {
          skills: mergeSkills(skillGroups.flat()),
          agentFiles: { claudeMd, agentsMd },
          scannedRoot: normalizedRoot,
        };
      });

      return yield* scanWorkspace.pipe(
        Effect.timeoutOption(SCAN_TIMEOUT),
        Effect.map(Option.getOrElse(emptyResult)),
      );
    },
  );

  return ProjectSkillScanner.of({ scan });
});

export const layer = Layer.effect(ProjectSkillScanner, make);
