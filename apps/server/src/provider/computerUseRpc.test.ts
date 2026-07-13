import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "./ProviderDriver.ts";
import { collectComputerUseStatuses, testComputerUseInstance } from "./computerUseRpc.ts";

const codexProvider = (id: string, displayName: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const instanceWithStatus = (provider: ServerProvider, homeMarker: number): ProviderInstance =>
  ({
    instanceId: provider.instanceId,
    driverKind: provider.driver,
    enabled: true,
    displayName: provider.displayName,
    continuationIdentity: { driverKind: provider.driver, continuationKey: String(homeMarker) },
    computerUse: {
      getStatus: () =>
        Effect.succeed({
          providerInstanceId: provider.instanceId,
          providerDisplayName: provider.displayName ?? "Codex",
          readiness: "ready-unverified",
          skill: "available",
          nodeRepl: "available",
          hostApp: "available",
          pluginRuntime: "available",
          nativePermissions: "unverified",
          requiresNewSession: true,
          remediation: ["start-new-session"],
        }),
      test: () =>
        Effect.succeed({
          providerInstanceId: provider.instanceId,
          passed: true,
          failureCategory: null,
          metadata: {
            runtimeInitialized: true,
            appDiscoverySucceeded: true,
            discoveredAppCount: homeMarker,
            targetAppFound: true,
            targetKind: "t3-packaged",
            accessibilityAvailable: true,
            accessibilityTextLength: homeMarker,
            screenshotAvailable: true,
          },
          remediation: [],
        }),
    },
  }) as unknown as ProviderInstance;

describe("Computer Use RPC aggregation", () => {
  it.effect("forwards the selected project's workspace to status and test requests", () =>
    Effect.gen(function* () {
      const provider = codexProvider("codex_scoped", "Codex Scoped");
      const requestedCwds: Array<string | undefined> = [];
      const instance = {
        ...instanceWithStatus(provider, 1),
        computerUse: {
          getStatus: (cwd?: string) => {
            requestedCwds.push(cwd);
            return instanceWithStatus(provider, 1).computerUse!.getStatus(cwd);
          },
          test: (cwd?: string) => {
            requestedCwds.push(cwd);
            return instanceWithStatus(provider, 1).computerUse!.test(cwd);
          },
        },
      } satisfies ProviderInstance;
      const cwd = "/tmp/scoped-project";

      yield* collectComputerUseStatuses({
        providers: [provider],
        instances: [instance],
        platformSupported: true,
        cwd,
      });
      yield* testComputerUseInstance({
        providerInstanceId: provider.instanceId,
        instance,
        cwd,
      });

      expect(requestedCwds).toEqual([cwd, cwd]);
    }),
  );

  it.effect("keeps multiple Codex provider instances distinct", () =>
    Effect.gen(function* () {
      const personal = codexProvider("codex_personal", "Codex Personal");
      const work = codexProvider("codex_work", "Codex Work");
      const result = yield* collectComputerUseStatuses({
        providers: [personal, work],
        instances: [instanceWithStatus(personal, 1), instanceWithStatus(work, 2)],
        platformSupported: true,
      });
      expect(result.providers.map((status) => status.providerInstanceId)).toEqual([
        personal.instanceId,
        work.instanceId,
      ]);
      expect(result.providers.map((status) => status.providerDisplayName)).toEqual([
        "Codex Personal",
        "Codex Work",
      ]);
    }),
  );

  it.effect("returns a sanitized provider failure when an instance is unavailable", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_missing");
      const result = yield* testComputerUseInstance({ providerInstanceId, instance: undefined });
      expect(result.failureCategory).toBe("provider-unavailable");
      expect("text" in result.metadata).toBe(false);
      expect("screenshot" in result.metadata).toBe(false);
    }),
  );
});
