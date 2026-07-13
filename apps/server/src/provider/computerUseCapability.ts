import type {
  ComputerUseAssetState,
  ComputerUseNodeReplState,
  ComputerUseProviderStatus,
  ComputerUseRemediation,
  ComputerUseSkillState,
  ComputerUseTestResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ComputerUseReadinessFacts {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDisplayName: string;
  readonly platformSupported: boolean;
  readonly providerEnabled: boolean;
  readonly providerAvailable: boolean;
  readonly skill: ComputerUseSkillState;
  readonly nodeRepl: ComputerUseNodeReplState;
  readonly hostApp: ComputerUseAssetState;
  readonly pluginRuntime: ComputerUseAssetState;
}

export interface ComputerUseCapabilityShape {
  readonly getStatus: (cwd?: string) => Effect.Effect<ComputerUseProviderStatus>;
  readonly test: (cwd?: string) => Effect.Effect<ComputerUseTestResult>;
}

function collectRemediation(facts: ComputerUseReadinessFacts): Array<ComputerUseRemediation> {
  if (!facts.platformSupported) return [];
  if (!facts.providerEnabled) return ["enable-codex-provider", "start-new-session"];
  if (!facts.providerAvailable) return ["retry-test"];
  const remediation: Array<ComputerUseRemediation> = [];
  if (facts.hostApp === "missing") remediation.push("install-host-app");
  if (facts.skill === "missing") remediation.push("install-enable-plugin");
  if (facts.skill === "disabled") remediation.push("enable-plugin-capabilities");
  if (facts.nodeRepl === "missing" || facts.nodeRepl === "disabled") {
    remediation.push("enable-node-repl");
  }
  if (facts.nodeRepl === "startup-failed") remediation.push("retry-test");
  if (facts.nodeRepl === "tool-missing") remediation.push("enable-plugin-capabilities");
  if (facts.pluginRuntime === "missing") remediation.push("repair-plugin-runtime");
  remediation.push("grant-accessibility", "grant-screen-recording", "allow-required-applications");
  remediation.push("start-new-session");
  return [...new Set(remediation)];
}

export function deriveComputerUseProviderStatus(
  facts: ComputerUseReadinessFacts,
): ComputerUseProviderStatus {
  const readiness = !facts.platformSupported
    ? "unsupported"
    : !facts.providerEnabled
      ? "provider-disabled"
      : !facts.providerAvailable
        ? "provider-unavailable"
        : facts.skill === "missing"
          ? "skill-missing"
          : facts.skill === "disabled"
            ? "skill-disabled"
            : facts.nodeRepl === "missing"
              ? "node-repl-missing"
              : facts.nodeRepl === "disabled"
                ? "node-repl-disabled"
                : facts.nodeRepl === "startup-failed"
                  ? "node-repl-startup-failed"
                  : facts.nodeRepl === "tool-missing"
                    ? "node-repl-tool-missing"
                    : facts.hostApp === "missing"
                      ? "host-app-missing"
                      : facts.pluginRuntime === "missing"
                        ? "plugin-runtime-missing"
                        : "ready-unverified";

  const remediation = collectRemediation(facts);
  return {
    providerInstanceId: facts.providerInstanceId,
    providerDisplayName: facts.providerDisplayName,
    readiness,
    skill: facts.skill,
    nodeRepl: facts.nodeRepl,
    hostApp: facts.hostApp,
    pluginRuntime: facts.pluginRuntime,
    nativePermissions: "unverified",
    requiresNewSession: remediation.includes("start-new-session"),
    remediation,
  };
}

export function unavailableComputerUseStatus(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDisplayName: string;
  readonly providerEnabled: boolean;
  readonly platformSupported: boolean;
}): ComputerUseProviderStatus {
  return deriveComputerUseProviderStatus({
    ...input,
    providerAvailable: false,
    skill: "missing",
    nodeRepl: "missing",
    hostApp: "unknown",
    pluginRuntime: "unknown",
  });
}
