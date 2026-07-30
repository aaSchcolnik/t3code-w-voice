# Implementation Engine — Subagent Delegation & Preview Verification Implementation Plan

Branch: `subagents-and-mcps`
Status: approved direction, pending implementation
Related docs: `implementation-engine-mcp-implementation-plan.md`, `subagents-panel-and-mcp-implementation-plan.md`

## Summary

The Implementation Engine workflows (`engine_plan`, `engine_quality_audit`, `engine_implement`, …) are prompt templates hydrated server-side and executed by the main-thread agent — usually the most capable and most expensive model available (e.g. Claude Fable/Opus). Much of the work those workflows prescribe (code search, evidence gathering, per-file rule checks, bounded chunk implementation) does not need the top-tier model.

This plan makes each engine workflow **delegation-aware**: the hydrated workflow text tells the main agent which steps to hand off to tracked subagents (`cursor_start` / `codex_start`) and which model to use, resolved per-session from user-configurable, role-based defaults stored in settings. It also adds a mandatory **preview verification phase** to `engine_implement` (real browser click-through via the t3-code preview MCP) with a credentials gate.

### Verified current state (Observed)

- Engine workflows are static template strings in `apps/server/src/knowledge/skills/templates.ts`, hydrated per call by `workflow()` in `apps/server/src/mcp/toolkits/engine/handlers.ts:69`, which already holds the invocation `scope`.
- Delegation availability is already computed per session: `McpSessionRegistry.ts:152-160` grants `codex-agent` / `cursor-agent` capabilities only when the provider is enabled + installed + `availability !== "unavailable"` — and **never for delegated child sessions** (`delegated-` thread prefix), so subagents cannot recursively spawn subagents.
- Tracked delegation tools exist and are policy-enforced (`delegationPolicy.ts`): `cursor_start`/`codex_start` + exactly-once `*_result`, untracked shell/agent bypasses are detected and denied.
- `DelegatedRunStartInput` already accepts `model` and `options: ProviderOptionSelections` — reasoning-effort selection needs no new plumbing.
- `settings.mcp.engine` exists (`packages/contracts/src/settings.ts:43`, `McpEngineSettings`) with per-capability booleans; settings flow through the existing `serverSettings` service and RPC.
- The preview toolkit exposes 13 tools (`preview_status/open/navigate/resize/snapshot/click/type/press/scroll/evaluate/wait_for/recording_start/recording_stop`) gated by the `preview` capability.
- There is **no** user-elicitation modal for the main thread; `waiting_for_input` + `*_respond` only flows child → parent. The credentials gate therefore works as a chat-level ask (see Phase 5 and Non-goals).

## Goals

1. Every engine workflow that benefits from delegation instructs the main agent to delegate the right steps to the right subagent tier automatically — no per-task user explanation needed.
2. Model/provider defaults are **role-based, ordered fallback chains** stored in settings — never hardcoded in templates — with per-skill overrides.
3. Defaults are changeable both from the settings UI and by asking an agent ("make Y the default worker for quality-audit").
4. Delegation instructions only ever reference providers actually available in the session (subscription/install-aware fallback: e.g. Cursor → Codex → inline).
5. `engine_implement` is not "finished" until spec-level checks **and** a preview click-through pass; flows requiring auth ask the user for credentials before testing starts.

## Non-goals

- No server-side _enforcement_ of delegation (the section is guidance the main agent follows, same mechanism as the existing tracked-delegation instructions). Hard enforcement of the chunk loop is a possible follow-up, not this plan.
- No Claude-provider delegated runs (`DelegatedRunProvider` stays `codex | cursor`). The final fallback is "inline" (main agent does it, optionally via its own native subagent facility).
- No dedicated masked-input credentials modal. The gate is a chat ask; an elicitation RPC + dialog is a separate future feature.
- No changes to the delegated-run lifecycle, Subagents panel, or provider adapters.

## Roles model

| Role       | Purpose                                                                                                               | Delegated?                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Scout**  | Search, analysis, evidence gathering, per-file/per-partition rule checks, call-site tracing                           | Yes — cheapest capable model                 |
| **Worker** | Bounded implementation of one chunk with disjoint files                                                               | Yes — mid/high-capability implementing model |
| **Judge**  | Design decisions, finding dispositions, PR verdicts, completeness verification, final synthesis, preview verification | Never — always the main agent                |

### Shipped defaults (user-editable; models are settings values, not code constraints)

| Role   | 1st                                    | 2nd                                    | 3rd                            |
| ------ | -------------------------------------- | -------------------------------------- | ------------------------------ |
| Scout  | Cursor · Composer 2.5                  | Codex · GPT 5.5, reasoning: low        | inline                         |
| Worker | Codex · GPT 5.6 Terra, reasoning: high | Codex · GPT 5.6 Sol, reasoning: medium | Cursor · Composer 2.5 → inline |

### Per-skill delegation map

| Skill                                     | Delegation                               | Scout/Worker steps                                                                            | Judge-only steps                                                                                          |
| ----------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `engine_plan`                             | High value                               | 1–3 parallel Scouts: owners, exemplars, consumers, call sites, tests, layer-model conformance | Design choice, stress test, alternatives, final plan                                                      |
| `engine_quality_audit`                    | Highest value                            | One Scout per directory/rule-pack partition collecting rule evidence                          | Dispositions, severity, root-cause grouping, report                                                       |
| `engine_quality_pr`                       | High value (gate: large diffs only)      | One Scout per semantic block: callers, contracts, tests, cross-cutting effects                | Verdicts and finding write-ups                                                                            |
| `engine_implement`                        | High value (gate: lane + disjoint files) | Workers implement whole chunks with disjoint owners/files                                     | Chunk splitting, `engine_chunks_update`, completeness verification, failure classification, preview phase |
| `engine_hot_loops`                        | Medium value                             | Scouts per surface category (A–F): scan for loops, subscriptions, timers, I/O-in-loop         | frequency × cost × fan-out estimation, remediation                                                        |
| `engine_enrich`                           | Expand mode only                         | Per-target-directory Scout validating that matched rules/lessons actually apply               | Concern-map budget, placement, layer validation                                                           |
| `engine_plan_brief`                       | Optional single Scout                    | Resolve WHERE (paths/symbols) when the area is unfamiliar                                     | Everything else                                                                                           |
| `engine_quality_quick`                    | None                                     | —                                                                                             | Bounded scope; round-trip overhead exceeds the work                                                       |
| `engine_typescript`                       | None (optional call-site Scout)          | —                                                                                             | Type-system diagnosis is top-model work                                                                   |
| `engine_chunks_*`, `engine_report_render` | N/A                                      | Mechanical server-side tools                                                                  | —                                                                                                         |

### Subagent guardrails (baked into the hydrated section)

- Use only tracked tools (`cursor_start`/`codex_start` + exactly-once `*_result`), consistent with `delegationPolicy.ts`.
- Subagents report findings/diffs back; they never mark chunks complete, never write engine artifacts, never adjudicate. The parent (Judge) verifies and persists.
- Parallelize only Scouts with disjoint scopes and Workers with disjoint files.
- If a subagent's output fails verification, the Judge retries inline rather than re-delegating the same chunk more than once.

---

## Phase 1 — Contracts: delegation settings schema

**Files:** `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`, re-exports in `packages/contracts/src/index.ts` if needed.

1. Add schemas:

   ```ts
   EngineDelegationTarget = Schema.Struct({
     provider: DelegatedRunProvider, // "codex" | "cursor"
     providerInstanceId: Schema.optional(ProviderInstanceId),
     model: Schema.optional(TrimmedNonEmptyString),
     options: Schema.optional(ProviderOptionSelections),
   });

   EngineDelegationRole = Schema.Literals(["scout", "worker"]);

   EngineDelegationSettings = Schema.Struct({
     roles: Schema.Struct({
       scout: Schema.Array(EngineDelegationTarget).pipe(withDecodingDefault(SCOUT_DEFAULTS)),
       worker: Schema.Array(EngineDelegationTarget).pipe(withDecodingDefault(WORKER_DEFAULTS)),
     }),
     skillOverrides: Schema.Record(
       EngineWorkflowNameSchema, // literals matching EngineWorkflowName
       Schema.Struct({
         scout: Schema.optional(Schema.Array(EngineDelegationTarget)),
         worker: Schema.optional(Schema.Array(EngineDelegationTarget)),
       }),
     ).pipe(withDecodingDefault({})),
   });
   ```

2. Add `delegation: EngineDelegationSettings` to `McpEngineSettings` with a decoding default so existing persisted settings decode unchanged (same `withDecodingDefault` pattern as the rest of the struct).
3. Export `SCOUT_DEFAULTS` / `WORKER_DEFAULTS` constants (the shipped defaults table above) so server and web render the same defaults.
4. Extend the settings _update_ schema (`settings.ts:581` region) with the optional delegation keys, mirroring how `engine` booleans are patched.
5. Tests: decode `{}` → defaults present; round-trip a custom chain; reject unknown provider literals; skill-override key must be a valid workflow name.

**Definition of done:** contracts typecheck + tests green; decoding old persisted settings yields the default chains.

---

## Phase 2 — Server: delegation resolution module

**Files:** new `apps/server/src/knowledge/skills/delegation.ts`, new `apps/server/src/knowledge/skills/delegation.test.ts`.

1. `resolveDelegationChains(input)` — pure function taking:
   - `settings.mcp.engine.delegation`
   - the session capability set (`McpCapability` set from the invocation scope)
   - the workflow name

   Returns `{ scout: EngineDelegationTarget | undefined, worker: EngineDelegationTarget | undefined }` by: skill override → role chain → filter entries whose provider capability (`cursor-agent` / `codex-agent`) is absent → first survivor. `undefined` means inline.

2. `renderDelegationSection(input)` — pure function producing the Markdown `## Subagent delegation` section from resolved targets + the per-workflow role guidance (which steps are Scout/Worker-delegable, from the map above) + the guardrails block. When both roles resolve to `undefined`, render the short inline-fallback paragraph instead ("no tracked subagents are available in this session — perform all steps yourself").
   - The section names concrete tools and parameters, e.g. _"Scout: `cursor_start` with `model: "composer-2.5"`; call `cursor_result` exactly once."_ including `options` when present.
   - Workflows marked "None" in the map get no section at all (`quality-quick`, `typescript`, mechanical tools).

3. Tests: override beats role chain; unavailable provider is skipped to the next entry; empty chain → inline text; `quality-quick` renders nothing; options serialize into the instruction text.

**Definition of done:** module is pure (no Effect services needed beyond inputs), fully unit-tested.

---

## Phase 3 — Server: hydration wiring

**Files:** `apps/server/src/knowledge/skills/templates.ts`, `apps/server/src/mcp/toolkits/engine/handlers.ts`.

1. `workflow()` in `handlers.ts` already has `scope`; additionally read `serverSettings.getSettings` (the handler layer already depends on settings-adjacent services; add `ServerSettings` to the toolkit `dependencies` in `tools.ts` if not transitively provided).
2. Compute `resolveDelegationChains` + `renderDelegationSection` and pass the rendered section into `hydrateWorkflow` as a new optional `delegationSection` field; `hydrateWorkflow` appends it between the workflow body and `## Hydrated task context`.
3. Adjust each template's prose to reference **roles**, not models (e.g. plan: "Delegate evidence gathering to your Scout as described in the Subagent delegation section; design decisions and the stress test are yours"). Templates never name a model — changing defaults requires no template edit.
4. Also thread the `preview` capability into hydration (used by Phase 5).
5. Tests: extend `McpHttpServer.test.ts` (or a focused handler test) — a session with `cursor-agent` capability gets a Scout bound to the first chain entry; a session with neither delegation capability gets the inline paragraph; a delegated child session (no delegation capabilities by construction) gets the inline paragraph.

**Definition of done:** calling `engine_plan` in a Cursor-capable session returns workflow text containing the resolved `cursor_start` instruction; same call without providers returns inline-fallback text.

---

## Phase 4 — Server + contracts: agent-editable configuration tools

**Files:** `apps/server/src/mcp/toolkits/engineKnowledge/tools.ts`, `apps/server/src/mcp/toolkits/engineKnowledge/handlers.ts`, `packages/contracts/src/knowledge.ts` (input/result schemas).

1. `engine_delegation_get` (readonly, idempotent, capability `engine-knowledge`): returns `{ roles, skillOverrides, resolved }` where `resolved` marks, per entry, whether it is currently satisfiable in this session (provider available) — so an agent can explain _why_ a chain falls through.
2. `engine_delegation_set` (capability `engine-knowledge`): input `{ role?, workflow?, chain }` — set a role default chain or a per-skill override (empty `chain` on an override deletes it). Validates against the contracts schema and persists through the existing `serverSettings` update path so the web UI observes the change immediately.
3. Update `delegationPolicy.ts` `IMPLEMENTATION_ENGINE_INSTRUCTIONS` to mention that delegation defaults are configurable via `engine_delegation_get`/`engine_delegation_set` — this is what makes "change the default worker for quality-audit to Y" a one-message operation.
4. Tests: get reflects defaults; set role chain persists and next `engine_plan` hydration uses it; set override for one workflow does not affect others; invalid workflow name rejected.

**Definition of done:** an agent in a session can read and change delegation defaults; changes survive restart (settings persistence) and immediately affect hydration.

---

## Phase 5 — Templates: `engine_implement` preview verification phase + credentials gate

**Files:** `apps/server/src/knowledge/skills/templates.ts` (implement + plan templates), `apps/server/src/knowledge/skills/delegation.ts` (section renderer gains the preview block, gated on the `preview` capability).

1. Append a final phase to the `implement` template, included only when the session has the `preview` capability:
   - **Credentials gate (before any clicking):** after all chunks complete and repo checks pass, determine whether affected routes/flows require authentication or test accounts. If yes, **stop and ask the user in chat for credentials, and wait**. Never begin preview testing that will dead-end on a login wall; never invent credentials.
   - **Click-through:** `preview_status`/`preview_open` → navigate to each affected route → exercise primary flows with `preview_click`/`preview_type`/`preview_press`/`preview_wait_for` → `preview_snapshot` for visual consistency and loading/empty/error states → `preview_evaluate` for console errors.
   - **Judge-only:** this phase always runs on the main thread; implementation is not "finished" until spec tests **and** the preview walkthrough pass. Save the walkthrough outcome (routes visited, flows exercised, snapshots taken, issues) as a case artifact (kind=`preview-verification`).
   - Skip rule: when the change has no UI/route surface, state that explicitly instead of silently skipping.
2. Update the `plan` template: the plan's acceptance section must record **required test accounts/credentials** when the touched flows are auth-gated, so the need surfaces at planning time, not at the end of implementation.
3. When the session lacks the `preview` capability, the implement template keeps its current ending (repo checks + quality audit) and notes that browser verification was not available.

**Definition of done:** hydrated `engine_implement` in a preview-capable session contains the gate + click-through phase; without preview capability it does not.

---

## Phase 6 — Web: settings UI

**Files:** `apps/web/src/components/settings/KnowledgeSettings.tsx` (or a sibling `EngineDelegationSettings` section within it), reusing existing field/select primitives (`components/ui/field.tsx`, `tabs.tsx`).

1. New "Subagent delegation" section under the Knowledge/Engine settings: per-role ordered chain editor (provider + instance + model + reasoning-effort option, add/remove/reorder), rendered from the same contracts defaults.
2. Per-skill overrides: collapsed list of workflows with an "override" toggle revealing the same chain editor.
3. Show availability state per entry (provider unavailable → muted with explanation), mirroring `engine_delegation_get.resolved`.
4. Persist through the existing settings RPC; no new endpoints.
5. Test: `serverSettings.test.ts` / settings round-trip already covers persistence; add a web unit test only if the repo pattern has one for sibling settings components.

**Definition of done:** chains editable in UI; a UI change is immediately visible to `engine_delegation_get` and to the next workflow hydration.

---

## Phase 7 — Verification

1. Unit: contracts decode/round-trip (P1), resolution + rendering (P2), handler hydration matrix (P3), config tools (P4).
2. Integration (manual, on branch):
   - Claude thread with Cursor + Codex available → `engine_quality_audit` instructs Scout = Composer 2.5 partition audits; disable Cursor provider → same call falls back to Codex GPT 5.5 low; disable both → inline text.
   - Ask the agent to change the worker default for `quality-audit` → `engine_delegation_set` persists → settings UI reflects it → next hydration uses it.
   - `engine_implement` on a UI-touching task → preview phase appears; auth-gated flow → agent asks for credentials before clicking.
3. Repo checks: workspace typecheck + affected package tests.

## Failure modes

| Trigger                                                | Expected behavior                                                                                  | Test                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------- |
| Configured provider uninstalled/disabled mid-session   | Entry filtered at hydration; next entry or inline                                                  | P2 unit                   |
| Chain references a model the provider instance rejects | Delegated run fails visibly in Subagents panel; workflow guidance tells Judge to retry inline once | manual                    |
| Settings JSON from older build (no `delegation` key)   | Decoding defaults apply; no migration needed                                                       | P1 unit                   |
| Delegated child session calls an engine workflow       | No delegation capabilities → inline section; no recursion                                          | P3 unit                   |
| Preview capability off                                 | Implement template omits preview phase, states browser verification unavailable                    | P3/P5 unit                |
| Auth-gated flow, user never supplies credentials       | Agent reports preview verification blocked instead of clicking into a login wall                   | template contract, manual |

## Addendum — Auditor consensus panel for `engine_plan` (implemented)

A third role, **Auditor**, was added on top of the phases above. Unlike Scout/Worker (ordered fallback chains where the first available entry wins), the Auditor role is a **consensus panel: every available entry runs in parallel**.

- Defaults (`AUDITOR_DEFAULTS`, user-editable in settings and via `engine_delegation_set`): Codex · GPT 5.6 Sol, reasoning: high; Cursor · Grok 4.5.
- Flow in `engine_plan`: the Judge drafts the plan and persists it as Markdown (`kind=plan`) **without presenting it**; fans the draft plus the verbatim user request out to every Auditor, which audits for missing implementation parts, unhandled edge cases, risky assumptions, contract/test gaps, and misreadings of the request; the Judge persists the combined analyses (`kind=plan-consensus`), adjudicates each finding (agree/disagree with reason), folds accepted corrections into the plan, persists the revised canonical plan, and only then renders and presents the HTML via `engine_report_render` (`kind="styled-plan"`).
- When no Auditor provider is available in the session, the hydrated section instructs a self-review fallback and still ends with the styled-plan HTML render.
- Ripple: role literal + defaults + override/patch/result schemas (`settings.ts`, `knowledge.ts`, new `plan-consensus` artifact kind), panel resolution + consensus section renderer (`delegation.ts`), plan template "Consensus and final presentation" section (`templates.ts`), `engine_delegation_get/set` (`engineKnowledge/handlers.ts`), and the Auditor chain editor in `EngineDelegationSettings.tsx`.

## Definition of done (overall)

- All engine workflows hydrate with session-accurate, role-based delegation guidance; no model names in templates.
- Defaults editable via settings UI **and** `engine_delegation_set`; changes take effect on the next workflow call without restart.
- `engine_implement` requires spec tests + preview click-through (with credentials gate) before claiming completion in preview-capable sessions.
- Typecheck and tests green across `contracts`, `server`, `web`.

## Addendum — Knowledge scanner panel

Knowledge bootstrap adds a fourth delegation role, **Scanner**. Scanner entries use panel semantics:
every usable target scans the whole codebase independently. Codex and Cursor targets run as tracked
delegated agents; the `inline` target represents the Judge's own pass and does not widen the delegated
run provider protocol. The default panel is inline Claude Opus 4.8, Codex GPT 5.6 Terra, Cursor Grok
4.5, and Cursor GLM 5.2. The panel and the ordered main-thread model preference are editable in Engine
settings. `engine_delegation_get/set` accepts `scanner`, while codebase bootstrap falls back to the
legacy inline workflow when no delegated scanner is usable.
