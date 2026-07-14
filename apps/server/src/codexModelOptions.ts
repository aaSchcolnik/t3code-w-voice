import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelections,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}

export type CodexDelegatedOptionsNormalization =
  | { readonly ok: true; readonly options: ProviderOptionSelections }
  | { readonly ok: false; readonly message: string };

/** Canonicalizes only legacy Codex speed aliases against the selected model catalog. */
export function normalizeCodexDelegatedOptions(
  selections: ProviderOptionSelections,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): CodexDelegatedOptionsNormalization {
  const fastModeSelections = selections.filter((selection) => selection.id === "fastMode");
  const serviceTierSelections = selections.filter((selection) => selection.id === "serviceTier");

  if (fastModeSelections.length > 1 || serviceTierSelections.length > 1) {
    const duplicatedId = fastModeSelections.length > 1 ? "fastMode" : "serviceTier";
    return { ok: false, message: `Option '${duplicatedId}' was requested more than once.` };
  }
  if (fastModeSelections.length > 0 && serviceTierSelections.length > 0) {
    return {
      ok: false,
      message: "Codex options 'fastMode' and 'serviceTier' cannot be supplied together.",
    };
  }

  const legacyFastMode = fastModeSelections[0];
  const requestedServiceTier = serviceTierSelections[0];
  const needsFastTarget =
    legacyFastMode?.value === true ||
    (requestedServiceTier?.value === "fast" &&
      !descriptors.some(
        (descriptor) =>
          descriptor.id === "serviceTier" &&
          descriptor.type === "select" &&
          descriptor.options.some((choice) => choice.id === "fast"),
      ));

  if (legacyFastMode && typeof legacyFastMode.value !== "boolean") {
    return { ok: false, message: "Legacy Codex option 'fastMode' requires a boolean value." };
  }
  if (!needsFastTarget) {
    return {
      ok: true,
      options: selections.filter((selection) => selection.id !== "fastMode"),
    };
  }

  const serviceTierDescriptor = descriptors.find(
    (descriptor) => descriptor.id === "serviceTier" && descriptor.type === "select",
  );
  const fastChoices =
    serviceTierDescriptor?.type === "select"
      ? serviceTierDescriptor.options.filter(
          (choice) =>
            choice.id === "fast" ||
            choice.id === "priority" ||
            choice.label.trim().toLowerCase() === "fast",
        )
      : [];
  if (fastChoices.length !== 1) {
    return {
      ok: false,
      message:
        fastChoices.length === 0
          ? "The selected Codex model does not advertise a tier matching legacy Fast mode."
          : "The selected Codex model advertises multiple tiers matching legacy Fast mode; use a canonical serviceTier value.",
    };
  }

  return {
    ok: true,
    options: [
      ...selections.filter(
        (selection) => selection.id !== "fastMode" && selection.id !== "serviceTier",
      ),
      { id: "serviceTier", value: fastChoices[0]!.id },
    ],
  };
}
