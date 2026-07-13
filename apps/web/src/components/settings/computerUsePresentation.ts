import type {
  ComputerUseProviderStatus,
  ComputerUseRemediation,
  ComputerUseTestResult,
} from "@t3tools/contracts";

export type ComputerUseBadgeVariant = "success" | "warning" | "error" | "secondary";

export interface ComputerUsePresentation {
  readonly label: string;
  readonly summary: string;
  readonly badgeVariant: ComputerUseBadgeVariant;
}

export type ComputerUseQueryState = "loading" | "error" | "empty" | "ready";

export function deriveComputerUseQueryState(input: {
  readonly isPending: boolean;
  readonly hasData: boolean;
  readonly providerCount: number;
  readonly error: string | null;
}): ComputerUseQueryState {
  if (input.isPending && !input.hasData) return "loading";
  if (input.error !== null && !input.hasData) return "error";
  return input.providerCount === 0 ? "empty" : "ready";
}

const READINESS: Record<ComputerUseProviderStatus["readiness"], ComputerUsePresentation> = {
  unsupported: {
    label: "Unsupported",
    summary: "Provider-native Computer Use currently requires macOS.",
    badgeVariant: "secondary",
  },
  "provider-disabled": {
    label: "Provider disabled",
    summary: "Enable this Codex provider in T3 Code before checking Computer Use.",
    badgeVariant: "warning",
  },
  "provider-unavailable": {
    label: "Provider unavailable",
    summary: "T3 Code could not start this Codex provider with its effective configuration.",
    badgeVariant: "error",
  },
  "skill-missing": {
    label: "Plugin missing",
    summary: "The Computer Use skill is not installed for this Codex provider.",
    badgeVariant: "warning",
  },
  "skill-disabled": {
    label: "Skill disabled",
    summary: "The installed Computer Use skill is disabled for this Codex provider.",
    badgeVariant: "warning",
  },
  "node-repl-missing": {
    label: "Capability missing",
    summary: "The plugin's JavaScript runtime capability is not configured.",
    badgeVariant: "warning",
  },
  "node-repl-disabled": {
    label: "Capability disabled",
    summary: "The plugin's JavaScript runtime capability is disabled.",
    badgeVariant: "warning",
  },
  "node-repl-startup-failed": {
    label: "Startup failed",
    summary: "The plugin runtime is configured but did not start successfully.",
    badgeVariant: "error",
  },
  "node-repl-tool-missing": {
    label: "Tool unavailable",
    summary: "The plugin runtime started without its required JavaScript tool.",
    badgeVariant: "error",
  },
  "host-app-missing": {
    label: "Host app missing",
    summary: "The ChatGPT/Codex desktop host app is required to supply native runtime assets.",
    badgeVariant: "warning",
  },
  "plugin-runtime-missing": {
    label: "Runtime incomplete",
    summary: "The Computer Use plugin is missing its wrapper or native service bundle.",
    badgeVariant: "error",
  },
  "ready-unverified": {
    label: "Ready to test",
    summary: "Installation looks ready. Native macOS permissions have not been verified yet.",
    badgeVariant: "warning",
  },
  verified: {
    label: "Verified",
    summary: "Native runtime, app discovery, accessibility, and screenshot access all succeeded.",
    badgeVariant: "success",
  },
};

export const COMPUTER_USE_REMEDIATION_COPY: Record<ComputerUseRemediation, string> = {
  "install-host-app":
    "Install the ChatGPT/Codex desktop host app. It supplies runtime assets, but its UI does not need to remain open.",
  "enable-codex-provider":
    "Enable this Codex provider under Settings → Providers, then start a new session.",
  "install-enable-plugin":
    "In ChatGPT desktop, open Work or Codex → Plugins, then install and enable Computer Use.",
  "enable-plugin-capabilities":
    "Enable the Computer Use plugin's MCP and skill capability in the desktop Plugins UI.",
  "enable-node-repl":
    "Re-enable the Computer Use plugin capability in the desktop Plugins UI; do not enable a separate standalone Computer Use MCP.",
  "repair-plugin-runtime":
    "Reinstall or update the Computer Use plugin so its wrapper and native service are restored.",
  "grant-accessibility":
    "Grant macOS Accessibility permission to the Computer Use service and its required host applications.",
  "grant-screen-recording":
    "Grant macOS Screen Recording permission to the Computer Use service and its required host applications.",
  "allow-required-applications":
    "Allow the required applications if macOS presents an automation or application-access prompt.",
  "start-new-session": "Start a new T3 Codex session after changing plugin setup or permissions.",
  "retry-test": "Run Test Computer Use again after completing the remediation steps.",
};

export function presentComputerUseStatus(
  status: ComputerUseProviderStatus,
  testResult: ComputerUseTestResult | null,
): ComputerUsePresentation {
  if (
    testResult?.providerInstanceId === status.providerInstanceId &&
    (status.readiness === "ready-unverified" || status.readiness === "verified")
  ) {
    if (testResult.passed) return READINESS.verified;
    return {
      label: "Test failed",
      summary: testFailureSummary(testResult),
      badgeVariant: "error",
    };
  }
  return READINESS[status.readiness];
}

export function testFailureSummary(result: ComputerUseTestResult): string {
  switch (result.failureCategory) {
    case "accessibility-permission-denied":
    case "accessibility-unavailable":
      return "T3 Code was found, but accessibility content was unavailable.";
    case "screen-recording-permission-denied":
    case "screenshot-unavailable":
      return "Accessibility succeeded, but screenshot access was unavailable.";
    case "runtime-initialization-failed":
      return "The provider-native Computer Use runtime could not initialize.";
    case "app-discovery-failed":
      return "The native runtime initialized, but application discovery failed.";
    case "target-app-not-found":
      return "Application discovery succeeded, but T3 Code was not found.";
    case "native-service-failed":
      return "The native Computer Use service failed during the diagnostic.";
    case null:
      return "The diagnostic did not complete successfully.";
    default:
      return READINESS[
        result.failureCategory === "unsupported-platform"
          ? "unsupported"
          : result.failureCategory === "host-app-missing"
            ? "host-app-missing"
            : result.failureCategory === "plugin-runtime-missing"
              ? "plugin-runtime-missing"
              : result.failureCategory === "skill-missing"
                ? "skill-missing"
                : result.failureCategory === "skill-disabled"
                  ? "skill-disabled"
                  : result.failureCategory === "node-repl-missing"
                    ? "node-repl-missing"
                    : result.failureCategory === "node-repl-disabled"
                      ? "node-repl-disabled"
                      : result.failureCategory === "node-repl-startup-failed"
                        ? "node-repl-startup-failed"
                        : result.failureCategory === "node-repl-tool-missing"
                          ? "node-repl-tool-missing"
                          : "provider-unavailable"
      ].summary;
  }
}

export function effectiveComputerUseRemediation(
  status: ComputerUseProviderStatus,
  testResult: ComputerUseTestResult | null,
): ReadonlyArray<ComputerUseRemediation> {
  return testResult?.providerInstanceId === status.providerInstanceId &&
    (status.readiness === "ready-unverified" || status.readiness === "verified")
    ? testResult.remediation
    : status.remediation;
}
