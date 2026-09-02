#!/usr/bin/env node

import * as NodeUtil from "node:util";

export interface ReleaseSourceInput {
  readonly releaseSha: string;
  readonly defaultBranchSha: string;
  readonly defaultBranch: string;
}

export function releaseSourceValidationError(input: ReleaseSourceInput): string | null {
  if (input.releaseSha === input.defaultBranchSha) return null;
  return [
    `Refusing to package ${input.releaseSha}.`,
    `Fork releases must use the tip of '${input.defaultBranch}' (${input.defaultBranchSha}) so fork features cannot disappear from nightly or stable artifacts.`,
  ].join(" ");
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "release-sha": { type: "string" },
      "default-branch-sha": { type: "string" },
      "default-branch": { type: "string" },
    },
    strict: true,
  });
  const releaseSha = values["release-sha"]?.trim();
  const defaultBranchSha = values["default-branch-sha"]?.trim();
  const defaultBranch = values["default-branch"]?.trim();
  if (!releaseSha || !defaultBranchSha || !defaultBranch) {
    process.stderr.write(
      "Usage: verify-release-source --release-sha <sha> --default-branch-sha <sha> --default-branch <name>\n",
    );
    process.exitCode = 2;
  } else {
    const error = releaseSourceValidationError({
      releaseSha,
      defaultBranchSha,
      defaultBranch,
    });
    if (error) {
      process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Release source verified at ${releaseSha} on '${defaultBranch}'.\n`);
    }
  }
}
