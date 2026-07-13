import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ComputerUseProviderStatus,
  type ComputerUseTestResult,
} from "@t3tools/contracts";

import {
  COMPUTER_USE_REMEDIATION_COPY,
  effectiveComputerUseRemediation,
  deriveComputerUseQueryState,
  presentComputerUseStatus,
} from "./computerUsePresentation.ts";

const providerInstanceId = ProviderInstanceId.make("codex_custom_home");
const status: ComputerUseProviderStatus = {
  providerInstanceId,
  providerDisplayName: "Codex Custom",
  readiness: "ready-unverified",
  skill: "available",
  nodeRepl: "available",
  hostApp: "available",
  pluginRuntime: "available",
  nativePermissions: "unverified",
  requiresNewSession: true,
  remediation: ["grant-accessibility", "grant-screen-recording", "start-new-session"],
};

describe("Computer Use settings presentation", () => {
  it("keeps loading, error, empty, and ready query states distinct", () => {
    expect(
      deriveComputerUseQueryState({
        isPending: true,
        hasData: false,
        providerCount: 0,
        error: null,
      }),
    ).toBe("loading");
    expect(
      deriveComputerUseQueryState({
        isPending: false,
        hasData: false,
        providerCount: 0,
        error: "offline",
      }),
    ).toBe("error");
    expect(
      deriveComputerUseQueryState({
        isPending: false,
        hasData: true,
        providerCount: 0,
        error: null,
      }),
    ).toBe("empty");
    expect(
      deriveComputerUseQueryState({
        isPending: false,
        hasData: true,
        providerCount: 2,
        error: null,
      }),
    ).toBe("ready");
  });

  it("shows unverified readiness before the explicit native test", () => {
    expect(presentComputerUseStatus(status, null)).toMatchObject({
      label: "Ready to test",
      badgeVariant: "warning",
    });
  });

  it("shows verified only after all privacy-safe diagnostic checks pass", () => {
    const result: ComputerUseTestResult = {
      providerInstanceId,
      passed: true,
      failureCategory: null,
      metadata: {
        runtimeInitialized: true,
        appDiscoverySucceeded: true,
        discoveredAppCount: 8,
        targetAppFound: true,
        targetKind: "t3-packaged",
        accessibilityAvailable: true,
        accessibilityTextLength: 542,
        screenshotAvailable: true,
      },
      remediation: [],
    };
    expect(presentComputerUseStatus(status, result)).toMatchObject({
      label: "Verified",
      badgeVariant: "success",
    });
    expect(effectiveComputerUseRemediation(status, result)).toEqual([]);

    const degradedStatus: ComputerUseProviderStatus = {
      ...status,
      readiness: "plugin-runtime-missing",
      pluginRuntime: "missing",
      remediation: ["repair-plugin-runtime"],
    };
    expect(presentComputerUseStatus(degradedStatus, result)).toMatchObject({
      label: "Runtime incomplete",
      badgeVariant: "error",
    });
    expect(effectiveComputerUseRemediation(degradedStatus, result)).toEqual([
      "repair-plugin-runtime",
    ]);
  });

  it("distinguishes accessibility and screenshot permission failures", () => {
    const failure = (failureCategory: ComputerUseTestResult["failureCategory"]) =>
      ({
        providerInstanceId,
        passed: false,
        failureCategory,
        metadata: {
          runtimeInitialized: true,
          appDiscoverySucceeded: true,
          discoveredAppCount: 4,
          targetAppFound: true,
          targetKind: "t3-packaged",
          accessibilityAvailable: failureCategory === "screenshot-unavailable",
          accessibilityTextLength: failureCategory === "screenshot-unavailable" ? 100 : 0,
          screenshotAvailable: false,
        },
        remediation: [
          failureCategory === "screenshot-unavailable"
            ? "grant-screen-recording"
            : "grant-accessibility",
        ],
      }) satisfies ComputerUseTestResult;
    expect(
      presentComputerUseStatus(status, failure("accessibility-unavailable")).summary,
    ).toContain("accessibility content");
    expect(presentComputerUseStatus(status, failure("screenshot-unavailable")).summary).toContain(
      "screenshot access",
    );
  });

  it("documents the real plugin flow and explicitly rejects the duplicate MCP guidance", () => {
    expect(COMPUTER_USE_REMEDIATION_COPY["install-enable-plugin"]).toContain(
      "Work or Codex → Plugins",
    );
    expect(COMPUTER_USE_REMEDIATION_COPY["enable-node-repl"]).toContain(
      "do not enable a separate standalone Computer Use MCP",
    );
    expect(COMPUTER_USE_REMEDIATION_COPY["install-host-app"]).toContain(
      "does not need to remain open",
    );
  });
});
