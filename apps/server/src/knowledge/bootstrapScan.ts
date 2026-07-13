// @effect-diagnostics nodeBuiltinImport:off - bounded synchronous workspace probe at the filesystem boundary.
import type { EngineDelegationTarget } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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

const scannerLabel = (target: EngineDelegationTarget): string =>
  `${target.provider}/${target.model ?? "provider-default"}`;

const scannerStartInstruction = (target: EngineDelegationTarget, index: number): string => {
  if (target.provider === "inline") {
    return `${index + 1}. Run the complete report yourself on the main thread as ${scannerLabel(target)}. Do this while delegated scanners are active.`;
  }
  const parameters = {
    ...(target.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: target.providerInstanceId }),
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(target.options === undefined ? {} : { options: target.options }),
  };
  return `${index + 1}. Call \`${target.provider}_start\` with the scan packet and ${JSON.stringify(parameters)}, then collect it with \`${target.provider}_result\`.`;
};

export function renderBootstrapScanWorkflow(
  scanners: ReadonlyArray<EngineDelegationTarget>,
): string {
  const delegatedCount = scanners.filter((target) => target.provider !== "inline").length;
  const batching =
    delegatedCount > MAX_CONCURRENT_SCANNERS
      ? `\nThe ${delegatedCount} delegated scanners exceed the concurrency limit of ${MAX_CONCURRENT_SCANNERS}. Start them in batches of at most ${MAX_CONCURRENT_SCANNERS}; never truncate the panel.`
      : "";
  return `# Multi-agent Implementation Engine knowledge bootstrap

Every scanner independently examines the WHOLE codebase. Give every delegated scanner the same task and require one JSON ScannerReport with these sections: project profile and layer map, reusable_components, rules and conventions, lessons_learned and gotchas, and features. Each finding must include source-path evidence.${batching}

## Fan out

${scanners.map(scannerStartInstruction).join("\n")}

Scanner failures are explicit partial results: record the failed scanner and reason, then continue with every successful report. Do not invent a report for a failed lane.

## Reconvene

1. Wait for every started scanner and validate its report shape.
2. Call \`engine_knowledge_merge_reports\` once with all successful reports.
3. Resolve substantive conflicts in context, favoring verified evidence and multi-scanner agreement rather than majority alone.
4. Open a \`knowledge-scan\` implementation case, save the merged report as a \`knowledge-scan\` artifact, and save candidates with \`engine_knowledge_save\` as proposed bootstrap knowledge.
5. Present the proposals for the existing user confirmation/rejection gate. Never auto-confirm them.`;
}

export function selectBootstrapWorkflow(input: {
  readonly hasCodebase: boolean;
  readonly scanners: ReadonlyArray<EngineDelegationTarget>;
  readonly legacyWorkflow: string;
}): string {
  if (!input.hasCodebase) {
    return "Nothing to scan yet: this project workspace does not contain a source file or recognized package manifest. Skip knowledge bootstrap until code exists.";
  }
  return input.scanners.some((target) => target.provider !== "inline")
    ? renderBootstrapScanWorkflow(input.scanners)
    : input.legacyWorkflow;
}
