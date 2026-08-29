import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";

describe("buildOpenCodePermissionRules", () => {
  it("keeps runtime-mode rules and appends per-skill denials", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS.skills,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.skills.providers,
        opencode: {
          disableAll: false,
          disabledSkills: ["shadcn", "imagegen", "shadcn"],
        },
      },
    };

    expect(buildOpenCodePermissionRules("full-access", settings)).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "skill", pattern: "imagegen", action: "deny" },
      { permission: "skill", pattern: "shadcn", action: "deny" },
    ]);
  });

  it.each([
    { ...DEFAULT_SERVER_SETTINGS.skills, disableAllProviders: true },
    {
      ...DEFAULT_SERVER_SETTINGS.skills,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.skills.providers,
        opencode: { disableAll: true, disabledSkills: [] },
      },
    },
  ])("appends a wildcard skill denial for disable-all", (settings) => {
    const rules = buildOpenCodePermissionRules("approval-required", settings);
    expect(rules.at(-1)).toEqual({ permission: "skill", pattern: "*", action: "deny" });
    expect(rules).toContainEqual({ permission: "question", pattern: "*", action: "allow" });
  });
});
