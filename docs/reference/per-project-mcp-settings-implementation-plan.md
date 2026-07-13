# Per-Project MCP Settings & Provider-Aware Delegation Defaults — Implementation Plan

Branch: `subagents-and-mcps`
Status: proposed, pending implementation
Related docs: `engine-subagent-delegation-implementation-plan.md`, `implementation-engine-mcp-implementation-plan.md`

## Summary

MCP configuration (`settings.mcp`: `preview`, `codexAgent`, `cursorAgent`, the six engine capability toggles, and `engine.delegation` role chains) is currently **global** — one blob in `ServerSettings.mcp` applied to every session regardless of project. This plan makes it **per-project**:

1. Each project can override any part of the MCP configuration (capabilities and delegation chains). Anything not overridden **inherits from global**, so overrides stay sparse and the feature costs nothing for users who never touch it.
2. **Default case:** a newly created project (or newly added folder) persists no override at all — it inherits global settings, and global defaults are flipped so that _everything is enabled out of the box_.
3. **Provider-aware delegation defaults:** when the user has not customized role chains, the shipped Scout/Worker/Auditor defaults are derived from the providers actually available. With multiple providers, the current cross-provider chains apply. With a **single provider**, all subagent roles default to that provider's designated subagent model (Claude → Sonnet 5, Codex → GPT 5.5, Cursor → Composer 2.5, …).

### Verified current state (Observed)

- `ProjectId` is a branded UUID (`packages/contracts/src/baseSchemas.ts:32`), the PK of `projection_projects` (`apps/server/src/persistence/Migrations/005_Projections.ts:8`). Projects are event-sourced: `project.create` command → `project.created` event (`apps/server/src/orchestration/decider.ts:108`) → projector (`apps/server/src/orchestration/projector.ts:201`). The project row already carries per-project config precedent: `default_model` (`defaultModelSelection`) and `scripts_json`.
- `McpSettings` lives globally at `ServerSettings.mcp` (`packages/contracts/src/settings.ts:149`, embedded at `:541`); the patch schema mirrors it (`:674-702`). **No project dimension anywhere in the settings tree.**
- `McpSessionRegistry.issue` (`apps/server/src/mcp/McpSessionRegistry.ts:122`) already resolves thread → project (`:127-142`) **before** computing session capabilities from global `settings.mcp` (`:152-174`). This is the single natural injection point for per-project overrides.
- `McpInvocationScope` carries `projectId` and `worktreePath` (`apps/server/src/mcp/McpInvocationContext.ts:23-27`); engine handlers already key everything (knowledge, artifacts, chunks) by `scope.projectId` (`apps/server/src/mcp/toolkits/engine/handlers.ts:87,99-111,185,206,246,260`). Only the **delegation settings** input is global (`handlers.ts:122` → `settings.mcp.engine.delegation`).
- Delegation role defaults are static constants baked in at decode time: `SCOUT_DEFAULTS` / `WORKER_DEFAULTS` / `AUDITOR_DEFAULTS` via `withDecodingDefault` (`settings.ts:68-99,120-135`). This erases the "user never customized this" signal that provider-aware defaults need.
- Per-provider default models already exist: `DEFAULT_MODEL_BY_PROVIDER` (`packages/contracts/src/model.ts:139`) — `claudeAgent → claude-sonnet-5`, `codex → gpt-5.4`, `cursor → auto`, etc. Provider enabled/installed/availability state comes from `ProviderRegistry.getProviders` (`apps/server/src/provider/Services/ProviderRegistry.ts:28`), already consumed by the session registry (`McpSessionRegistry.ts:143-150`).
- Web precedent for a per-project settings surface: `KnowledgeSettings.tsx` (project `<Select>` picker at lines ~542-561, all queries keyed by `projectId`). `McpSettings.tsx` / `EngineDelegationSettings.tsx` are global (`usePrimarySettings` / `useUpdatePrimarySettings`).
- `DelegatedRunProvider` is `codex | cursor` only — there are no Claude-driver delegated runs (unchanged non-goal from the delegation plan).

## Goals

1. Any MCP capability or delegation chain can be set per project; unset fields inherit global.
2. New projects need **zero writes** to get the default "everything enabled" experience.
3. Shipped delegation defaults adapt to the installed provider set; single-provider installs delegate to that provider's subagent-tier model without any configuration.
4. Both the settings UI and agents (via `engine_delegation_get`/`engine_delegation_set`) can read and write project-scoped configuration.
5. Changes take effect on the next MCP session/workflow call without restart.

## Non-goals

- No Claude/Grok/OpenCode delegated-run providers (`DelegatedRunProvider` stays `codex | cursor`). A Claude-only install is handled through the **inline/native-subagent path with a model hint** (Phase 4), not a new run provider. Adding `claude` as a tracked delegation provider is a possible follow-up.
- No per-thread or per-worktree overrides — the unit of scoping is the project.
- No changes to the delegated-run lifecycle, Subagents panel, or provider adapters.
- No migration of existing projects — absence of an override _is_ the default state.

## Data model

### `ProjectMcpOverrides` (sparse, tri-state)

Every field is optional; `undefined` means "inherit from global". An absent/empty override object means the project fully inherits.

```ts
// packages/contracts/src/settings.ts (exported for reuse by orchestration + web)
export const ProjectEngineDelegationOverrides = Schema.Struct({
  roles: Schema.optional(
    Schema.Struct({
      scout: Schema.optional(Schema.Array(EngineDelegationTarget)),
      worker: Schema.optional(Schema.Array(EngineDelegationTarget)),
      auditor: Schema.optional(Schema.Array(EngineDelegationTarget)),
    }),
  ),
  skillOverrides: Schema.optional(EngineDelegationSkillOverrides),
});

export const ProjectMcpOverrides = Schema.Struct({
  preview: Schema.optional(Schema.Boolean),
  codexAgent: Schema.optional(Schema.Boolean),
  cursorAgent: Schema.optional(Schema.Boolean),
  engine: Schema.optional(
    Schema.Struct({
      planning: Schema.optional(Schema.Boolean),
      enrich: Schema.optional(Schema.Boolean),
      implement: Schema.optional(Schema.Boolean),
      quality: Schema.optional(Schema.Boolean),
      performance: Schema.optional(Schema.Boolean),
      typescript: Schema.optional(Schema.Boolean),
      delegation: Schema.optional(ProjectEngineDelegationOverrides),
    }),
  ),
});
export type ProjectMcpOverrides = typeof ProjectMcpOverrides.Type;
```

### Resolution semantics

```
effective = resolveEffectiveMcpSettings(globalMcp, projectOverrides)
```

- Booleans: project value if defined, else global.
- Delegation role chains: a project-defined chain **replaces** the global chain for that role (no element-wise merge — chains are ordered lists).
- `skillOverrides`: project map replaces global map per-workflow-key (a project override for `quality-audit` doesn't erase a global override for `plan`).
- Delegated child sessions (`delegated-` threads) resolve through the parent thread's project (already how `projectId` is obtained in `McpSessionRegistry.issue`), so children see the same project's effective settings — and still never receive delegation capabilities (recursion guard unchanged).

### Storage decision: on the project aggregate, not in `ServerSettings`

Persist overrides as part of the project (event-sourced, projected to a `mcp_overrides_json` column on `projection_projects`), **not** as a `Record<ProjectId, …>` inside `ServerSettings.mcp`:

- Follows the exact existing pattern of `defaultModelSelection` and `scripts` (per-project config already on the row).
- Lifecycle is automatically correct: deleting a project deletes its overrides; no orphaned keys in the settings blob.
- Project data already broadcasts to clients on change (`ws.ts` project event handling), so the web UI gets live updates for free.
- Keeps `ServerSettings` as "environment-global" — its patch/merge machinery (`packages/shared/src/serverSettings.ts`) stays untouched.

## Provider-aware default derivation

New in `packages/contracts/src/settings.ts` (constants) + `apps/server/src/knowledge/skills/delegation.ts` (logic):

```ts
// Subagent-tier default model per delegation-capable provider,
// distinct from DEFAULT_MODEL_BY_PROVIDER (main-thread defaults).
export const DELEGATION_SUBAGENT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.5",
  cursor: "composer-2.5",
} as const;

// Main-thread providers that cannot run tracked delegated runs still get
// a native-subagent model hint for the inline fallback path:
export const NATIVE_SUBAGENT_MODEL_BY_DRIVER = {
  claudeAgent: "claude-sonnet-5", // "Sonnet 5"
  codex: "gpt-5.5",
  // extend as drivers gain native subagent facilities
} as const;
```

`deriveDefaultDelegationRoles(availableDelegationProviders: Set<"codex" | "cursor">)`:

- **Both available** → today's `SCOUT_DEFAULTS` / `WORKER_DEFAULTS` / `AUDITOR_DEFAULTS` verbatim.
- **Codex only** → scout: `gpt-5.5` (reasoning low); worker: `gpt-5.6-terra` (high) → `gpt-5.6-sol` (medium); auditor: `gpt-5.6-sol` (high). I.e. the codex entries of the shipped chains.
- **Cursor only** → scout/worker: `composer-2.5`; auditor: `grok-4.5`.
- **None** → empty chains → inline. When the session's _main-thread_ driver has an entry in `NATIVE_SUBAGENT_MODEL_BY_DRIVER`, the rendered inline paragraph names it: _"Use your native subagent facility with model `claude-sonnet-5` for Scout/Worker steps."_ This is how "Claude-only installs use Sonnet 5 subagents" is satisfied without adding a Claude delegated-run provider.

**Customized vs. default:** derivation applies only when the user has never set a chain. To preserve that signal, `EngineDelegationSettings.roles.{scout,worker,auditor}` change from `withDecodingDefault(<ROLE>_DEFAULTS)` to `Schema.optional` — defaults move from decode time to resolution time inside `resolveDelegationChains`. An explicitly saved chain (global or project) always wins over derivation, and the existing availability filter still prunes it.

---

## Phase 1 — Contracts

**Files:** `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/index.ts`.

1. Add `ProjectMcpOverrides` / `ProjectEngineDelegationOverrides` (schema above); export `EngineDelegationSkillOverrides` (currently module-private at `settings.ts:108`).
2. Change `EngineDelegationSettings.roles.*` to `Schema.optional(...)` (drop `withDecodingDefault(<ROLE>_DEFAULTS)`); keep the `*_DEFAULTS` constants exported for derivation and UI display.
3. Add `resolveEffectiveMcpSettings(global, overrides | undefined)` as a pure exported function (contracts or `packages/shared`) implementing the resolution semantics above, so server and web compute identical effective values.
4. Add `DELEGATION_SUBAGENT_MODEL_BY_PROVIDER`, `NATIVE_SUBAGENT_MODEL_BY_DRIVER`, `deriveDefaultDelegationRoles`.
5. **Flip global engine capability decoding defaults** `false → true` (`McpEngineSettings`, `settings.ts:139-144`) so a fresh install / new project has everything enabled, per the product decision. Note in the changelog: users who never persisted `settings.mcp.engine` will see engine tools appear.
6. Orchestration contracts: add `project.mcp-settings-updated` to the project event union (`orchestration.ts:806` region) with payload `{ projectId, mcpOverrides: ProjectMcpOverrides, updatedAt }`; add `mcpOverrides?: ProjectMcpOverrides` to `ProjectCreatedPayload`'s projected shape (nullable, absent on create) and to the project snapshot delivered to clients.
7. Tests: decode `{}` overrides → all-inherit; resolution matrix (project true over global false and vice versa; chain replacement; per-key skillOverride merge); `deriveDefaultDelegationRoles` for both/codex-only/cursor-only/none; legacy persisted settings (roles present) still decode as explicit chains.

**Definition of done:** contracts typecheck + tests green; old persisted settings decode without behavior change (explicit chains preserved; missing chains now resolve via derivation to the same shipped defaults when both providers are available).

---

## Phase 2 — Persistence & orchestration

**Files:** `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/projector.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, new migration `apps/server/src/persistence/Migrations/0XX_ProjectMcpOverrides.ts`, `apps/server/src/persistence/Services/ProjectionProjects.ts`.

1. Migration: `ALTER TABLE projection_projects ADD COLUMN mcp_overrides_json TEXT` (nullable; `NULL` = inherit).
2. Decider: handle `project.update-mcp-settings` command → validate payload against `ProjectMcpOverrides` → emit `project.mcp-settings-updated`. Reject for deleted/unknown projects (same guards as meta-update).
3. Projector + pipeline: materialize the event into `mcp_overrides_json`; extend `ProjectionProject` schema (`ProjectionProjects.ts:17`) with `mcpOverrides: ProjectMcpOverrides | null` (decode-on-read like `scripts_json`).
4. **Project creation is untouched** — no override is written, which _is_ the "everything enabled" default via inheritance.
5. Tests: round-trip event → projection; `NULL` column decodes to undefined; malformed stored JSON degrades to inherit (log, don't crash) — same tolerance pattern as other `*_json` columns.

**Definition of done:** dispatching the command persists overrides; `projects.getById` returns them; restart-safe.

---

## Phase 3 — RPC & client runtime

**Files:** `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`, `apps/server/src/server.ts`, `packages/client-runtime/src/state/server.ts`.

1. New method `projects.updateMcpSettings` (`WS_METHODS` near `rpc.ts:182-184`): payload `{ projectId, mcpOverrides: ProjectMcpOverrides }`, routed through the orchestration dispatch path like `projects.add`. Success returns the updated project snapshot.
2. Include `mcpOverrides` in the project payloads already broadcast on project events (`ws.ts:615,662` region) and in `projects.list` results, so clients hold current overrides without a new read RPC.
3. Client runtime: extend the projects atom/state (`packages/client-runtime/src/state/server.ts`) to carry `mcpOverrides` and expose an update command wrapping the new RPC (optimistic update mirroring `persistServerSettings`).

**Definition of done:** web client can read a project's overrides from the existing project state and persist changes; a second connected client observes the change via broadcast.

---

## Phase 4 — Server enforcement (capabilities + delegation)

**Files:** `apps/server/src/mcp/McpSessionRegistry.ts`, `apps/server/src/mcp/toolkits/engine/handlers.ts`, `apps/server/src/knowledge/skills/delegation.ts`, tests alongside each.

1. `McpSessionRegistry.issue` (`:122-174`): after resolving the project (`:133`), compute
   `const effectiveMcp = resolveEffectiveMcpSettings(settings.mcp, project?.mcpOverrides)`
   and use `effectiveMcp` everywhere `settings.mcp` is read today (`preview` at `:154`, `codexAgent`/`cursorAgent` at `:155-160`, engine capability table at `:161-174`). Provider-availability and delegated-child guards unchanged. Sessions with no resolvable project (if any exist) fall back to global.
2. `workflow()` in `engine/handlers.ts`: replace the `settings.mcp.engine.delegation` input (`:122`) with the effective delegation settings for `scope.projectId` (fetch the project row via the projection repo, or — cleaner — stash `effectiveMcp` on the issued scope at session time so handlers don't re-resolve; **recommended:** add `effectiveMcp` to `McpInvocationScope` since capabilities on the scope are already a projection of it).
3. `resolveDelegationChains` (`delegation.ts:27`) gains provider-availability input and the derivation fallback: explicit chain (skill override → role chain, project-effective) → else `deriveDefaultDelegationRoles(available)`; then the existing capability filter. `renderDelegationSection` gains the native-subagent model hint for the inline paragraph (main-thread driver → `NATIVE_SUBAGENT_MODEL_BY_DRIVER`).
4. Session invalidation: changing a project's overrides must affect the _next_ session issue (same freshness model as global settings changes today — no live-session capability revocation; document this).
5. Tests (`McpSessionRegistry.test.ts`, delegation tests):
   - project override `engine.quality: false` with global `true` → session lacks `engine-quality` capability; sibling project unaffected.
   - project with no overrides → identical capability set to today's global path.
   - codex-only availability + no customized chains → scout resolves to `codex/gpt-5.5` low.
   - claude-main-thread, no delegation providers → inline section names `claude-sonnet-5`.
   - explicit user chain survives derivation (not overwritten).
   - delegated child of a project with delegation disabled still gets no recursion (existing guard) and inherits the project's engine toggles.

**Definition of done:** two projects on the same server can run simultaneous sessions with different MCP tool surfaces and different resolved delegation targets.

---

## Phase 5 — Agent-editable configuration, project-scoped

**Files:** `apps/server/src/mcp/toolkits/engineKnowledge/handlers.ts`, `apps/server/src/mcp/toolkits/engineKnowledge/tools.ts`, `packages/contracts/src/knowledge.ts`, `apps/server/src/mcp/delegationPolicy.ts`.

1. `engine_delegation_get`: return `{ scope: "project" | "global", global, projectOverrides, effective, resolved }` for the session's project — the agent can explain both _what applies here_ and _where it came from_.
2. `engine_delegation_set`: add optional `scope` input, **default `"project"`** (the session is always project-bound, and per-project is the preferred granularity per product direction). `scope: "project"` writes through the Phase 3 command; `scope: "global"` keeps today's `serverSettings` path. Empty chain on a project entry deletes the project override (reverts to inherit), distinct from an explicit empty global chain.
3. Update `IMPLEMENTATION_ENGINE_INSTRUCTIONS` in `delegationPolicy.ts` to state that delegation defaults are per-project and how to target global explicitly.
4. Tests: project-scoped set affects only that project's next hydration; global set still affects projects without overrides; delete-override reverts to global.

**Definition of done:** "make GPT 5.6 Sol the quality-audit worker _for this project_" is a one-message agent operation that doesn't touch other projects.

---

## Phase 6 — Web settings UI

**Files:** `apps/web/src/components/settings/McpSettings.tsx`, `EngineDelegationSettings.tsx`, `SettingsSidebarNav.tsx` if a sub-route is added; reuse `field.tsx`, `tabs.tsx`, and the project `<Select>` pattern from `KnowledgeSettings.tsx`.

1. Add a **scope picker** at the top of the MCP settings panel: `Global defaults` plus one entry per project (same project list source as `KnowledgeSettings.tsx`). Global view = current UI unchanged.
2. Project view renders the same rows, but each control is **tri-state**: `Inherit (currently: On/Off)` / `On` / `Off`. Inherited rows show the resolved global value muted with an "inherited" badge. Setting a control writes only that key into `mcpOverrides` (sparse patch); a "Reset to inherit" affordance clears it. A header-level "Reset all to global" clears the whole override object.
3. `EngineDelegationSettingsSection` gains the same scope awareness: in project scope, each role chain shows `Inherited from global` (rendering the _effective_ chain read-only, including derived defaults labeled "auto: derived from available providers") with a `Customize for this project` toggle that copies the effective chain into an editable project chain; removing the customization deletes the project override.
4. In global scope, when roles are unset (post-Phase-1 optional), display the derived defaults with the same "auto" label instead of pretending they're saved values.
5. Persistence: project scope → the Phase 3 `projects.updateMcpSettings` command via the client-runtime command; global scope → existing `useUpdatePrimarySettings`. Live updates arrive via the project broadcast.
6. Tests: follow repo pattern — settings round-trip is covered server-side; add a web unit test only if sibling settings components have one.

**Definition of done:** a user can open MCP settings, pick a project, turn off (e.g.) `engine.performance` and `preview` for that project only, and see other projects unaffected; the "inherit" state is always visually distinguishable from an explicit value.

---

## Phase 7 — Verification

1. Unit: Phases 1–5 test lists above; workspace typecheck across `contracts`, `shared`, `server`, `client-runtime`, `web`.
2. Integration (manual, on branch):
   - Two projects, A and B. Disable `codexAgent` + all engine toggles on A. Session in A: no `codex_start`, no `engine_*` tools. Session in B: full surface. Toggle back → next session in A restored.
   - Fresh project C: no writes occur; capability set equals global.
   - Codex-only machine (Cursor uninstalled/disabled), no customized chains: `engine_plan` hydration instructs Scout = `codex_start` with `gpt-5.5` low.
   - Claude thread with no delegation providers: hydrated inline section names Sonnet 5 for native subagents.
   - Agent runs `engine_delegation_set` (default project scope) in A → A's next hydration changes, B's does not, settings UI project view reflects it live.

## Failure modes

| Trigger                                                             | Expected behavior                                                                                                                                           | Test      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Stored `mcp_overrides_json` fails schema decode (older/newer build) | Treat as inherit-all; log warning; never block session issue                                                                                                | P2 unit   |
| Project deleted while a session holds its scope                     | Session keeps issued capabilities until expiry; next issue falls back to global (project lookup miss)                                                       | P4 unit   |
| Override enables `codexAgent` but provider is uninstalled           | Capability still gated by `providerAvailable` — override cannot conjure an unavailable provider                                                             | P4 unit   |
| Only provider becomes unavailable mid-chain                         | Derived single-provider chain filters to empty → inline (with native model hint if applicable)                                                              | P4 unit   |
| Legacy settings with explicitly persisted role chains               | Decode as customized chains; derivation never overrides them                                                                                                | P1 unit   |
| Global engine defaults flip `false → true` on upgrade               | Users with a persisted explicit `false` keep it (only decoding _defaults_ changed); users who never touched it gain the tools — called out in release notes | P1 unit   |
| Two clients edit the same project's overrides                       | Last write wins through the event log; both converge via project broadcast                                                                                  | P3 manual |

## Definition of done (overall)

- MCP capabilities and delegation chains are configurable per project with sparse inherit-from-global semantics; new projects require zero configuration and get everything enabled.
- Uncustomized delegation defaults adapt to the available provider set; single-provider installs (including Claude-only via the native-subagent hint, Sonnet 5) delegate sensibly with no setup.
- Settings UI and `engine_delegation_get`/`engine_delegation_set` (project-scoped by default) both read/write the same override store; changes apply on the next session/hydration without restart.
- Typecheck and tests green across `contracts`, `shared`, `server`, `client-runtime`, `web`.
