import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  deriveComputerUseProviderStatus,
  type ComputerUseReadinessFacts,
} from "./computerUseCapability.ts";

const readyFacts = (): ComputerUseReadinessFacts => ({
  providerInstanceId: ProviderInstanceId.make("codex_work"),
  providerDisplayName: "Codex Work",
  platformSupported: true,
  providerEnabled: true,
  providerAvailable: true,
  skill: "available",
  nodeRepl: "available",
  hostApp: "available",
  pluginRuntime: "available",
});

describe("deriveComputerUseProviderStatus", () => {
  it("reports a complete integration as ready but permissions unverified", () => {
    expect(deriveComputerUseProviderStatus(readyFacts())).toMatchObject({
      readiness: "ready-unverified",
      nativePermissions: "unverified",
      requiresNewSession: true,
    });
  });

  const cases: ReadonlyArray<readonly [Partial<ComputerUseReadinessFacts>, string, string]> = [
    [{ skill: "missing" }, "skill-missing", "install-enable-plugin"],
    [{ skill: "disabled" }, "skill-disabled", "enable-plugin-capabilities"],
    [{ nodeRepl: "missing" }, "node-repl-missing", "enable-node-repl"],
    [{ nodeRepl: "disabled" }, "node-repl-disabled", "enable-node-repl"],
    [{ nodeRepl: "startup-failed" }, "node-repl-startup-failed", "retry-test"],
    [{ nodeRepl: "tool-missing" }, "node-repl-tool-missing", "enable-plugin-capabilities"],
    [{ hostApp: "missing" }, "host-app-missing", "install-host-app"],
    [{ pluginRuntime: "missing" }, "plugin-runtime-missing", "repair-plugin-runtime"],
  ];

  it.each(cases)("maps %o to %s", (patch, readiness, remediation) => {
    const status = deriveComputerUseProviderStatus({ ...readyFacts(), ...patch });
    expect(status.readiness).toBe(readiness);
    expect(status.remediation).toContain(remediation);
  });

  it("prioritizes provider state and never treats a separate computer-use MCP as required", () => {
    const status = deriveComputerUseProviderStatus({
      ...readyFacts(),
      providerEnabled: false,
      skill: "missing",
    });
    expect(status.readiness).toBe("provider-disabled");
    expect(status.remediation.join(" ")).not.toContain("standalone");
    expect(status.remediation.join(" ")).not.toContain("computer-use-mcp");
  });
});
