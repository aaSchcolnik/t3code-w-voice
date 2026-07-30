// @effect-diagnostics nodeBuiltinImport:off - bounded synchronous workspace probe at the filesystem boundary.
import type { EngineDelegationTarget } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  NATIVE_CLAUDE_KNOWLEDGE_SCANNER_MODEL,
  NATIVE_CLAUDE_KNOWLEDGE_SCANNER_NAME,
} from "./nativeClaudeKnowledgeScanner.ts";

export const MAX_CONCURRENT_SCANNERS = 4;

const manifestNames = new Set([
  "package.json",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Dockerfile",
  "Makefile",
]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".sql",
  ".graphql",
  ".proto",
  ".tf",
  ".hcl",
  ".sh",
  ".ex",
  ".exs",
  ".scala",
  ".dart",
  ".lua",
  ".r",
  ".R",
  ".yaml",
  ".yml",
]);
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

export function workspaceCodebaseStats(workspaceRoot: string): {
  readonly hasCodebase: boolean;
  readonly sourceFileCount: number;
} {
  if (!NodeFS.existsSync(workspaceRoot)) return { hasCodebase: false, sourceFileCount: 0 };
  const pending = [workspaceRoot];
  let visited = 0;
  let sourceFileCount = 0;
  let hasManifest = false;
  while (pending.length > 0 && visited < 2_000) {
    const directory = pending.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith(".")) {
          pending.push(NodePath.join(directory, entry.name));
        }
        continue;
      }
      if (manifestNames.has(entry.name)) hasManifest = true;
      if (sourceExtensions.has(NodePath.extname(entry.name))) sourceFileCount += 1;
    }
  }
  return { hasCodebase: hasManifest || sourceFileCount > 0, sourceFileCount };
}

export const workspaceHasCodebase = (workspaceRoot: string): boolean =>
  workspaceCodebaseStats(workspaceRoot).hasCodebase;

const scannerStartInstruction = (
  target: EngineDelegationTarget,
  index: number,
  nativeClaudeSubagents: boolean,
): string => {
  if (target.provider === "claudeAgent" && nativeClaudeSubagents) {
    return `${index + 1}. Use Claude's native \`Agent\` tool with \`subagent_type: "${NATIVE_CLAUDE_KNOWLEDGE_SCANNER_NAME}"\` and the scan packet. This dedicated agent is pinned to ${NATIVE_CLAUDE_KNOWLEDGE_SCANNER_MODEL}; do not call \`claude_start\` and do not perform this lane on the main thread.`;
  }
  const toolPrefix = target.provider === "claudeAgent" ? "claude" : target.provider;
  const parameters = {
    ...(target.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: target.providerInstanceId }),
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(target.options === undefined ? {} : { options: target.options }),
  };
  return `${index + 1}. Call \`${toolPrefix}_start\` with the scan packet, a stable idempotency key, and ${JSON.stringify(parameters)}. End the turn after starting every scanner; the server delivers the results automatically.`;
};

export function renderBootstrapScanWorkflow(
  scanners: ReadonlyArray<EngineDelegationTarget>,
  options: { readonly nativeClaudeSubagents?: boolean } = {},
): string {
  const delegatedCount = scanners.length;
  const batching =
    delegatedCount > MAX_CONCURRENT_SCANNERS
      ? `\nThe ${delegatedCount} delegated scanners exceed the concurrency limit of ${MAX_CONCURRENT_SCANNERS}. Start them in batches of at most ${MAX_CONCURRENT_SCANNERS}; never truncate the panel.`
      : "";
  return `# Multi-agent Implementation Engine knowledge bootstrap

Every scanner independently examines the WHOLE codebase. Give every delegated scanner the same task and require one JSON ScannerReport with: project profile facts, knowledge entities, entity relationships, rules and conventions, lessons and gotchas, and explicit failures. Each finding must include source-path evidence.${batching}

The entity inventory is codebase-agnostic and selective: capture durable, high-leverage knowledge rather than every symbol. Use these categories:
- architecture — modules, layers, boundaries, entry points, ownership, and dependency direction
- capability — user-facing or system-facing behavior and its concrete owners
- building-block — components, hooks, utilities, services, repositories, clients, adapters, stores, middleware, workers, jobs, schemas, test fixtures, design tokens, themes, mixins, and reusable animations
- contract — public APIs, types, DTOs, events, protocols, and compatibility boundaries
- data — models, databases, migrations, caches, indexes, and persistence rules
- integration — external services, queues, APIs, SDKs, and trust boundaries
- operation — build, test, deployment, configuration, observability, recovery, and maintenance workflows

Use stable source-derived entity keys. Record locations, public API, reuse guidance, tags, metadata, and evidence when applicable. Connect entities with relationships such as depends-on, calls, implements, owns, produces, consumes, persists-to, invokes, or configures. A resource and its governing convention are separate findings: for example, a color token is a building-block while the requirement to avoid raw colors is a rule.

## Fan out

${scanners
  .map((target, index) =>
    scannerStartInstruction(target, index, options.nativeClaudeSubagents === true),
  )
  .join("\n")}

Scanner failures are explicit partial results: record the failed scanner and reason, then continue with every successful report. Do not invent a report for a failed lane.

## Reconvene

1. Wait for every started scanner and validate its report shape.
2. Call \`engine_knowledge_merge_reports\` once with all successful reports. It persists deduplicated winners only as proposed bootstrap knowledge.
3. Resolve substantive conflicts in context, favoring verified evidence and multi-scanner agreement rather than majority alone. Overwrite any corrected proposed rows with \`engine_knowledge_save\` before presenting them.
4. Open a \`knowledge-scan\` implementation case and save the merged report as a \`knowledge-scan\` artifact.
5. Present the proposals for the existing user confirmation/rejection gate. Never auto-confirm them.`;
}

export function selectBootstrapWorkflow(input: {
  readonly hasCodebase: boolean;
  readonly scanners: ReadonlyArray<EngineDelegationTarget>;
  readonly legacyWorkflow: string;
  readonly nativeClaudeSubagents?: boolean;
}): string {
  if (!input.hasCodebase) {
    return "Nothing to scan yet: this project workspace does not contain a source file or recognized package manifest. Skip knowledge bootstrap until code exists.";
  }
  return input.scanners.length > 0
    ? renderBootstrapScanWorkflow(input.scanners, {
        nativeClaudeSubagents: input.nativeClaudeSubagents === true,
      })
    : input.legacyWorkflow;
}
