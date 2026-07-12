# Delegated subagent model options — implementation plan

Date: 2026-07-12  
Status: Implemented

## Goal

Allow a caller of the built-in Codex and Cursor delegation MCP tools to select a
specific model and its supported provider-defined options, including reasoning
effort. The system must validate the requested configuration against the live
provider catalog, propagate it through session startup and turn execution, and
record what actually ran.

This enables requests such as:

```json
{
  "task": "Investigate the production incident and return a root-cause analysis.",
  "model": "gpt-5.5",
  "options": [{ "id": "reasoningEffort", "value": "high" }]
}
```

The model ID remains `gpt-5.5`. `high` is an option, not part of the model ID.

## Problem statement

`codex_start` currently accepts a model string but not provider options. The
delegated-run service validates and resolves that model, then creates a
`ModelSelection` containing only the instance and model. It also calls
`ProviderService.sendTurn` without a `modelSelection`.

Codex reads `reasoningEffort` from the turn's model selection. Consequently,
accepting a model name such as `gpt-5.5 high` correctly fails model validation,
while retrying with `gpt-5.5` does not explicitly configure high reasoning.

The same structural limitation applies to Cursor, whose reasoning setting is
provider-specific (`reasoning`) rather than Codex's `reasoningEffort`. Cursor
model capabilities are discovered live over ACP from each model's
`configOptions` (`buildCursorCapabilitiesFromConfigOptions` in
`CursorProvider.ts`), so a Cursor-hosted Anthropic or OpenAI model that exposes
an effort/reasoning config option will advertise a `reasoning` descriptor
automatically — no Cursor-specific handling is needed beyond the generic
options path.

The full inventory of options advertised today (all flow through the same
generic `optionDescriptors` mechanism, so the design below covers them all):

- Codex: `reasoningEffort` (select), `serviceTier` (select).
- Cursor: `reasoning` (select), `contextWindow` (select), `fastMode`
  (boolean), `thinking` (boolean).

Beyond model options, `DelegatedRunService.start` also hard-codes other
per-run inputs the provider contract already accepts: `approvalPolicy:
"never"`, `sandboxMode: "workspace-write"`, `runtimeMode: "full-access"` at
session start, and `interactionMode: "default"`, `attachments: []` at turn
start. These are addressed in Phase 5 so that, over time, every input the
provider contract can carry per run becomes overridable through the MCP tools.

## Design principles

1. A delegated execution configuration is **provider instance + model +
   provider options**, not a model string alone.
2. Reuse the existing `ModelSelection` and `ProviderOptionSelections`
   contracts. Do not create a Codex-only top-level `reasoningEffort` field.
3. Validate option IDs and values against the selected model's live advertised
   capabilities. Never silently ignore unsupported configuration.
4. Preserve the complete validated selection at every execution boundary:
   resolver, session startup, and turn start.
5. Store both the caller's request and the actual resolved configuration for
   auditability and reliable UI presentation.
6. Keep the contract provider-neutral and forward-extensible: any per-run
   input the provider contract accepts (`ProviderSessionStartInput`,
   `ProviderSendTurnInput`) should be expressible through the delegation MCP
   contract without a provider-specific field, so future levers (interaction
   mode, sandbox/runtime policy, attachments) slot into the same shape.

## Proposed MCP contract

Extend `DelegatedRunStartInput` with provider-neutral option selections:

```ts
export const DelegatedRunStartInput = Schema.Struct({
  task: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
```

The provider-specific MCP tool fixes the provider (`codex_start` fixes
`codex`, `cursor_start` fixes `cursor`), while `model` and `options` remain
generic.

Examples:

```json
// Codex
{
  "model": "gpt-5.5",
  "options": [{ "id": "reasoningEffort", "value": "high" }],
  "task": "Review the architecture."
}
```

```json
// Cursor; the exact valid value must come from its advertised capabilities
{
  "model": "composer-2.5",
  "options": [{ "id": "reasoning", "value": "high" }],
  "task": "Review the architecture."
}
```

## Phase 1 — Extend contracts and preserve request data

**Files:**

- `packages/contracts/src/delegatedRun.ts`
- `packages/contracts/src/index.ts`, if required by exports
- Contract tests

1. Add optional `options: ProviderOptionSelections` to
   `DelegatedRunStartInput`.
2. Add optional `requestedOptions` and `resolvedOptions` to `DelegatedRun`, or
   replace the existing separate model fields with explicit
   `requestedModelSelection` and `resolvedModelSelection` if migration scope is
   acceptable.
3. Keep `requestedModel` and `resolvedModel` during the transition so existing
   persisted runs and panel consumers remain compatible.
4. Confirm schema decoding remains backward compatible for records written
   before options existed.
5. `ProviderOptionSelections` already accepts both the canonical array form
   and a legacy object form (`Record<string, string | boolean>`), normalizing
   to the array (`packages/contracts/src/model.ts`). Reusing it means MCP
   callers get that coercion for free — cover both shapes in the tool-schema
   tests so an LLM caller sending the object form still works.

### Acceptance

Both MCP tool schemas expose `options`, and an existing caller that sends only
`model` continues to decode and execute unchanged.

## Phase 2 — Resolve and validate a complete model selection

**Files:**

- `apps/server/src/provider/DelegatedProviderResolver.ts`
- `apps/server/src/provider/DelegatedProviderResolver.test.ts`
- Shared model-selection helpers, only if a genuinely reusable validation
  helper is warranted

Update `resolveDelegatedProvider` to accept requested options and return a
complete, validated `ModelSelection`:

```ts
interface ResolvedDelegatedProvider {
  readonly instance: ServerProvider;
  readonly requestedModel?: string;
  readonly resolvedModel?: string;
  readonly modelSelection?: ModelSelection;
}
```

Validation must:

1. Resolve the provider instance and model as it does today.
2. Find the resolved `ServerProviderModel` and inspect
   `model.capabilities.optionDescriptors`.
3. Reject an option ID not advertised by that model.
4. For a select option, reject a requested value not present in its choices.
5. For a boolean option, reject a non-boolean value.
6. Reject duplicate option IDs in a single request rather than letting one
   silently win.
7. Return errors that name the model, option, and supported values where
   available.
8. Cursor edge case: when the Cursor CLI is unreachable, fallback models come
   from user `customModels` and advertise **no** option descriptors
   (`EMPTY_CAPABILITIES` in `CursorProvider.ts`). Any option request against
   such a model must fail with a message that says capabilities could not be
   discovered — not "option unsupported" — so the caller knows to retry when
   the provider is reachable rather than dropping the option.
9. Build the returned `ModelSelection` with `instanceId` set to the resolved
   instance's ID. Both adapters ignore a `modelSelection` whose `instanceId`
   does not match their bound instance, so a mismatch here silently discards
   the entire configuration.

Suggested error:

```text
Reasoning option 'xhigh' is not available for Codex model 'gpt-5.5'.
Supported values: 'low', 'medium', 'high'.
```

Do not normalize an invalid value to a default. That would make an orchestration
policy appear to have run with a specified reasoning level when it did not.

### Acceptance

The resolver returns a canonical selection containing the resolved instance,
model slug, and validated options, or it fails before a child session starts.

## Phase 3 — Propagate the selection through execution

**Files:**

- `apps/server/src/orchestration/DelegatedRunService.ts`
- `apps/server/src/orchestration/DelegatedRunService.test.ts`

Replace the model-only session setup with the resolver's complete selection:

```ts
yield *
  providerService.startSession(providerThreadId, {
    // existing fields
    modelSelection: resolution.value.modelSelection,
  });
```

Pass the same selection when starting the first turn:

```ts
yield *
  providerService.sendTurn({
    threadId: providerThreadId,
    input: input.task,
    attachments: [],
    interactionMode: "default",
    modelSelection: resolution.value.modelSelection,
  });
```

This second propagation is required: the Codex adapter obtains
`reasoningEffort` (and `serviceTier`) from the `sendTurn` model selection and
forwards them into the `turn/start` request — session startup alone is not
enough to guarantee reasoning configuration for the delegated turn. Cursor
re-applies session configuration on every prompt via
`applyRequestedSessionConfiguration`, mapping `reasoning` / `contextWindow` /
`fastMode` / `thinking` selections to ACP `session/set_config_option` calls,
so it also benefits from receiving the selection at both boundaries.

Persist and expose the requested and resolved options alongside the existing
model metadata in the run result and transcript registration.

### Acceptance

A Codex delegated run requested with `reasoningEffort: high` reaches Codex's
turn-start request with `effort: high`. Cursor selections similarly reach its
ACP configuration path.

## Phase 4 — Describe model-specific options in capability tools

**Files:**

- `packages/contracts/src/delegatedRun.ts`
- `apps/server/src/provider/DelegatedProviderResolver.ts`
- `apps/server/src/mcp/toolkits/codexAgent/*`
- `apps/server/src/mcp/toolkits/cursorAgent/*`
- Capability tests

Current capabilities report model names. Expand them to report the selectable
options for each advertised model. Prefer a delegation-specific public schema,
instead of exposing all internal server-provider fields unchanged:

```ts
interface DelegatedProviderModelCapability {
  readonly model: string;
  readonly displayName: string;
  readonly options: ReadonlyArray<ProviderOptionDescriptor>;
}
```

Two concrete gaps to close here:

1. **Codex has no capabilities tool today.** Only `cursor_capabilities`
   exists; the codexAgent toolkit exposes `codex_start/status/result/cancel`
   only. Add `codex_capabilities` with the same shape so an orchestrator can
   discover Codex reasoning levels and service tiers before starting a run.
2. **Keep the schema change additive.** `DelegatedRunCapabilities.instances[]`
   currently carries `models: string[]` and `defaultModel`, which existing
   callers parse. Add a new `modelDetails: DelegatedProviderModelCapability[]`
   field alongside `models` rather than changing the existing field's type.

An orchestrator must call capability discovery—or use a known validated
profile—before choosing an option. Reasoning levels are model-dependent and may
change when a provider updates its model catalog.

### Acceptance

An MCP client can discover whether `gpt-5.5` supports `high` reasoning without
guessing model IDs or option values.

## Phase 5 — Execution-behavior overrides (optional, deferred)

Model + options is the priority; this phase exists so the remaining per-run
inputs land in the same contract instead of ad-hoc fields later. Implement
after Phases 1–4 are proven, or on demand.

The provider contract already accepts, per run, everything below — delegated
runs simply hard-code them in `DelegatedRunService.start`:

| Input            | Contract field                             | Hard-coded today    |
| ---------------- | ------------------------------------------ | ------------------- |
| Interaction mode | `ProviderSendTurnInput.interactionMode`    | `"default"`         |
| Approval policy  | `ProviderSessionStartInput.approvalPolicy` | `"never"`           |
| Sandbox mode     | `ProviderSessionStartInput.sandboxMode`    | `"workspace-write"` |
| Runtime mode     | `ProviderSessionStartInput.runtimeMode`    | `"full-access"`     |
| Attachments      | `ProviderSendTurnInput.attachments`        | `[]`                |

1. Add optional `interactionMode: "default" | "plan"` to
   `DelegatedRunStartInput` first — a plan-mode subagent is the most useful
   and lowest-risk of these overrides.
2. Sandbox/approval/runtime overrides are security-relevant: a delegated run
   currently always gets `full-access`/`workspace-write` with approvals
   disabled. If exposed, they should only permit **tightening** (e.g.
   `read-only` sandbox for a review subagent), never loosening beyond the
   defaults, and the applied values must be persisted on the run record like
   options are.
3. Custom instructions and environment variables are **not** per-run fields
   in the provider contract (`ProviderSessionStartInput` /
   `ProviderSendTurnInput` have no such fields; Codex developer instructions
   come from MCP session delegation config, and `environment` is an
   adapter-construction option). Exposing them requires extending the
   provider contract itself first — out of scope here, but the
   `DelegatedRunStartInput` shape should not preclude it.

### Acceptance

A caller can start a plan-mode Cursor subagent or a read-only-sandbox review
subagent, and the run record shows the modes that actually applied.

## Phase 6 — Add named delegation profiles

This phase is intentionally separate from the low-level MCP contract. Implement
it only after explicit selections are validated and proven end-to-end.

Define persisted, named profiles such as:

```json
{
  "id": "deep-research",
  "provider": "codex",
  "providerInstanceId": "codex",
  "model": "gpt-5.5",
  "options": [{ "id": "reasoningEffort", "value": "high" }]
}
```

Profiles provide repeatability and central policy control; explicit selections
remain necessary for low-level integrations and exceptional runs.

Choose one unambiguous rule before adding profile support:

- **Recommended:** reject a request that combines `profile` with explicit
  model/options.
- Alternative: allow explicit fields to override profile fields. This is more
  flexible but makes policy enforcement and audit trails harder.

Profile resolution must rerun live capability validation. A stored profile is a
desired configuration, not proof that the provider still supports it.

## Test matrix

- Codex: `gpt-5.5` with `reasoningEffort: high` is accepted and reaches the
  provider turn request.
- Codex: unsupported reasoning effort is rejected with supported alternatives.
- Unknown option IDs are rejected.
- An option supported by one model but not the selected model is rejected.
- Boolean options validate type correctly (Cursor `fastMode`, `thinking`).
- Codex: `serviceTier` selection reaches the turn request alongside
  `reasoningEffort`.
- Cursor: advertised reasoning option is preserved and mapped to ACP config
  (`session/set_config_option`), including for Cursor-hosted Anthropic/OpenAI
  models that advertise an effort config option.
- Cursor: an option request against a fallback (offline-discovered) model
  fails with a capabilities-unavailable message, not a silent drop.
- Duplicate option IDs in one request are rejected.
- Legacy object-form `options` (`{"reasoningEffort": "high"}`) decodes to the
  canonical array form through the MCP tool schema.
- The resolver's `ModelSelection.instanceId` matches the resolved instance so
  adapters do not silently discard the selection.
- Model-only starts retain present behavior and default options.
- Resolved options survive delegated-run persistence, status/result responses,
  and transcript metadata.
- Capability tools expose model-specific selectable options, including the
  new `codex_capabilities` tool; existing `models: string[]` consumers keep
  working.
- A stale profile with an unavailable model or option fails before execution.

## Verification

For each implementation phase, run targeted tests first. Before declaring the
work complete, run the repository-required checks:

```sh
vp check
vp run typecheck
```

No mobile code is planned; `vp run lint:mobile` is therefore not required.

## Non-goals

- Encoding effort inside a model ID (for example, `gpt-5.5 high`).
- Silently falling back to a different model or reasoning level.
- Hard-coding a universal list of reasoning levels; providers advertise their
  own capabilities.
- Adding profile persistence before the underlying explicit-selection path is
  validated end-to-end.
