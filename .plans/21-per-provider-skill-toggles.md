# 21 — Per-Provider Skill Toggles

## Goal

Let users disable agent skills from the Knowledge → Skills tab without deleting skill
files: a switch per skill per provider, a "disable all" switch per provider, and a
top-level master switch that kills skills across every provider. Skill files stay on
disk and keep working for anyone using the CLIs outside T3 code.

## Feasibility summary (from investigation, 2026-07-12)

| Provider | Per-skill | Disable-all | Mechanism |
|---|---|---|---|
| Claude | ✅ | ✅ | Agent SDK `disallowedTools: ["Skill(name)"]` / `["Skill"]` |
| Codex | ✅ | ✅ | `codex app-server -c 'skills.config=[{name=…,enabled=false}]'`; fallback: filtered `skills` dir in the existing shadow CODEX_HOME |
| OpenCode | ✅ | ✅ | Session `permission.skill` deny patterns / `tools.skill=false` |
| Cursor | ❌ | ❌ | `agent acp` exposes no flag/config; only file-mutating `disable-model-invocation` frontmatter (cross-tool, not per-provider) → slider rendered disabled |
| Grok | ❌ | ⚠️ global only | `grok skills disable <name>` mutates global CLI state → slider rendered disabled (or opt-in with "global" warning) |

Key existing plumbing:

- Skills tab: `SkillsView` in `apps/web/src/components/settings/KnowledgeSettings.tsx`
  (read-only today), fed by `knowledgeListSkills` RPC (`ws.ts:1404`) →
  `apps/server/src/knowledge/ProjectSkillScanner.ts` (scans project `.claude/skills` +
  `.agents/skills`; `skillId` = directory name).
- Settings: `ServerSettings`/`ServerSettingsPatch` in `packages/contracts/src/settings.ts`,
  persisted via `serverUpdateSettings` RPC → `serverSettings.updateSettings` (deep merge,
  atomic write, `settingsUpdated` broadcast).
- Adapters already read per-provider settings at spawn: `ClaudeAdapter.ts:3714`
  (`binaryPath`/`launchArgs` → `queryOptions` at `:3752`), `CodexSessionRuntime.ts:729`
  (`appServerArgs`), `CodexHomeLayout.ts` (shadow home symlinks `skills` as a shared dir),
  `opencodeRuntime.ts:216` (`buildOpenCodePermissionRules`).

---

## Phase 1 — Contracts & settings model

**Files:** `packages/contracts/src/settings.ts`, `packages/contracts/src/knowledge.ts`

1. Add a `SkillToggleSettings` schema:

   ```ts
   SkillProviderToggles = Schema.Struct({
     disableAll: Schema.Boolean (default false),
     disabledSkills: Schema.Array(Schema.String) (default []), // skillId = skill dir name
   })
   SkillToggleSettings = Schema.Struct({
     disableAllProviders: Schema.Boolean (default false),
     providers: Schema.Struct({
       claudeAgent: SkillProviderToggles,
       codex: SkillProviderToggles,
       opencode: SkillProviderToggles,
       cursor: SkillProviderToggles,   // stored but unenforceable today
       grok: SkillProviderToggles,     // stored but unenforceable today
     }),
   })
   ```

2. Add `skills: SkillToggleSettings` to `ServerSettings` (with `withDecodingDefault`)
   and mirror it in `ServerSettingsPatch` with `optionalKey` structs, following the
   `mcp.engine` nested-patch precedent (`settings.ts:831-866`).
3. Extend knowledge contracts so the UI can render capability-aware sliders:
   - `ProjectSkillSource`: keep `"claude" | "agents"`, add `"cursor" | "codex"` and a
     `scope: "project" | "user"` field on `ProjectSkillLocation` (Phase 2 emits them).
   - Add a static per-provider capability descriptor (e.g.
     `SKILL_TOGGLE_CAPABILITIES: Record<ProviderDriverId, "full" | "none" | "globalOnly">`)
     exported from contracts so web + server agree.

**Done when:** `pnpm typecheck` passes; `DEFAULT_SERVER_SETTINGS` decodes with the new
block; settings round-trip through `applyServerSettingsPatch` in a unit test
(`serverSettings.test.ts`).

---

## Phase 2 — Scanner: discover everything providers actually load

**Files:** `apps/server/src/knowledge/ProjectSkillScanner.ts`, WS handler `ws.ts:1404`

Today the tab only shows project-level `.claude/skills` and `.agents/skills`, but the
skills users care about (`emil-design-eng`, `interface-craft`, `shadcn`, …) live at user
level and are picked up by all CLIs. Without this phase the toggles would miss them.

1. Extend `scanSource` to cover, per scan:
   - project: `.claude/skills`, `.agents/skills`, `.cursor/skills`, `.codex/skills`
   - user: `~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`, `~/.codex/skills`
2. Emit `scope` (`project`/`user`) and the new sources on each `ProjectSkillLocation`.
   Keep the existing merge-by-`skillId` behavior so the same skill in several roots is
   one row with N locations.
3. Keep the caps (`MAX_SKILLS_PER_SOURCE`, 64KB, 2s timeout); raise the timeout only if
   the extra roots measurably need it.

**Done when:** `ProjectSkillScanner` unit tests cover user-level discovery, dedupe
across roots, and scope labeling; the RPC returns the enriched shape.

---

## Phase 3 — Web UI: sliders in the Skills tab

**Files:** `apps/web/src/components/settings/KnowledgeSettings.tsx` (+ small components)

1. Top of `SkillsView`: master switch — "Disable all skills for all providers"
   (`skills.disableAllProviders`).
2. Provider row (Claude / Codex / OpenCode / Cursor / Grok): per-provider "disable all"
   switch. Cursor and Grok render disabled with a tooltip:
   - Cursor: "Cursor CLI has no way to disable skills per session."
   - Grok: "Grok only supports a global toggle that affects sessions outside T3 Code."
3. Each skill card gains a compact per-provider switch group (only for providers with
   `"full"` capability). Effective state = master ∧ provider ∧ per-skill; show a muted
   "disabled by provider/master switch" state when overridden from above.
4. Persist via the existing `serverUpdateSettings` mutation (same `useAtomCommand`
   pattern as `knowledgeUpdateProfile` at `KnowledgeSettings.tsx:119`); read current
   values from the settings atom. Note in the UI that changes apply to **new sessions**.

**Done when:** toggles persist across reload, `settingsUpdated` keeps multiple clients
in sync, disabled providers are visibly non-interactive.

---

## Phase 4 — Enforcement: Claude

**Files:** `apps/server/src/provider/Layers/ClaudeAdapter.ts` (~`:3714-3794`)

1. Thread `SkillToggleSettings` into `makeClaudeAdapter` (alongside `claudeSettings`),
   or resolve it from `ServerSettings` at the same place `claudeSettings` is resolved.
2. When building `queryOptions`:
   - master or claude `disableAll` → `disallowedTools: ["Skill"]`
   - else per-skill list → `disallowedTools: disabledSkills.map(s => `Skill(${s})`)`
   - merge with (don't clobber) any future disallowed-tools sources.
3. Add span attributes (`claude.query.disallowed_tools`) next to the existing
   diagnostics annotations.

**Done when:** adapter test asserts `disallowedTools` for master/provider/per-skill
cases; manual verify: a T3-spawned Claude session no longer lists the skill, while an
interactive `claude` session outside T3 still does.

---

## Phase 5 — Enforcement: Codex

**Files:** `apps/server/src/provider/Layers/CodexAdapter.ts`,
`CodexSessionRuntime.ts:729`, `apps/server/src/provider/Drivers/CodexHomeLayout.ts`

Primary mechanism — config override on the spawn:

1. Build `-c` args and append to `appServerArgs`:
   - per-skill: `-c 'skills.config=[{name="a",enabled=false},{name="b",enabled=false}]'`
   - disable-all: enumerate the scanned skill names into the same override (Codex has no
     global skills-off flag — verified on codex-cli 0.144.1: `codex features list` has
     no `skills` feature).
2. **Smoke-test first** (open Codex issues #14161/#20210 report `skills.config` being
   ignored at project/agent level; the top-level `-c` path is expected to work but must
   be verified against our pinned Codex version).

Fallback (guaranteed) — shadow-home filtering, only if the `-c` route fails:

3. `CodexHomeLayout.ts` already materializes a shadow CODEX_HOME and symlinks `skills`
   as a shared directory (`KNOWN_SHARED_DIRECTORIES`, `:19-29`). Change `skills` from a
   single dir symlink to a materialized dir of per-skill symlinks, omitting disabled
   ones; empty dir when disable-all. Requires shadow-home mode; when
   `shadowHomePath` is unset, fall back to the `-c` override or document the limitation.

**Done when:** with a skill toggled off, a T3-spawned Codex session's skills list (the
`V2SkillsListResponse` snapshot in `CodexProvider.ts:222-254`) no longer includes it;
`~/.codex/skills` untouched.

---

## Phase 6 — Enforcement: OpenCode

**Files:** `apps/server/src/provider/opencodeRuntime.ts` (`buildOpenCodePermissionRules`,
`:216-232`), `OpenCodeAdapter.ts:1076`

1. Extend the per-session `PermissionRuleset` with skill rules:
   - disable-all: `{ permission: "skill", pattern: "*", action: "deny" }` (or session
     config `tools.skill=false` if the SDK exposes it — prefer whichever the SDK
     supports per-session; verify against our pinned OpenCode version).
   - per-skill: `{ permission: "skill", pattern: "<name>", action: "deny" }`.
2. Keep the existing runtimeMode-derived rules intact; skill rules are additive.

**Done when:** OpenCode session omits denied skills from `<available_skills>`; unit test
on `buildOpenCodePermissionRules` output.

---

## Phase 7 — Cursor & Grok handling + docs

1. Enforcement is intentionally **not implemented** (no per-session mechanism exists).
   Settings are still stored so they take effect automatically if the CLIs gain support.
2. Optional best-effort for Cursor (behind a clearly-labeled sub-toggle, default off):
   inject a "do not invoke any skills" instruction into the session context — soft,
   documented as unreliable.
3. Document the capability matrix in `docs/` and surface the same text in the UI
   tooltips. Revisit when Cursor/Grok ship config-level skill controls.

---

## Phase 8 — Tests & end-to-end verification

1. Unit: contracts defaults/patch merge; scanner multi-root; each adapter's arg/rule
   construction (Claude `disallowedTools`, Codex `-c` string, OpenCode ruleset).
2. Integration: settings RPC round-trip + broadcast; Skills tab render states.
3. Manual verify (per `/verify`): toggle `shadcn` off for Claude only → new T3 Claude
   session can't invoke it, T3 Codex session still can, interactive `claude` outside T3
   still can. Repeat inverse for Codex and OpenCode.

---

## Risks / open questions

- **Codex `-c skills.config` reliability** — must be smoke-tested against the pinned
  Codex version before committing to it; shadow-home filtering is the safety net.
- **Skill identity** — `skillId` is the directory name. A user-level and project-level
  skill with the same dir name toggle together (matches current merge behavior; called
  out in the UI via location list).
- **New-session semantics** — toggles apply at spawn; running sessions keep their
  current skill set. UI copy must say so.
- **Disable-all for Codex depends on the scan** — a skill added after the last scan but
  before spawn would slip through until the next session; acceptable, note in docs.
- **`providerInstances` vs legacy `providers.*` settings** — the exact decode chain from
  `ServerSettings.providers.claudeAgent` to the `ClaudeSettings` handed to
  `makeClaudeAdapter` goes through the provider instance registry
  (`ProviderInstanceEnvironment.ts` / `builtInProviderCatalog.ts`); confirm the
  threading point for `SkillToggleSettings` there during Phase 4.
