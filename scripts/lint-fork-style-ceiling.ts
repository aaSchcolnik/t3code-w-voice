#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - one-shot CI gate over a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Upstream style rules are errors outside the listed fork UI files. This gate
// holds their inherited warning count steady until those views are migrated.
export const FORK_STYLE_CEILING = 116;

const STYLE_RULES = new Set([
  "shadcn(no-restyle)",
  "shadcn(no-arbitrary-values)",
  "shadcn(no-raw-colors)",
  "shadcn(no-unknown-classes)",
]);
const RULE = "fork style";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

interface LintReport {
  readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
}

export function countForkStyleFindings(report: LintReport): number {
  return report.diagnostics.filter((diagnostic) => STYLE_RULES.has(diagnostic.code)).length;
}

export function evaluateCeiling(
  count: number,
  ceiling: number,
): { readonly ok: boolean; readonly message: string } {
  if (count > ceiling) {
    return {
      ok: false,
      message:
        `${RULE}: ${count} findings exceed the ceiling of ${ceiling}. ` +
        "Use a variant or size on the components/ui export instead of a className override " +
        "(run `vp lint apps/web/src` for the list).",
    };
  }
  const slack = ceiling - count;
  return {
    ok: true,
    message:
      slack === 0
        ? `${RULE}: ${count} findings, at the ceiling.`
        : `${RULE}: ${count} findings, ${slack} below the ceiling of ${ceiling}. Lower FORK_STYLE_CEILING in scripts/lint-fork-style-ceiling.ts to ${count}.`,
  };
}

function main() {
  const result = NodeChildProcess.spawnSync("vp", ["lint", "--format", "json", "apps/web/src"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout) as LintReport;
  const verdict = evaluateCeiling(countForkStyleFindings(report), FORK_STYLE_CEILING);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${verdict.message}\n`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
