import type {
  ComputerUseStatusResult,
  ComputerUseTestResult,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "./ProviderDriver.ts";
import { unavailableComputerUseStatus } from "./computerUseCapability.ts";

export function collectComputerUseStatuses(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly platformSupported: boolean;
  readonly cwd?: string;
}): Effect.Effect<ComputerUseStatusResult> {
  const instancesById = new Map(
    input.instances.map((instance) => [instance.instanceId, instance] as const),
  );
  const codexProviders = input.providers.filter((provider) => provider.driver === "codex");
  return Effect.forEach(
    codexProviders,
    (provider) => {
      const capability = instancesById.get(provider.instanceId)?.computerUse;
      return capability
        ? capability.getStatus(input.cwd)
        : Effect.succeed(
            unavailableComputerUseStatus({
              providerInstanceId: provider.instanceId,
              providerDisplayName: provider.displayName ?? "Codex",
              providerEnabled: provider.enabled,
              platformSupported: input.platformSupported,
            }),
          );
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map((providers) => ({ providers })));
}

export function testComputerUseInstance(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly instance: ProviderInstance | undefined;
  readonly cwd?: string;
}): Effect.Effect<ComputerUseTestResult> {
  if (input.instance?.computerUse) return input.instance.computerUse.test(input.cwd);
  return Effect.succeed({
    providerInstanceId: input.providerInstanceId,
    passed: false,
    failureCategory: "provider-unavailable",
    metadata: {
      runtimeInitialized: false,
      appDiscoverySucceeded: false,
      discoveredAppCount: 0,
      targetAppFound: false,
      targetKind: "not-found",
      accessibilityAvailable: false,
      accessibilityTextLength: 0,
      screenshotAvailable: false,
    },
    remediation: ["retry-test"],
  });
}
