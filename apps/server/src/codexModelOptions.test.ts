import { assert, it } from "@effect/vitest";

import { ProviderInstanceId, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCodexServiceTierOptionValue,
  normalizeCodexDelegatedOptions,
} from "./codexModelOptions.ts";

const serviceTierDescriptor: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Service Tier",
  type: "select",
  options: [
    { id: "default", label: "Standard", isDefault: true },
    { id: "priority", label: "Fast" },
    { id: "flex", label: "Flex" },
  ],
  currentValue: "default",
};

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});

it("canonicalizes supported legacy Fast aliases", () => {
  assert.deepStrictEqual(
    normalizeCodexDelegatedOptions([{ id: "fastMode", value: true }], [serviceTierDescriptor]),
    { ok: true, options: [{ id: "serviceTier", value: "priority" }] },
  );
  assert.deepStrictEqual(
    normalizeCodexDelegatedOptions([{ id: "serviceTier", value: "fast" }], [serviceTierDescriptor]),
    { ok: true, options: [{ id: "serviceTier", value: "priority" }] },
  );
});

it("removes legacy fastMode=false so the catalog default remains authoritative", () => {
  assert.deepStrictEqual(
    normalizeCodexDelegatedOptions([{ id: "fastMode", value: false }], [serviceTierDescriptor]),
    { ok: true, options: [] },
  );
});

it("rejects mixed and ambiguous legacy Fast aliases", () => {
  assert.equal(
    normalizeCodexDelegatedOptions(
      [
        { id: "fastMode", value: true },
        { id: "serviceTier", value: "priority" },
      ],
      [serviceTierDescriptor],
    ).ok,
    false,
  );
  assert.equal(
    normalizeCodexDelegatedOptions(
      [{ id: "fastMode", value: true }],
      [
        {
          ...serviceTierDescriptor,
          options: [
            { id: "priority", label: "Fast" },
            { id: "fast", label: "Accelerated" },
          ],
        },
      ],
    ).ok,
    false,
  );
});
