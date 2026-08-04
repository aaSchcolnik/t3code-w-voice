import {
  resolveEffectiveMcpSettings,
  type DelegationRouteGroupId,
  type DelegationTaskSpec,
  type EngineDelegationSettings,
  type ProjectMcpOverrides,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  evaluateDelegationBatch,
  type DelegationBatchRoutingResult,
  type TrustedRoutingContext,
} from "./DelegationRouter.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!Predicate.isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const entry = value[key];
        return entry === undefined ? [] : [[key, canonicalize(entry)]];
      }),
  );
};

const revisionOf = (value: unknown): string => {
  const text = encodeUnknownJson(canonicalize(value));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export interface RouteDelegationBatchInput {
  readonly routeGroupId: DelegationRouteGroupId;
  readonly tasks: ReadonlyArray<DelegationTaskSpec>;
  readonly projectOverrides?: ProjectMcpOverrides | undefined;
  readonly trustedContext?: TrustedRoutingContext | undefined;
  readonly invokedByDelegatedChild?: boolean | undefined;
}

export interface DelegationRoutingSnapshot {
  readonly settingsRevision: string;
  readonly providerRevision: string;
  readonly shadow: boolean;
  readonly routerSettings: ReturnType<typeof resolveEffectiveMcpSettings>["router"];
  readonly delegationSettings: EngineDelegationSettings;
  readonly result: DelegationBatchRoutingResult;
}

export interface DelegationRouterServiceShape {
  readonly route: (
    input: RouteDelegationBatchInput,
  ) => Effect.Effect<DelegationRoutingSnapshot, never>;
}

export class DelegationRouterService extends Context.Service<
  DelegationRouterService,
  DelegationRouterServiceShape
>()("t3/provider/DelegationRouterService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;

  const route: DelegationRouterServiceShape["route"] = Effect.fn("DelegationRouterService.route")(
    function* (input) {
      const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
      const providers = yield* providerRegistry.getDelegatedCandidates;
      const effective = resolveEffectiveMcpSettings(settings.mcp, input.projectOverrides);
      const shadow =
        effective.router.mode === "off" && process.env.T3CODE_DELEGATION_ROUTER_SHADOW === "1";
      const evaluationRouterSettings = shadow
        ? { ...effective.router, mode: "suggested" as const }
        : effective.router;
      return {
        settingsRevision: revisionOf({
          router: effective.router,
          delegation: effective.engine.delegation,
        }),
        providerRevision: revisionOf(
          providers.map((provider) => ({
            snapshot: provider.snapshot,
            capabilities: provider.capabilities,
          })),
        ),
        shadow,
        routerSettings: effective.router,
        delegationSettings: effective.engine.delegation,
        result: evaluateDelegationBatch({
          routeGroupId: input.routeGroupId,
          tasks: input.tasks,
          providers,
          routerSettings: evaluationRouterSettings,
          delegationSettings: effective.engine.delegation,
          trustedContext: input.trustedContext,
          invokedByDelegatedChild: input.invokedByDelegatedChild,
        }),
      };
    },
  );

  return DelegationRouterService.of({ route });
});

export const layer = Layer.effect(DelegationRouterService, make);

export const __testing = { make, revisionOf };
