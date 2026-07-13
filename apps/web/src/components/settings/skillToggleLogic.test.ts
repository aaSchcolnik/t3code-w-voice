import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSkillToggleState,
  setProviderSkillsDisabled,
  setSkillEnabled,
} from "./skillToggleLogic";

describe("skill toggle settings logic", () => {
  it("enables and disables one skill without changing other providers", () => {
    const disabled = setSkillEnabled(
      DEFAULT_SERVER_SETTINGS.skills,
      "claudeAgent",
      "shadcn",
      false,
    );
    expect(disabled.providers.claudeAgent.disabledSkills).toEqual(["shadcn"]);
    expect(disabled.providers.codex).toEqual(DEFAULT_SERVER_SETTINGS.skills.providers.codex);

    expect(setSkillEnabled(disabled, "claudeAgent", "shadcn", true)).toEqual(
      DEFAULT_SERVER_SETTINGS.skills,
    );
  });

  it("reports master and provider overrides before per-skill state", () => {
    const perSkillDisabled = setSkillEnabled(
      DEFAULT_SERVER_SETTINGS.skills,
      "codex",
      "shadcn",
      false,
    );
    expect(resolveSkillToggleState(perSkillDisabled, "codex", "shadcn")).toEqual({
      enabled: false,
      overriddenBy: null,
    });

    const providerDisabled = setProviderSkillsDisabled(perSkillDisabled, "codex", true);
    expect(resolveSkillToggleState(providerDisabled, "codex", "other")).toEqual({
      enabled: false,
      overriddenBy: "provider",
    });

    expect(
      resolveSkillToggleState({ ...providerDisabled, disableAllProviders: true }, "codex", "other"),
    ).toEqual({ enabled: false, overriddenBy: "master" });
  });
});
