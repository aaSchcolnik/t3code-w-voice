import { describe, expect, it } from "vite-plus/test";

import { withGlobalDelegationRole, withProjectDelegationRole } from "./McpSettings";

describe("delegation role settings", () => {
  it("keeps scout and worker role overrides sparse and independently resettable", () => {
    const scout = [{ provider: "codex" as const, model: "gpt-5.6-sol" }];
    const worker = [{ provider: "cursor" as const }];
    const overridden = withProjectDelegationRole(
      withProjectDelegationRole({ skills: { "skill-1": true } }, "scout", scout),
      "worker",
      worker,
    );

    expect(overridden.engine?.delegation?.roles).toEqual({ scout, worker });
    expect(withProjectDelegationRole(overridden, "scout", undefined)).toEqual({
      engine: { delegation: { roles: { worker } } },
      skills: { "skill-1": true },
    });
    expect(
      withProjectDelegationRole(
        withProjectDelegationRole(overridden, "scout", undefined),
        "worker",
        undefined,
      ),
    ).toEqual({ skills: { "skill-1": true } });
  });

  it("updates one global role without discarding the other role customization", () => {
    const scout = [{ provider: "cursor" as const, model: "composer-2.5" }];
    const worker = [{ provider: "codex" as const, model: "gpt-5.6-sol" }];

    expect(withGlobalDelegationRole({ scout }, "worker", worker)).toEqual({ scout, worker });
    expect(withGlobalDelegationRole({ scout, worker }, "scout", undefined)).toEqual({ worker });
  });
});
