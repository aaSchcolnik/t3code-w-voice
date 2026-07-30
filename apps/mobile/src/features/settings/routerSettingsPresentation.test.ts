import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectRouterMode,
  routerSettingsScopeKey,
  type RouterSettingsScope,
} from "./routerSettingsPresentation";

describe("mobile router settings presentation", () => {
  it("presents absent project mode as inherited", () => {
    expect(projectRouterMode("suggested", { preview: false })).toEqual({
      effective: "suggested",
      inherited: true,
    });
  });

  it("presents an explicit project mode as an override", () => {
    expect(projectRouterMode("suggested", { router: { mode: "off" } })).toEqual({
      effective: "off",
      inherited: false,
    });
  });

  it("uses environment-qualified scope identities", () => {
    const scope: RouterSettingsScope = {
      type: "project",
      environmentId: EnvironmentId.make("remote"),
      projectId: ProjectId.make("project-1"),
      label: "T3 Code",
      overrides: null,
    };
    expect(routerSettingsScopeKey(scope)).toBe("project:remote:project-1");
  });
});
