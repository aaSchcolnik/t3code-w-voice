import { describe, expect, it } from "vite-plus/test";

import { compactDelegationTarget } from "./EngineDelegationSettings";

describe("delegation target settings", () => {
  it("omits undefined optional fields before persisting a chain", () => {
    expect(
      compactDelegationTarget({
        provider: "cursor",
        providerInstanceId: undefined,
        model: undefined,
        options: undefined,
        focus: undefined,
      }),
    ).toEqual({ provider: "cursor" });
  });

  it("preserves configured model options and focus", () => {
    expect(
      compactDelegationTarget({
        provider: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
        focus: "review",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
      focus: "review",
    });
  });
});
