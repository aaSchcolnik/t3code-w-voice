import { describe, expect, it } from "vite-plus/test";

import {
  routerModeLabels,
  withoutProjectRouterSettings,
  withProjectRouterRole,
  withProjectRouterSetting,
} from "./McpSettings";

describe("delegation router settings", () => {
  it("uses stable user-facing labels for every router mode", () => {
    expect(routerModeLabels).toEqual({
      off: "Off",
      suggested: "Suggested",
      proactive: "Proactive",
    });
  });

  it("serializes only the project field that was explicitly overridden", () => {
    expect(withProjectRouterSetting(undefined, "mode", "proactive")).toEqual({
      router: { mode: "proactive" },
    });
  });

  it("removes one inherited field without disturbing other sparse overrides", () => {
    const overrides = withProjectRouterSetting(
      withProjectRouterSetting({ skills: { "skill-1": false } }, "mode", "off"),
      "diversity",
      "off",
    );

    expect(withProjectRouterSetting(overrides, "mode", undefined)).toEqual({
      router: { diversity: "off" },
      skills: { "skill-1": false },
    });
  });

  it("removes an empty router object when resetting to global", () => {
    expect(withProjectRouterSetting({ router: { mode: "off" } }, "mode", undefined)).toEqual({});
    expect(
      withoutProjectRouterSettings({
        router: { mode: "off", fallback: "none" },
        skills: { "skill-1": true },
      }),
    ).toEqual({ skills: { "skill-1": true } });
  });

  it("keeps scout and worker role overrides sparse and independently resettable", () => {
    const scout = [{ provider: "codex" as const, model: "gpt-5.6-sol" }];
    const worker = [{ provider: "cursor" as const }];
    const overridden = withProjectRouterRole(
      withProjectRouterRole({ skills: { "skill-1": true } }, "scout", scout),
      "worker",
      worker,
    );

    expect(overridden.engine?.delegation?.roles).toEqual({ scout, worker });
    expect(withProjectRouterRole(overridden, "scout", undefined)).toEqual({
      engine: { delegation: { roles: { worker } } },
      skills: { "skill-1": true },
    });
    expect(
      withProjectRouterRole(
        withProjectRouterRole(overridden, "scout", undefined),
        "worker",
        undefined,
      ),
    ).toEqual({ skills: { "skill-1": true } });
  });
});
