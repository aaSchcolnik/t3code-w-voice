/**
 * DelegatedProviderResolver — deterministic provider-instance and model
 * selection for delegated (cross-provider) subagent runs.
 *
 * Delegated runs historically assumed `ProviderInstanceId.make("cursor")`
 * named a live configured instance and echoed the caller's requested model
 * back without validation. This module resolves a delegated-run request
 * against the current provider snapshots so every run either starts on a
 * confirmed instance with a confirmed model, or fails with an actionable
 * reason (disabled, uninstalled, unavailable, wrong driver, unknown model).
 *
 * Pure functions over `ServerProvider` snapshots — callers supply the
 * snapshot list (usually from `ProviderRegistry.getProviders`).
 *
 * @module provider/DelegatedProviderResolver
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type DelegatedProviderInstanceCapability,
  type DelegationProviderReasonCode,
  type DelegatedRunCapabilities,
  type DelegatedRunProvider,
  type ModelSelection,
  type ProviderOptionSelections,
  type ResolvedProviderOption,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  buildResolvedProviderOptionDetails,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import { normalizeCodexDelegatedOptions } from "../codexModelOptions.ts";

/**
 * Why a configured instance cannot service a delegated run right now, or
 * `undefined` when it can.
 */
export const instanceUnusableReason = (instance: ServerProvider): string | undefined => {
  if (instance.availability === "unavailable") {
    return instance.unavailableReason ?? "The provider instance is unavailable in this build.";
  }
  if (!instance.enabled) {
    return "The provider instance is disabled in settings.";
  }
  if (!instance.installed) {
    return "The provider CLI is not installed.";
  }
  if (instance.delegation?.available === false) {
    return instance.delegation.reason ?? "The provider cannot run delegated tasks.";
  }
  return undefined;
};

export const instanceUnusableReasonCode = (
  instance: ServerProvider,
): Extract<
  DelegationProviderReasonCode,
  "provider_disabled" | "provider_uninstalled" | "provider_unavailable"
> => {
  if (instance.availability === "unavailable") return "provider_unavailable";
  if (!instance.enabled) return "provider_disabled";
  if (!instance.installed) return "provider_uninstalled";
  if (instance.delegation?.available === false) return "provider_unavailable";
  return "provider_unavailable";
};

const instanceDisplayName = (instance: ServerProvider): string =>
  instance.displayName ?? instance.instanceId;

const compareInstanceIds = (left: ServerProvider, right: ServerProvider): number =>
  left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;

/**
 * The model a delegated run uses when the caller does not request one.
 * Provider snapshots list built-in models first, so the first advertised
 * model is the instance's default.
 */
export const defaultModelForInstance = (instance: ServerProvider): string | undefined =>
  instance.models[0]?.slug;

export interface ResolvedDelegatedProvider {
  readonly instance: ServerProvider;
  readonly requestedModel?: string;
  /** Undefined only when the instance advertises no models at all. */
  readonly resolvedModel?: string;
  readonly requestedOptions?: ProviderOptionSelections;
  readonly resolvedOptions?: ProviderOptionSelections;
  readonly resolvedOptionDetails?: ReadonlyArray<ResolvedProviderOption>;
  readonly modelSelection?: ModelSelection;
}

export type DelegatedProviderResolution =
  | { readonly ok: true; readonly value: ResolvedDelegatedProvider }
  | {
      readonly ok: false;
      readonly reasonCode: DelegationProviderReasonCode;
      readonly message: string;
    };

const failure = (
  reasonCode: DelegationProviderReasonCode,
  message: string,
): DelegatedProviderResolution => ({ ok: false, reasonCode, message });

export interface ResolveDelegatedProviderInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly provider: DelegatedRunProvider;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly model?: string | undefined;
  readonly options?: ProviderOptionSelections | undefined;
}

const validateOptions = (
  provider: DelegatedRunProvider,
  instance: ServerProvider,
  model: ServerProviderModel,
  selections: ProviderOptionSelections,
):
  | { readonly ok: true; readonly options: ProviderOptionSelections }
  | { readonly ok: false; readonly message: string } => {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      return {
        ok: false,
        message: `Option '${selection.id}' was requested more than once for model '${model.slug}'.`,
      };
    }
    seen.add(selection.id);
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (!descriptor) {
      const discoveryUnavailable =
        provider === "cursor" &&
        model.isCustom &&
        descriptors.length === 0 &&
        instance.models.every((candidate) => candidate.isCustom);
      return {
        ok: false,
        message: discoveryUnavailable
          ? `Capabilities for Cursor model '${model.slug}' could not be discovered. Retry when the Cursor provider is reachable.`
          : `Option '${selection.id}' is not available for model '${model.slug}'.`,
      };
    }
    if (descriptor.type === "boolean") {
      if (typeof selection.value !== "boolean") {
        return {
          ok: false,
          message: `Option '${selection.id}' for model '${model.slug}' requires a boolean value.`,
        };
      }
      continue;
    }
    const supported = descriptor.options.map((choice) => choice.id);
    if (typeof selection.value !== "string" || !supported.includes(selection.value)) {
      return {
        ok: false,
        message:
          `Option '${selection.id}' value '${String(selection.value)}' is not available for model '${model.slug}'.` +
          (supported.length > 0
            ? ` Supported values: ${supported.map((value) => `'${value}'`).join(", ")}.`
            : ""),
      };
    }
  }
  return { ok: true, options: selections };
};

export function resolveDelegatedProvider(
  input: ResolveDelegatedProviderInput,
): DelegatedProviderResolution {
  const driverKind = ProviderDriverKind.make(input.provider);
  const candidates = input.providers.filter((snapshot) => snapshot.driver === driverKind);

  let instance: ServerProvider;
  if (input.providerInstanceId !== undefined) {
    const exact = input.providers.find(
      (snapshot) => snapshot.instanceId === input.providerInstanceId,
    );
    if (!exact) {
      const known = candidates.map((snapshot) => `'${snapshot.instanceId}'`).join(", ");
      return failure(
        "provider_unavailable",
        `No provider instance '${input.providerInstanceId}' is configured.` +
          (known.length > 0 ? ` Configured ${input.provider} instances: ${known}.` : ""),
      );
    }
    if (exact.driver !== driverKind) {
      return failure(
        "explicit_constraint_mismatch",
        `Provider instance '${input.providerInstanceId}' is owned by driver '${exact.driver}', not '${input.provider}'.`,
      );
    }
    const reason = instanceUnusableReason(exact);
    if (reason !== undefined) {
      return failure(
        instanceUnusableReasonCode(exact),
        `Provider instance '${input.providerInstanceId}' cannot run delegated tasks: ${reason}`,
      );
    }
    instance = exact;
  } else {
    const usable = candidates.filter((snapshot) => instanceUnusableReason(snapshot) === undefined);
    if (usable.length === 0) {
      if (candidates.length === 0) {
        return failure(
          "provider_unavailable",
          `No ${input.provider} provider instance is configured.`,
        );
      }
      const reasons = candidates
        .map((snapshot) => `'${snapshot.instanceId}': ${instanceUnusableReason(snapshot)}`)
        .join(" ");
      return failure(
        candidates.some((candidate) => candidate.availability === "unavailable")
          ? "provider_unavailable"
          : candidates.some((candidate) => !candidate.enabled)
            ? "provider_disabled"
            : candidates.some((candidate) => !candidate.installed)
              ? "provider_uninstalled"
              : "provider_unavailable",
        `No ${input.provider} provider instance can run delegated tasks. ${reasons}`,
      );
    }
    const defaultId = defaultInstanceIdForDriver(driverKind);
    instance =
      usable.find((snapshot) => snapshot.instanceId === defaultId) ??
      [...usable].sort(compareInstanceIds)[0]!;
  }

  let requestedModel: string | undefined;
  let resolvedModel: ServerProviderModel | undefined;
  if (input.model !== undefined) {
    const requested = input.model.trim();
    const match =
      instance.models.find((model) => model.slug === requested) ??
      instance.models.find((model) => model.slug.toLowerCase() === requested.toLowerCase()) ??
      instance.models.find((model) => model.name.toLowerCase() === requested.toLowerCase());
    if (!match) {
      const supported = instance.models.map((model) => `'${model.slug}'`).join(", ");
      return failure(
        "model_unavailable",
        `Model '${requested}' is not available on provider instance '${instance.instanceId}'.` +
          (supported.length > 0
            ? ` Supported models: ${supported}.`
            : " The instance advertises no models."),
      );
    }
    requestedModel = requested;
    resolvedModel = match;
  } else {
    resolvedModel = instance.models[0];
  }
  if (input.options !== undefined && !resolvedModel) {
    return failure(
      "model_unavailable",
      `Provider instance '${instance.instanceId}' advertises no model whose options can be validated.`,
    );
  }
  const descriptors = resolvedModel?.capabilities?.optionDescriptors ?? [];
  const normalizedOptions =
    input.options !== undefined && input.provider === "codex"
      ? normalizeCodexDelegatedOptions(input.options, descriptors)
      : input.options !== undefined
        ? ({ ok: true, options: input.options } as const)
        : undefined;
  if (normalizedOptions && !normalizedOptions.ok) {
    return failure("model_unavailable", normalizedOptions.message);
  }
  const optionResolution =
    normalizedOptions !== undefined && resolvedModel
      ? validateOptions(input.provider, instance, resolvedModel, normalizedOptions.options)
      : undefined;
  if (optionResolution && !optionResolution.ok) {
    return failure("model_unavailable", optionResolution.message);
  }
  const validatedOptions = optionResolution?.options;
  let resolvedOptions = validatedOptions;
  if (input.provider === "codex" && resolvedModel) {
    const tierDescriptors = getProviderOptionDescriptors({
      caps: resolvedModel.capabilities ?? {},
      selections: validatedOptions,
    }).filter((descriptor) => descriptor.id === "serviceTier");
    const effectiveTier = buildProviderOptionSelectionsFromDescriptors(tierDescriptors)?.[0];
    if (
      effectiveTier !== undefined &&
      !validatedOptions?.some((selection) => selection.id === "serviceTier")
    ) {
      resolvedOptions = [...(validatedOptions ?? []), effectiveTier];
    }
  }
  const resolvedOptionDetails = buildResolvedProviderOptionDetails({
    descriptors,
    selections: resolvedOptions,
  });
  const modelSelection = resolvedModel
    ? {
        instanceId: instance.instanceId,
        model: resolvedModel.slug,
        ...(resolvedOptions !== undefined ? { options: resolvedOptions } : {}),
      }
    : undefined;
  return {
    ok: true,
    value: {
      instance,
      ...(requestedModel !== undefined ? { requestedModel } : {}),
      ...(resolvedModel !== undefined ? { resolvedModel: resolvedModel.slug } : {}),
      ...(input.options !== undefined ? { requestedOptions: input.options } : {}),
      ...(resolvedOptions !== undefined ? { resolvedOptions } : {}),
      ...(resolvedOptionDetails !== undefined ? { resolvedOptionDetails } : {}),
      ...(modelSelection !== undefined ? { modelSelection } : {}),
    },
  };
}

export interface DescribeDelegatedProviderCapabilitiesInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly provider: DelegatedRunProvider;
  readonly supportsCancellation: boolean;
  readonly supportsQuestions: boolean;
}

export function describeDelegatedProviderCapabilities(
  input: DescribeDelegatedProviderCapabilitiesInput,
): DelegatedRunCapabilities {
  const driverKind = ProviderDriverKind.make(input.provider);
  const candidates = input.providers.filter((snapshot) => snapshot.driver === driverKind);
  const instances: DelegatedProviderInstanceCapability[] = candidates.map((snapshot) => {
    const reason = instanceUnusableReason(snapshot);
    const defaultModel = defaultModelForInstance(snapshot);
    return {
      providerInstanceId: snapshot.instanceId,
      displayName: instanceDisplayName(snapshot),
      available: reason === undefined,
      ...(reason !== undefined ? { reason } : {}),
      models: snapshot.models.map((model) => model.slug),
      modelDetails: snapshot.models.map((model) => ({
        model: model.slug,
        displayName: model.name,
        options: [...(model.capabilities?.optionDescriptors ?? [])],
      })),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
    };
  });
  const available = instances.some((instance) => instance.available);
  const reason = available
    ? undefined
    : candidates.length === 0
      ? `No ${input.provider} provider instance is configured.`
      : `No ${input.provider} provider instance can run delegated tasks.`;
  return {
    provider: input.provider,
    available,
    ...(reason !== undefined ? { reason } : {}),
    instances,
    supportsCancellation: input.supportsCancellation,
    supportsQuestions: input.supportsQuestions,
  };
}
