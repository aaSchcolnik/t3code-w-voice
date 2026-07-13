import {
  type EngineDelegationRole,
  type EngineDelegationTarget,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { type ProviderInstanceEntry } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const AUTOMATIC_INSTANCE = "__automatic_instance__";
const PROVIDER_DEFAULT_MODEL = "__provider_default_model__";
const DEFAULT_REASONING = "__default_reasoning__";
const delegationTargetKeys = new WeakMap<object, string>();
const modelPreferenceKeys = new WeakMap<object, string>();
let nextDelegationTargetKey = 0;

const delegationTargetKey = (target: EngineDelegationTarget): string => {
  const existing = delegationTargetKeys.get(target);
  if (existing !== undefined) return existing;
  const key = `delegation-target-${nextDelegationTargetKey++}`;
  delegationTargetKeys.set(target, key);
  return key;
};

const modelPreferenceKey = (selection: ModelSelection): string => {
  const existing = modelPreferenceKeys.get(selection);
  if (existing !== undefined) return existing;
  const key = `scan-model-preference-${nextDelegationTargetKey++}`;
  modelPreferenceKeys.set(selection, key);
  return key;
};

function targetAvailability(
  target: EngineDelegationTarget,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): { readonly available: boolean; readonly reason?: string | undefined } {
  if (target.provider === "inline") return { available: true };
  const candidates = entries.filter(
    (entry) =>
      entry.driverKind === target.provider &&
      (target.providerInstanceId === undefined || entry.instanceId === target.providerInstanceId),
  );
  if (candidates.length === 0) {
    return {
      available: false,
      reason:
        target.providerInstanceId === undefined
          ? `No ${target.provider} provider is configured.`
          : `Provider instance '${target.providerInstanceId}' is not configured for ${target.provider}.`,
    };
  }
  if (candidates.some((entry) => entry.enabled && entry.installed && entry.isAvailable)) {
    return { available: true };
  }
  return { available: false, reason: "The configured provider is disabled or unavailable." };
}

const replaceTarget = (
  chain: ReadonlyArray<EngineDelegationTarget>,
  index: number,
  target: EngineDelegationTarget,
): ReadonlyArray<EngineDelegationTarget> =>
  chain.map((entry, entryIndex) => (entryIndex === index ? target : entry));

export function ChainEditor({
  chain,
  providerEntries,
  onChange,
  role,
}: {
  chain: ReadonlyArray<EngineDelegationTarget>;
  providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  onChange: (chain: ReadonlyArray<EngineDelegationTarget>) => void;
  role: EngineDelegationRole;
}) {
  return (
    <FieldGroup className="w-full gap-3">
      {chain.map((target, index) => {
        const availability = targetAvailability(target, providerEntries);
        const matchingEntries = providerEntries.filter(
          (entry) => entry.driverKind === target.provider,
        );
        const instanceItems = [
          { value: AUTOMATIC_INSTANCE, label: `Automatic ${target.provider} instance` },
          ...matchingEntries.map((entry) => ({
            value: entry.instanceId,
            label: entry.displayName,
          })),
        ];
        const models = new Map<string, string>();
        for (const entry of matchingEntries) {
          if (
            target.providerInstanceId !== undefined &&
            entry.instanceId !== target.providerInstanceId
          ) {
            continue;
          }
          for (const model of entry.models) models.set(model.slug, model.name);
        }
        if (target.model !== undefined && !models.has(target.model)) {
          models.set(target.model, target.model);
        }
        const modelItems = [
          { value: PROVIDER_DEFAULT_MODEL, label: "Provider default" },
          ...[...models].map(([value, label]) => ({ value, label })),
        ];
        const reasoning = target.options?.find(({ id }) => id === "reasoningEffort")?.value;

        return (
          <Field
            key={delegationTargetKey(target)}
            data-disabled={!availability.available || undefined}
            className="w-full rounded-xl border bg-background/50 p-3"
          >
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant={availability.available ? "success" : "secondary"}>
                  {index + 1}
                </Badge>
                <span className="truncate text-xs text-muted-foreground">
                  {availability.available ? "Available" : availability.reason}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={`Move delegation target ${index + 1} up`}
                  onClick={() => {
                    const next = [...chain];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    onChange(next);
                  }}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={index === chain.length - 1}
                  aria-label={`Move delegation target ${index + 1} down`}
                  onClick={() => {
                    const next = [...chain];
                    [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                    onChange(next);
                  }}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove delegation target ${index + 1}`}
                  onClick={() => onChange(chain.filter((_, entryIndex) => entryIndex !== index))}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
            <div className="grid w-full gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Provider</FieldLabel>
                <Select
                  items={[
                    { value: "inline", label: "Inline" },
                    { value: "cursor", label: "Cursor" },
                    { value: "codex", label: "Codex" },
                  ]}
                  value={target.provider}
                  onValueChange={(provider) => {
                    if (provider !== "inline" && provider !== "cursor" && provider !== "codex")
                      return;
                    onChange(replaceTarget(chain, index, { provider }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      <SelectItem value="inline">Inline</SelectItem>
                      <SelectItem value="cursor">Cursor</SelectItem>
                      <SelectItem value="codex">Codex</SelectItem>
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Provider instance</FieldLabel>
                <Select
                  items={instanceItems}
                  disabled={target.provider === "inline"}
                  value={target.providerInstanceId ?? AUTOMATIC_INSTANCE}
                  onValueChange={(providerInstanceId) => {
                    if (providerInstanceId === null) return;
                    onChange(
                      replaceTarget(chain, index, {
                        ...target,
                        ...(providerInstanceId === AUTOMATIC_INSTANCE
                          ? { providerInstanceId: undefined }
                          : { providerInstanceId: ProviderInstanceId.make(providerInstanceId) }),
                      }),
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      {instanceItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Model</FieldLabel>
                <Select
                  items={modelItems}
                  value={target.model ?? PROVIDER_DEFAULT_MODEL}
                  onValueChange={(model) => {
                    if (model === null) return;
                    onChange(
                      replaceTarget(chain, index, {
                        ...target,
                        ...(model === PROVIDER_DEFAULT_MODEL ? { model: undefined } : { model }),
                      }),
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      {modelItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </Field>
              <Field data-disabled={target.provider !== "codex" || undefined}>
                <FieldLabel>Reasoning effort</FieldLabel>
                <Select
                  items={[
                    { value: DEFAULT_REASONING, label: "Model default" },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "xhigh", label: "Extra high" },
                  ]}
                  disabled={target.provider !== "codex"}
                  value={typeof reasoning === "string" ? reasoning : DEFAULT_REASONING}
                  onValueChange={(value) => {
                    if (value === null) return;
                    const remaining = (target.options ?? []).filter(
                      ({ id }) => id !== "reasoningEffort",
                    );
                    const options =
                      value === DEFAULT_REASONING
                        ? remaining
                        : [...remaining, { id: "reasoningEffort", value }];
                    onChange(
                      replaceTarget(chain, index, {
                        ...target,
                        options: options.length === 0 ? undefined : options,
                      }),
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      <SelectItem value={DEFAULT_REASONING}>Model default</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="xhigh">Extra high</SelectItem>
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            {role === "consensus" ? (
              <Field>
                <FieldLabel htmlFor={`consensus-focus-${index}`}>Focus lens</FieldLabel>
                <Input
                  id={`consensus-focus-${index}`}
                  value={target.focus ?? ""}
                  placeholder="Hidden risks and implementation complexity"
                  onChange={(event) =>
                    onChange(
                      replaceTarget(chain, index, {
                        ...target,
                        focus: event.target.value.trim() === "" ? undefined : event.target.value,
                      }),
                    )
                  }
                />
                <FieldDescription>
                  Optional perspective that differentiates this panelist's analysis.
                </FieldDescription>
              </Field>
            ) : null}
          </Field>
        );
      })}
      <Button
        className="self-start"
        size="xs"
        variant="outline"
        onClick={() => onChange([...chain, { provider: "codex" }])}
      >
        <PlusIcon data-icon="inline-start" />
        {role === "consensus"
          ? "Add panelist"
          : role === "scanner"
            ? "Add scanner"
            : "Add fallback"}
      </Button>
    </FieldGroup>
  );
}

export function ModelPreferenceEditor({
  preference,
  providerEntries,
  onChange,
}: {
  preference: ReadonlyArray<ModelSelection>;
  providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  onChange: (preference: ReadonlyArray<ModelSelection>) => void;
}) {
  return (
    <FieldGroup className="w-full gap-3">
      {preference.map((selection, index) => {
        const instance = providerEntries.find((entry) => entry.instanceId === selection.instanceId);
        const models = instance?.models ?? [];
        return (
          <Field
            key={modelPreferenceKey(selection)}
            className="w-full rounded-xl border bg-background/50 p-3"
          >
            <div className="flex w-full items-center justify-between gap-2">
              <Badge variant={instance?.enabled && instance.isAvailable ? "success" : "secondary"}>
                {index + 1}
              </Badge>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={`Move scan model preference ${index + 1} up`}
                  onClick={() => {
                    const next = [...preference];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    onChange(next);
                  }}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={index === preference.length - 1}
                  aria-label={`Move scan model preference ${index + 1} down`}
                  onClick={() => {
                    const next = [...preference];
                    [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                    onChange(next);
                  }}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove scan model preference ${index + 1}`}
                  onClick={() =>
                    onChange(preference.filter((_, entryIndex) => entryIndex !== index))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
            <div className="grid w-full gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Provider instance</FieldLabel>
                <Select
                  items={providerEntries.map((entry) => ({
                    value: entry.instanceId,
                    label: entry.displayName,
                  }))}
                  value={selection.instanceId}
                  onValueChange={(instanceId) => {
                    if (instanceId === null) return;
                    const nextInstance = providerEntries.find(
                      (entry) => entry.instanceId === instanceId,
                    );
                    const nextModel = nextInstance?.models[0]?.slug ?? selection.model;
                    onChange(
                      preference.map((entry, entryIndex) =>
                        entryIndex === index
                          ? { instanceId: ProviderInstanceId.make(instanceId), model: nextModel }
                          : entry,
                      ),
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      {providerEntries.map((entry) => (
                        <SelectItem key={entry.instanceId} value={entry.instanceId}>
                          {entry.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Model</FieldLabel>
                <Select
                  items={models.map((model) => ({ value: model.slug, label: model.name }))}
                  value={selection.model}
                  onValueChange={(model) => {
                    if (model === null) return;
                    onChange(
                      preference.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, model } : entry,
                      ),
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      {models.map((model) => (
                        <SelectItem key={model.slug} value={model.slug}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </Field>
            </div>
          </Field>
        );
      })}
      <Button
        className="self-start"
        size="xs"
        variant="outline"
        disabled={providerEntries.length === 0}
        onClick={() => {
          const instance =
            providerEntries.find((entry) => entry.enabled && entry.isAvailable) ??
            providerEntries[0];
          const model = instance?.models[0]?.slug;
          if (instance && model)
            onChange([...preference, { instanceId: instance.instanceId, model }]);
        }}
      >
        <PlusIcon data-icon="inline-start" />
        Add model preference
      </Button>
    </FieldGroup>
  );
}
