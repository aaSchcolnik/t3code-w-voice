# Claude Headless Delegated Subagent

**Branch:** `subagents-and-mcps` · **Status:** Planned · **Date:** 2026-07-12

Add Claude (via Claude Code headless mode, subscription-billed) as a third delegated
subagent provider alongside Cursor and Codex, selectable from any skill/engine role with
the full Anthropic model catalog and per-model reasoning levels.

All file/line references below were verified against the working tree on
`subagents-and-mcps` (two exploration passes + a 5-agent adversarial verification pass).

## Key architectural facts (verified)

1. **Delegation never spawns CLIs directly.** `DelegatedRunService.start` routes through
   the generic `providerService.startSession`/`sendTurn`
   (`apps/server/src/orchestration/DelegatedRunService.ts:700-716`) — the same
   `ProviderAdapterShape` interface `ClaudeAdapter` already implements. Cursor and Codex
   subagents work this way too.
2. **ClaudeAdapter is already headless and subscription-billed.** It uses
   `@anthropic-ai/claude-agent-sdk`'s `query()`, which spawns the local `claude` binary
   (`pathToClaudeCodeExecutable`, `ClaudeAdapter.ts:3786`) with the user's normal
   environment — no `ANTHROPIC_API_KEY` anywhere in server source. That is programmatic
   `claude -p`: same auth, same subscription. **No new driver or runtime is needed.**
3. **All models flow automatically.** `describeDelegatedProviderCapabilities`
   (`apps/server/src/provider/DelegatedProviderResolver.ts:241-262`) builds the model
   list and option descriptors generically from the live provider snapshot. Claude's
   catalog (`apps/server/src/provider/Layers/ClaudeProvider.ts:55-268`) enumerates all
   8 models — Fable 5, Opus 4.8/4.7/4.6/4.5, Sonnet 5, Sonnet 4.6, Haiku 4.5 — each with
   its per-model `effort` descriptor (low/medium/high/xhigh/max/ultracode/ultrathink
   where supported). Once the provider is allowed through the union, every model and
   reasoning level advertises itself to the MCP tools and settings dropdowns with zero
   hardcoding.
4. **Naming trap:** `DelegatedRunService` and the resolver coerce the delegated-provider
   literal _verbatim_ into a `ProviderDriverKind` (`DelegatedRunService.ts:702`,
   `DelegatedProviderResolver.ts:139,244`), and Claude's driver kind is **`"claudeAgent"`**,
   not `"claude"` (`apps/server/src/provider/Drivers/ClaudeDriver.ts:59`). The union
   value must therefore be `"claudeAgent"` — otherwise mapping code is needed at every
   coercion site.

## Phase 1 — Contracts (`packages/contracts/src`)

| File                           | Change                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegatedRun.ts:20`           | `DelegatedRunProvider = Schema.Literals(["codex", "cursor", "claudeAgent"])` — propagates to `DelegatedRun`, `DelegatedRunStartInput`, `DelegationProfile`, `DelegatedRunCapabilities`, `EngineDelegationTarget` |
| `settings.ts:246-247`          | Add `claudeAgent: Schema.Boolean` with decoding default `true` to `McpSettings`; mirror in the settings patch schema (~:906-909); merge in `resolveEffectiveMcpSettings` (~:313-314)                             |
| `projectMcpOverrides.ts:46-47` | Add `claudeAgent: Schema.optional(Schema.Boolean)` project override                                                                                                                                              |
| `settings.ts:252-260`          | Add a `claudeAgent` entry to `DELEGATION_SUBAGENT_MODEL_BY_PROVIDER` (suggested default: `claude-sonnet-5`)                                                                                                      |
| `previewAutomation.ts:611-623` | Add `"claude-agent"` to the `capability` literal union                                                                                                                                                           |

## Phase 2 — MCP layer (`apps/server/src/mcp`)

1. **`McpInvocationContext.ts:13-24`** — add `"claude-agent"` to `McpCapability`.
2. **`McpSessionRegistry.ts:161-169`** — grant it alongside the others:
   `if (!delegatedSession && effectiveMcp.claudeAgent && providerAvailable("claudeAgent")) capabilities.add("claude-agent")`.
   The existing `delegated-` prefix guard already prevents recursive delegation.
3. **New toolkit `toolkits/claudeAgent/`** — mirror `codexAgent/` exactly:
   - `tools.ts`: `claude_capabilities` (no params), `claude_start`
     (`DelegatedRunStartInput`), `claude_status` / `claude_result` / `claude_cancel`
     (`DelegatedRunLookupInput`).
   - `handlers.ts`: hardcode `provider: "claudeAgent"`, require the `claude-agent`
     capability, same `ownedRun` parent-thread ownership check.
   - Skip a `claude_respond` for v1 (see Phase 3).
4. **`McpHttpServer.ts:219-268`** — register `ClaudeAgentToolkitRegistrationLive` in the
   merged layer.
5. **`delegationPolicy.ts`** — extend `trackedDelegationInstructions` to tell parents to
   use `claude_start`, and `detectUntrackedDelegationAttempt` to catch shell `claude`
   with `-p`/`--print`. Deliberately **do not** add `subagent_type ^claude` detection
   (unlike codex/cursor) — it would false-positive on Claude's own legitimate native
   subagents.

## Phase 3 — Orchestration (`apps/server/src/orchestration`)

- **`DelegatedRunService.ts:753-763`** — `supportsQuestions: false` for `claudeAgent`
  initially (matching Codex; delegated runs default to `runtimeMode: full-access` →
  `bypassPermissions`, so the SDK won't raise permission prompts anyway). Everything
  else — event mapping, activity streaming, result awaiting, persistence — is
  provider-agnostic and works as-is.
- **Side fix while in there** (`ClaudeAdapter.ts` `handleSdkMessage` ~:3155): handle the
  SDK's `command_lifecycle` message type instead of letting it fall through to
  `emitRuntimeWarning` — otherwise delegated Claude runs that use background bash spray
  red-X warning rows into the parent Work Log.
- **Verified non-issue:** the fiber-lifetime bug that killed Codex delegation
  (`Effect.forkChild` pump dying with the short-lived delegated-run fiber) does _not_
  apply here — ClaudeAdapter forks its SDK stream with a detached `Effect.runForkWith`
  (`ClaudeAdapter.ts:3407, 3975-3993`), which survives the delegated-run fiber. The only
  `forkChild` (`:2847`) is a bounded 20×500ms MCP-status poller.

## Phase 4 — Web UI (`apps/web/src`)

1. **`components/settings/EngineDelegationSettings.tsx:178-186`** — add
   `{ value: "claudeAgent" }` to the provider dropdown items and the `onValueChange`
   guard.
2. **Same file, `:263-283` — the real UI work.** The "Reasoning effort" field is
   currently hardcoded: option id `reasoningEffort` with literal `low/medium/high/xhigh`
   values, disabled unless `provider === "codex"`. Rework it to be
   **descriptor-driven**: find the selected model in `instance.models`, read its
   `optionDescriptors`, and render the effort select from whichever descriptor exists
   (`effort` for Claude, `reasoningEffort` for Codex), writing back the matching option
   id. This automatically yields the correct per-model values (ultracode only on
   Fable 5 / Opus 4.8; no effort field at all on Haiku 4.5) and keeps Codex behavior
   identical.
3. **`components/settings/McpSettings.tsx:26, 95-102, 195-244`** — add `"claudeAgent"`
   to `McpBooleanKey`, derive `claudeAvailable` over `driverKind === "claudeAgent"`, and
   add a toggle row mirroring Codex/Cursor.
4. **Nothing else.** Verified: the Scan-configuration `ModelPreferenceEditor`,
   `SubagentsPanel`, `session-logic.ts`, provider icons and display names all resolve
   `claudeAgent` generically already (`PROVIDER_OPTIONS` at `session-logic.ts:52`,
   `PROVIDER_DISPLAY_NAMES`, `PROVIDER_ICON_BY_PROVIDER` all have Claude entries). A
   running Claude subagent renders with the right icon, label, model, and effort with no
   new cases.

## Phase 5 — Tests

- Mirror `codexAgent` handler tests for the new toolkit (capability gating, ownership,
  start→result flow with a fake `DelegatedRunService`).
- `McpSessionRegistry.test.ts`: `claude-agent` granted only when toggle on + provider
  available + non-delegated session.
- `DelegatedProviderResolver` cases: `claudeAgent` resolves the Claude instance; model
  validation accepts all catalog slugs; option validation accepts `effort: "xhigh"` on
  Fable 5 and rejects `effort` on Haiku 4.5.
- `serverSettings.test.ts` / settings-patch round-trip for the new boolean; web test for
  the descriptor-driven effort field (Codex unchanged, Claude shows per-model values).
- End-to-end: from a parent thread, call `claude_start` with
  `model: "claude-sonnet-5", options: [{ id: "effort", value: "high" }]` and confirm the
  subagent runs, streams activities, and completes on subscription auth.

## Notes on requirements

- **All subscription models everywhere:** guaranteed structurally — every surface reads
  from the live `ClaudeProvider` snapshot, never a hardcoded list. The only filtering is
  intentional CLI-version gating (Fable 5 needs claude ≥ 2.1.169, Opus 4.8 ≥ 2.1.154,
  Opus 4.7 ≥ 2.1.111), which correctly hides models the installed CLI can't run.
- **Reasoning levels:** carried as the `effort` option per model selection, including
  `ultracode`/`ultrathink` on the models that support them; the Phase 4.2 rework is what
  surfaces them in the delegation/scan pickers. Note the option-id split: Claude uses
  `effort`, Codex uses `reasoningEffort`.
- **Billing:** the whole path runs through the local Claude Code install with the user's
  login; nothing touches the API-key billing path.

**Rough effort:** Phases 1–3 are mostly mechanical mirroring of the Codex toolkit
(~a day); Phase 4.2 (descriptor-driven effort field) is the only genuinely new logic.
