import { assert, it } from "@effect/vitest";

import { releaseSourceValidationError } from "./verify-release-source.ts";

it("accepts the exact fork default-branch tip", () => {
  assert.isNull(
    releaseSourceValidationError({
      releaseSha: "abc123",
      defaultBranchSha: "abc123",
      defaultBranch: "subagents-and-mcps",
    }),
  );
});

it("rejects older, upstream, and manually selected release refs", () => {
  assert.equal(
    releaseSourceValidationError({
      releaseSha: "upstream456",
      defaultBranchSha: "fork789",
      defaultBranch: "subagents-and-mcps",
    }),
    "Refusing to package upstream456. Fork releases must use the tip of 'subagents-and-mcps' (fork789) so fork features cannot disappear from nightly or stable artifacts.",
  );
});
