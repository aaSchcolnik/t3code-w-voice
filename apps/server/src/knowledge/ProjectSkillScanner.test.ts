import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectSkillScanner from "./ProjectSkillScanner.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectSkillScanner.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-project-skills-" });
});

const makeScanRoots = Effect.gen(function* () {
  const root = yield* makeTempDir;
  const userHome = yield* makeTempDir;
  return { root, userHome };
});

const writeTextFile = Effect.fn("ProjectSkillScannerTest.writeTextFile")(function* (
  root: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(root, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(TestLayer)("ProjectSkillScanner", (it) => {
  describe("scan", () => {
    it.effect("finds Claude and Agent Skills with their frontmatter", () =>
      Effect.gen(function* () {
        const scanner = yield* ProjectSkillScanner.ProjectSkillScanner;
        const { root, userHome } = yield* makeScanRoots;
        yield* writeTextFile(root, "CLAUDE.md", "Project instructions");
        yield* writeTextFile(root, "AGENTS.md", "Agent instructions");
        yield* writeTextFile(
          root,
          ".claude/skills/release/SKILL.md",
          '---\nname: "Release automation"\ndescription: Deploy safely.\n---\n# Release',
        );
        yield* writeTextFile(
          root,
          ".agents/skills/code-review/SKILL.md",
          "---\ndescription: Review a change.\n---\n# Code review",
        );

        const result = yield* scanner.scan(root, userHome);

        expect(result).toMatchObject({
          agentFiles: { claudeMd: true, agentsMd: true },
          scannedRoot: root,
          skills: [
            {
              skillId: "release",
              name: "Release automation",
              description: "Deploy safely.",
              content: expect.stringContaining("# Release"),
              contentHash: expect.any(String),
              locations: [
                {
                  source: "claude",
                  scope: "project",
                  path: ".claude/skills/release/SKILL.md",
                },
              ],
            },
            {
              skillId: "code-review",
              name: "code-review",
              description: "Review a change.",
              content: expect.stringContaining("# Code review"),
              contentHash: expect.any(String),
              locations: [
                {
                  source: "agents",
                  scope: "project",
                  path: ".agents/skills/code-review/SKILL.md",
                },
              ],
            },
          ],
        });
      }),
    );

    it.effect("uses the directory name when a skill has no frontmatter name", () =>
      Effect.gen(function* () {
        const scanner = yield* ProjectSkillScanner.ProjectSkillScanner;
        const { root, userHome } = yield* makeScanRoots;
        yield* writeTextFile(root, ".claude/skills/no-frontmatter/SKILL.md", "# Skill");

        const result = yield* scanner.scan(root, userHome);

        expect(result.skills).toEqual([
          expect.objectContaining({
            skillId: "no-frontmatter",
            name: "no-frontmatter",
            description: "",
            locations: [
              {
                source: "claude",
                scope: "project",
                path: ".claude/skills/no-frontmatter/SKILL.md",
              },
            ],
          }),
        ]);
      }),
    );

    it.effect("merges a skill that is available from both source directories", () =>
      Effect.gen(function* () {
        const scanner = yield* ProjectSkillScanner.ProjectSkillScanner;
        const { root, userHome } = yield* makeScanRoots;
        const skill = "---\nname: Shared skill\ndescription: Used by either agent.\n---\n# Shared";
        yield* writeTextFile(root, ".claude/skills/shared/SKILL.md", skill);
        yield* writeTextFile(userHome, ".agents/skills/shared/SKILL.md", skill);
        yield* writeTextFile(userHome, ".cursor/skills/cursor-only/SKILL.md", "# Cursor skill");
        yield* writeTextFile(userHome, ".codex/skills/codex-only/SKILL.md", "# Codex skill");

        const result = yield* scanner.scan(root, userHome);

        expect(result.skills).toEqual([
          expect.objectContaining({
            skillId: "shared",
            name: "Shared skill",
            description: "Used by either agent.",
            locations: [
              {
                source: "claude",
                scope: "project",
                path: ".claude/skills/shared/SKILL.md",
              },
              { source: "agents", scope: "user", path: "~/.agents/skills/shared/SKILL.md" },
            ],
          }),
          expect.objectContaining({
            skillId: "cursor-only",
            name: "cursor-only",
            description: "",
            locations: [
              {
                source: "cursor",
                scope: "user",
                path: "~/.cursor/skills/cursor-only/SKILL.md",
              },
            ],
          }),
          expect.objectContaining({
            skillId: "codex-only",
            name: "codex-only",
            description: "",
            locations: [
              {
                source: "codex",
                scope: "user",
                path: "~/.codex/skills/codex-only/SKILL.md",
              },
            ],
          }),
        ]);
      }),
    );

    it.effect("ignores files larger than the scan limit", () =>
      Effect.gen(function* () {
        const scanner = yield* ProjectSkillScanner.ProjectSkillScanner;
        const { root, userHome } = yield* makeScanRoots;
        yield* writeTextFile(root, ".agents/skills/large/SKILL.md", "x".repeat(64 * 1024 + 1));

        const result = yield* scanner.scan(root, userHome);

        expect(result.skills).toEqual([]);
      }),
    );

    it.effect("returns an unavailable result when the workspace no longer exists", () =>
      Effect.gen(function* () {
        const scanner = yield* ProjectSkillScanner.ProjectSkillScanner;

        const result = yield* scanner.scan("/path/that/does/not/exist");

        expect(result).toEqual({
          skills: [],
          agentFiles: { claudeMd: false, agentsMd: false },
          scannedRoot: null,
        });
      }),
    );
  });
});
