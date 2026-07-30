import {
  DEFAULT_SERVER_SETTINGS,
  DelegationRouteGroupId,
  DelegationLaneId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { CODEX_DELEGATION_CAPABILITIES } from "./Layers/CodexAdapter.ts";
import { __testing } from "./DelegationRouterService.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "./testUtils/providerRegistryMock.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex_custom"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-29T00:00:00.000Z",
  models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

describe("DelegationRouterService", () => {
  it.effect("loads call-time settings and preserves exact selected metadata", () =>
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make({
        ...DEFAULT_SERVER_SETTINGS,
        mcp: {
          ...DEFAULT_SERVER_SETTINGS.mcp,
          router: { ...DEFAULT_SERVER_SETTINGS.mcp.router, mode: "suggested" as const },
        },
      });
      const registry = makeProviderRegistryMock([provider]);
      const service = yield* __testing.make.pipe(
        Effect.provideService(
          ServerSettingsService,
          ServerSettingsService.of({
            start: Effect.void,
            ready: Effect.void,
            getSettings: Ref.get(settingsRef),
            updateSettings: () => Ref.get(settingsRef),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.succeed(Stream.empty),
          }),
        ),
        Effect.provideService(
          ProviderRegistry,
          ProviderRegistry.of({
            ...registry,
            getDelegatedCandidates: Effect.succeed([
              { snapshot: provider, capabilities: CODEX_DELEGATION_CAPABILITIES },
            ]),
          }),
        ),
      );

      const route = yield* service.route({
        routeGroupId: DelegationRouteGroupId.make("route-service"),
        tasks: [
          {
            laneId: DelegationLaneId.make("lane"),
            title: "Inspect",
            task: "Inspect the implementation.",
            role: "worker",
            workspaceAccess: "read-only",
            providerConstraint: {
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex_custom"),
              model: "gpt-5",
            },
          },
        ],
      });

      expect(route.result.ok).toBe(true);
      if (!route.result.ok) return;
      expect(route.result.decisions[0]?.selected).toEqual({
        provider: "codex",
        providerInstanceId: "codex_custom",
        model: "gpt-5",
      });
      expect(route.result.decisions[0]?.taskKind).toBe("general");
    }),
  );

  it("makes revisions canonical and sensitive to policy changes", () => {
    expect(__testing.revisionOf({ b: 2, a: 1 })).toBe(__testing.revisionOf({ a: 1, b: 2 }));
    expect(__testing.revisionOf({ mode: "off" })).not.toBe(
      __testing.revisionOf({ mode: "suggested" }),
    );
  });
});
