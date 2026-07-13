# Skill Catalog Injection at Thread Initiation

**Goal:** every skill stored in SQLite — built-in _and_ user/agent-created — is advertised to the model at thread initiation with its live (DB-edited) title and description, in every project, for every provider driver, so that natural phrasing like "start planning briefly" or "run my release-notes skill" triggers the right skill without the user naming a tool.

## Current architecture (verified on `subagents-and-mcps`)

| Concern                   | Where it lives today                                                                                                                                                                                                            | Status                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Skill storage             | `apps/server/src/persistence/Services/Skills.ts` (SQLite, global, versioned)                                                                                                                                                    | ✅ Already cross-project by design                                  |
| Per-project disable       | `project.mcpOverrides.skills[skillId] === false`, checked in `engine/handlers.ts`                                                                                                                                               | ✅ Works at call time                                               |
| Built-in skill triggering | Dedicated MCP tools (`engine_plan_brief`, …) with **static hardcoded descriptions** in `apps/server/src/mcp/toolkits/engine/tools.ts` + `IMPLEMENTATION_ENGINE_INSTRUCTIONS` blurb in `apps/server/src/mcp/delegationPolicy.ts` | ⚠️ Works, but DB description edits don't change the trigger surface |
| Custom skill triggering   | Two-hop: `engine_skill_list` → `engine_skill_run`; names/descriptions **never visible upfront**                                                                                                                                 | ❌ No spontaneous triggering                                        |
| Instruction injection     | `mcpSessionInstructions(capabilities)` — pure/sync, capability-only. Called in `ClaudeAdapter.ts:3768` (systemPrompt append) and `CodexSessionRuntime.ts:1289` (per-turn `delegationInstructions`)                              | ⚠️ No skill data available; sync signature blocks DB access         |
| OpenCode driver           | `OpenCodeAdapter.ts` never calls `mcpSessionInstructions` at all                                                                                                                                                                | ❌ No engine/skill instructions on OpenCode threads                 |
| Session → project link    | `McpProviderSessionConfig` (`mcp/McpProviderSession.ts`) has no `projectId`; but `McpSessionRegistry.issueActiveMcpCredential` already resolves thread → project (`McpSessionRegistry.ts:139`)                                  | ⚠️ One-line plumbing gap                                            |

## Gap analysis

1. **Custom skills are invisible at thread start.** The model only sees "List enabled custom skills" as a tool description. Nothing tells it _which_ skills exist or _when_ to reach for them. This is the core blocker for "works like `.claude/skills`".
2. **Built-in skill descriptions are frozen in code.** Settings → Skills edits change the hydrated body only; the trigger surface (tool description) never updates.
3. **Instruction builder can't reach the DB.** `mcpSessionInstructions` is synchronous and takes only capabilities, so it cannot render a skill catalog even if we wanted it to.
4. **Per-project disables can't be honored at advertisement time.** The adapters only have `threadId` + capabilities when building instructions; `projectId` isn't on the session config.
5. **OpenCode threads get nothing.** Any catalog work must also add the injection point that's currently missing there.
6. **`IMPLEMENTATION_ENGINE_INSTRUCTIONS` never mentions skill discovery.** It documents `engine_skill_save` (creation) but not `engine_skill_list`/`engine_skill_run` (usage).

**What is NOT missing:** cross-project availability. Skills are global rows in the server SQLite database; a new project sees them immediately. Only _discovery_ is broken, not _availability_. No storage or sync work is required.

---

## Phase 1 — Session plumbing: expose `projectId` to instruction builders

**Files:** `apps/server/src/mcp/McpProviderSession.ts`, `apps/server/src/mcp/McpSessionRegistry.ts`

1. Add `readonly projectId: ProjectId` to `McpProviderSessionConfig`.
2. Populate it in `issueActiveMcpCredential` — the thread → project lookup already happens there (`thread.value.projectId`), so this is threading an existing value into `credential.config`.
3. Update the registry/session tests that construct `McpProviderSessionConfig` fixtures.

**Exit criteria:** adapters can read `mcpSession.projectId` wherever they already read `mcpSession.capabilities`.

## Phase 2 — Skill catalog renderer + effectful instruction builder

**Files:** new `apps/server/src/mcp/skillCatalog.ts`, edit `apps/server/src/mcp/delegationPolicy.ts`

1. **Pure renderer** `renderSkillCatalogSection(input)` taking `{ skills: ReadonlyArray<SkillSummary>, projectSkillOverrides: Record<SkillId, boolean> | undefined, capabilities: ReadonlySet<McpCapability> }` and returning a markdown section, e.g.:

   ```
   ## T3 Code skills

   Skills are reusable workflows stored in T3 Code. Invoke one whenever the
   user's request matches its description — do not wait to be asked by name.

   ### Built-in (each has a dedicated tool)
   - **Plan Brief** — <live DB description>. Tool: `engine_plan_brief`.
   - **Implement** — <live DB description>. Tool: `engine_implement`.
   …

   ### Custom (invoke via `engine_skill_run` with the slug)
   - **release-notes** — Drafts release notes from merged PRs since the last tag.
   …
   ```

   Filtering rules (must exactly match `engine_skill_list`'s logic in `engine/handlers.ts:270-275` — extract a shared predicate rather than duplicating it):
   - drop `enabled === false` (global)
   - drop `projectSkillOverrides[skillId] === false` (per-project)
   - drop built-ins whose `capability` is not in the session's capability set (a skill whose tool isn't exposed must not be advertised)
   - keep the section entirely absent when no skills survive filtering.

2. **Effectful builder** `buildMcpSessionInstructions(session: McpProviderSessionConfig): Effect<string | undefined, never, SkillRepository | ProjectionProjectRepository>`:
   - composes the existing sync `mcpSessionInstructions(capabilities)` output with the skill catalog section;
   - loads `SkillRepository.list()` and the project's `mcpOverrides.skills` via `projectId` from Phase 1;
   - **degrades gracefully:** on any repository error, log a warning and fall back to the sync instructions — a DB hiccup must never block a turn.
   - Keep the sync `mcpSessionInstructions` exported for callers/tests that don't need the catalog.

3. Update `IMPLEMENTATION_ENGINE_INSTRUCTIONS` to document the usage path: "Custom skills are listed in the 'T3 Code skills' section; run one with `engine_skill_run({ slug, task })`. Call `engine_skill_list` only if you need to re-check the catalog."

**Exit criteria:** unit tests cover: builtin vs custom sections, global disable, per-project disable, capability-gated builtin dropped, empty catalog → no section, repository failure → fallback.

## Phase 3 — Provider wiring (all three drivers)

**Files:** `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `apps/server/src/provider/Layers/CodexSessionRuntime.ts`, `apps/server/src/provider/Layers/OpenCodeAdapter.ts`

1. **ClaudeAdapter (~line 3768):** replace the sync `mcpSessionInstructions(mcpSession.capabilities)` with `yield* buildMcpSessionInstructions(mcpSession)`. The call site is already inside `Effect.gen` with layer access, so this is a mechanical swap; provide the two repository services to the adapter layer if not already present.
2. **CodexSessionRuntime (~line 1289, `sendTurn`):** same swap. Because Codex passes `delegationInstructions` on **every** `turn/start`, Codex threads get catalog freshness for free (skills created mid-thread appear next turn).
3. **OpenCodeAdapter:** currently injects nothing. Investigate the OpenCode server API for the equivalent surface (system-prompt append / session instructions / first-message preamble) and wire `buildMcpSessionInstructions` into it. If OpenCode genuinely has no instruction channel, prepend the instructions to the first user turn of the thread and record that limitation in the adapter.
4. **Freshness note (document, don't build):** Claude's system prompt is fixed per `query()` session, so a skill created mid-thread on a Claude thread only appears in the catalog at the next session/turn boundary where queryOptions are rebuilt. `engine_skill_list` remains the mid-thread escape hatch — which Phase 2's instruction text now advertises.

**Exit criteria:** adapter-level tests assert the emitted instructions contain the catalog section for a seeded custom skill on Claude and Codex; OpenCode has either the same assertion or a documented limitation + first-turn fallback.

## Phase 4 — Built-in trigger fidelity (descriptions that follow the DB)

**Files:** `apps/server/src/mcp/toolkits/engine/tools.ts`, `apps/server/src/knowledge/skills/defaults.ts`

The engine toolkit is registered once as a static Layer (`McpServer.toolkit(EngineToolkit)` in `McpHttpServer.ts`), so fully per-session dynamic tool descriptions would require reworking server registration — not worth it. Instead:

1. **Single source at boot:** derive each built-in tool's description from `DEFAULT_SKILLS` (same source that seeds the DB) instead of hand-written strings in `tools.ts`, so code and seed can't drift. Add trigger phrasing to those descriptions ("Use when the user asks for a quick/brief plan…").
2. **Live edits ride the catalog:** the Phase 2 catalog section renders the _DB_ title/description, so a user's edit to a built-in skill's description changes the advertised trigger surface at the next thread/turn even though the MCP tool description stays boot-static. Document this precedence in the Settings → Skills UI copy ("Description changes take effect on the next thread").
3. Optional stretch: if Effect's `McpServer` supports `notifications/tools/list_changed`, emit it after `engine_skill_save`/`updateMeta` so long-lived MCP clients refresh — investigate, don't block on it.

**Exit criteria:** editing a built-in skill's description in Settings, then opening a new thread, shows the edited description in the injected catalog (verify via transcript/logs).

## Phase 5 — Consistency + call-time polish

**Files:** `apps/server/src/mcp/toolkits/engine/handlers.ts`, `apps/server/src/mcp/skillCatalog.ts`

1. Refactor `engine_skill_list` to reuse the shared filtering predicate from Phase 2 so the tool result and the injected catalog can never disagree. Include built-ins in the list output (currently `skill.source !== "builtin"` hides them) with a `tool` field pointing at the dedicated engine tool, so a mid-thread `engine_skill_list` is a complete picture.
2. Confirm `engine_skill_run` on a catalog-advertised custom skill hydrates with project knowledge exactly like built-ins (it routes through the same `workflow()` path — add a test asserting delegation-section and knowledge hydration for a custom skill).
3. Keep call-time enforcement as-is (disabled skill → actionable error naming Settings → Skills); it's the correct backstop for catalog staleness.

## Phase 6 — Verification

1. **Unit:** renderer matrix (Phase 2), shared-filter parity test between `engine_skill_list` and the catalog.
2. **Adapter:** instruction-content assertions per driver (Phase 3).
3. **End-to-end manual script:**
   - Create custom skill "release-notes" via Settings → Skills (or `engine_skill_save`).
   - Open a **new thread in a different project**; say "draft the release notes for this repo" without naming the skill → model should call `engine_skill_run({ slug: "release-notes", … })`.
   - Disable the skill for that project only → new thread → catalog omits it; explicit invocation returns the disabled error.
   - Say "start planning briefly" → `engine_plan_brief` fires; edit the plan-brief description, new thread, confirm catalog reflects the edit.
   - Repeat the trigger test on a Codex thread and an OpenCode thread.

## Risks & notes

- **Prompt size:** each advertised skill adds ~1–2 lines. With dozens of skills this stays trivial; if the catalog ever grows large, cap rendered custom skills and point at `engine_skill_list` for the tail (log the truncation in the section itself).
- **Claude system-prompt staleness** is inherent to the driver; the per-turn Codex path and the `engine_skill_list` escape hatch cover it. Do not build a live-refresh mechanism for Claude in this pass.
- **No schema/migration work:** everything reads existing tables; Phase 1 is the only contract-shape change and it's additive.
