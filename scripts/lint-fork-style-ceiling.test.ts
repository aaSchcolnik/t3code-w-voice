import { assert, describe, it } from "@effect/vitest";

import { countForkStyleFindings, evaluateCeiling } from "./lint-fork-style-ceiling.ts";

describe("lint-fork-style-ceiling", () => {
  it("counts inherited fork style diagnostics", () => {
    const count = countForkStyleFindings({
      diagnostics: [
        { code: "shadcn(no-restyle)" },
        { code: "shadcn(no-arbitrary-values)" },
        { code: "shadcn(no-restyle)" },
      ],
    });
    assert.strictEqual(count, 3);
  });

  it("fails above the ceiling and passes at or below it", () => {
    assert.isFalse(evaluateCeiling(11, 10).ok);
    assert.isTrue(evaluateCeiling(10, 10).ok);
    const below = evaluateCeiling(7, 10);
    assert.isTrue(below.ok);
    assert.include(below.message, "Lower FORK_STYLE_CEILING");
  });
});
