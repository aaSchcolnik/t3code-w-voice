# Skills in SQLite — Versioned, User-Editable Engine Skills

## Goal

Move the engine workflow "skills" out of hardcoded TypeScript and into the global
SQLite database (`state.sqlite`), so that:

- Skills are **versioned**: every edit creates a new immutable version; the user picks
  the active version from a dropdown (v1, v2, v3, …).
- Skills are **global**: they follow the user across every project inside T3 Code —
  no per-project skills folder needed.
- Skills are **user-editable**: a new **Skills** settings tab lists them with
  edit (pencil, tooltip "Edit"), delete (trash, tooltip "Delete"), and add
  (plus icon next to the header) actions, plus a markdown editor rendered the same
  way T3 Code presents markdown elsewhere.
- Each skill still declares its **agent flow** (which subagents to call, which
  provider/model/reasoning effort per role), configured in the same UI style the MCP
  tab uses today.
- The **built-in skills ship as seeded defaults** (v1 of each), deletable by the user.
- Agents inside T3 Code chat can **create and update skills** through MCP tools, and
  those writes land in the same SQLite store.

## Feasibility & current state (what we found)

This is feasible with no architectural blockers. Key facts about the codebase today:

1. **Where skill content lives now.** All ten workflow prompts are markdown template
   literals in one constant: `workflows: Record<EngineWorkflowName, string>` at
   `apps/server/src/knowledge/skills/templates.ts:16-205`. Workflow names come from
   `ENGINE_WORKFLOW_NAMES` in `packages/contracts/src/settings.ts:48-61`:
   `plan-brief`, `plan`, `consensus`, `enrich`, `implement`, `quality-audit`,
   `quality-quick`, `quality-pr`, `hot-loops`, `typescript`.
2. **How they are served.** Each has a static MCP tool (`engine_plan`, `engine_implement`,
   …) in `apps/server/src/mcp/toolkits/engine/tools.ts`; the shared `workflow()`
   generator in `apps/server/src/mcp/toolkits/engine/handlers.ts:88-181` picks the
   template, resolves the delegation chain, and hydrates it via
   `hydrateWorkflow()` (`templates.ts:207-255`), which substitutes
   `{{CONSENSUS_DISAGREEMENT_GATE}}` / `{{CONSENSUS_MODE_PROTOCOL}}` placeholders and
   appends the delegation section + project knowledge. **The hydration pipeline stays;
   only the template source changes** (DB row instead of TS constant).
3. **Agent flow config already exists.** `EngineDelegationSettingsSection`
   (`apps/web/src/components/settings/EngineDelegationSettings.tsx`) already renders
   per-role chains with provider / provider-instance / model / reasoning-effort
   selects (`ChainEditor`, lines 167-435) and per-workflow overrides
   (`WorkflowOverride`, lines 590-694). This UI moves into the new Skills tab,
   scoped per skill.
4. **SQLite patterns to copy.** Main DB migrations are numbered files registered in
   `apps/server/src/persistence/Migrations.ts` (latest: `033_ProjectMcpOverrides`).
   Repositories follow the Service/Layer split (canonical example:
   `Services/ProjectionProjects.ts` + `Layers/ProjectionProjects.ts`, with JSON
   columns via `Schema.fromJsonString`). The knowledge DB's `artifacts` table
   (`knowledge/Migrations/001_InitialKnowledgeSchema.ts:64-70`) already proves the
   versioned-markdown shape (`content`, `seq`, `content_hash`, `UNIQUE(..., seq)`) —
   but it is per-project and TTL-swept, so skills get their **own global tables**
   in `state.sqlite`.
5. **Out of scope / not to be confused.** `ProjectSkillScanner`
   (`apps/server/src/knowledge/ProjectSkillScanner.ts`) scans filesystem
   `.claude/.agents/.cursor/.codex` skill folders for provider skill discovery. That
   is a separate feature and is untouched by this plan.

### Design decisions

- **Two tables, not one.** `skills` (identity + active-version pointer) and
  `skill_versions` (immutable snapshots). Versions are append-only; "edit" = insert
  version N+1 and point `active_version` at it. Rolling back is just moving the
  pointer — no data loss.
- **Versions are full snapshots: markdown content AND agent-flow config together.**
  Each `skill_versions` row carries both the prompt body and the delegation config
  (`delegation_json`, the existing `EngineDelegationSkillOverride` shape: roles →
  `EngineDelegationTarget[]` with `provider`, `providerInstanceId`, `model`,
  `options` incl. reasoning effort, `focus`). Selecting v2 in the version dropdown
  restores exactly the agents/models that version ran with, not just its text.
  Changing only the agent flow (without touching the markdown) also creates a new
  version — any change to a skill is a new version.
- **Built-in skills keep their dedicated MCP tools** (`engine_plan`, etc. — tool
  handlers now load content from the DB by slug). **Custom user skills** are served
  through two new generic tools: `engine_skill_list` and `engine_skill_run(slug)`
  (MCP tool sets are registered statically at server layer build in
  `McpHttpServer.ts:227-232`, so dynamic per-skill tool names are not worth the
  complexity; a generic runner gives identical capability).
- **Delete restores are cheap.** Deleting a built-in skill removes its rows; a
  "Restore default skills" action re-seeds any missing built-in at v1. (Defaults are
  kept in code as seed data only — the runtime never reads them directly after Phase 3.)
- **Fallback safety.** If the DB row for a built-in workflow is missing (deleted by
  user), the corresponding `engine_*` tool returns a clear "skill deleted" error
  rather than silently falling back — matching the user's expectation that delete
  means delete.

---

## Phase 1 — Data layer: schema, repository, seeding

**Deliverable:** skills persisted in `state.sqlite`, seeded with the ten built-ins,
full CRUD available server-side. No behavior change for MCP or UI yet.

1. **Migration `034_Skills.ts`** in `apps/server/src/persistence/Migrations/`
   (register in `migrationEntries` in `Migrations.ts`):

   ```sql
   CREATE TABLE IF NOT EXISTS skills (
     skill_id        TEXT PRIMARY KEY,          -- ulid/uuid
     slug            TEXT NOT NULL UNIQUE,      -- "plan", "implement", or user slug
     title           TEXT NOT NULL,
     description     TEXT NOT NULL DEFAULT '',
     source          TEXT NOT NULL CHECK (source IN ('builtin','user','agent')),
     capability      TEXT,                      -- engine capability gate for built-ins, NULL for custom
     active_version  INTEGER NOT NULL DEFAULT 1,
     enabled         INTEGER NOT NULL DEFAULT 1,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS skill_versions (
     skill_id        TEXT NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
     version         INTEGER NOT NULL,
     content         TEXT NOT NULL,             -- markdown, may contain {{PLACEHOLDER}} tokens
     delegation_json TEXT,                      -- EngineDelegationSkillOverride snapshot for this version
     content_hash    TEXT NOT NULL,             -- hash over content + delegation_json
     change_note     TEXT,                      -- optional "what changed"
     created_by      TEXT NOT NULL CHECK (created_by IN ('seed','user','agent')),
     created_at      TEXT NOT NULL,
     PRIMARY KEY (skill_id, version)
   );
   ```

2. **Contracts** in a new `packages/contracts/src/skills.ts` (exported from the
   package index): `SkillRecord`, `SkillVersionRecord`, `SkillSummary` (list-row
   without content), input schemas (`SkillCreateInput`, `SkillSaveVersionInput`
   with `{ content, delegation?, changeNote? }`, `SkillSetActiveVersionInput`,
   `SkillUpdateMetaInput`, `SkillDeleteInput`),
   and a tagged `SkillError`. Reuse `EngineDelegationTarget` /
   `EngineDelegationSkillOverride` from `settings.ts` for the per-version delegation
   JSON column
   (decode with `Schema.fromJsonString`, same as `mcp_overrides_json` in
   `Layers/ProjectionProjects.ts:23-31`).

3. **Repository** following the ProjectionProjects pattern:
   - `apps/server/src/persistence/Services/Skills.ts` — `SkillRepository`
     Context.Service with: `list`, `getBySlug(slug)` (joins the active version's
     content + delegation), `getVersions(skillId)`, `getVersion(skillId, version)`,
     `create(input)` (inserts skill + v1),
     `addVersion(skillId, { content, delegation }, createdBy, changeNote?)` (computes
     next version + hash over content and delegation together; skips insert if the
     hash equals the current active version's),
     `setActiveVersion`, `updateMeta` (title/description/enabled only —
     delegation is version data),
     `delete(skillId)`, `seedDefaults(defaults)` (idempotent: insert only slugs not
     present — so a user deletion is NOT resurrected on restart; a separate
     `restoreDefault(slug)` re-seeds one explicitly).
   - `apps/server/src/persistence/Layers/Skills.ts` — `SkillRepositoryLive` using
     `SqlSchema.findAll/findOneOption/void`, errors via `toPersistenceSqlError`.

4. **Seed data module** `apps/server/src/knowledge/skills/defaults.ts`: exports
   `DEFAULT_SKILLS: ReadonlyArray<{ slug, title, description, capability, content }>`
   built from the existing `workflows` constant in `templates.ts` (content moved
   verbatim, including `{{CONSENSUS_*}}` placeholders and the shared
   `lanePreamble`/`evidence` fragments inlined). Also record each built-in's default
   delegation guidance (the `workflowGuidance` prose from `delegation.ts:63-112`)
   as part of the seeded markdown under a `## Delegation guidance` heading so it is
   user-editable too (see Phase 3 for how it's consumed). Seeded v1 rows carry
   `delegation_json = NULL`, meaning "inherit the global role defaults" — the
   pre-migration behavior.
   - Deletion tombstones: add a `deleted_builtin_slugs` piece of state (simplest:
     a `skills_tombstones (slug TEXT PRIMARY KEY)` table in the same migration)
     written on delete of a builtin, checked by `seedDefaults`, cleared by
     `restoreDefault`.

5. **Wiring:** merge `SkillRepositoryLive` into the server layer set
   (`apps/server/src/server.ts` alongside `ProjectionProjectRepositoryLive`),
   provide it in `ws.ts` (~line 2160 block), and call `seedDefaults` once during
   server startup after migrations run.

6. **Tests:** repository unit tests (create/version/rollback/delete/seed-idempotency,
   tombstone behavior) mirroring `ProjectionSnapshotQuery.test.ts` style.

---

## Phase 2 — RPC surface: contracts → server → client-runtime

**Deliverable:** the web client can list, read, create, edit, version-switch, and
delete skills. Follow the exact wiring used by `knowledge.*` methods.

1. **`packages/contracts/src/rpc.ts`:** add `WS_METHODS` entries —
   `skillsList: "skills.list"`, `skillsGet: "skills.get"` (returns skill + versions +
   active content), `skillsCreate: "skills.create"`, `skillsSaveVersion:
"skills.save-version"` (payload `{ content, delegation?, changeNote? }` — a
   version snapshots both), `skillsSetActiveVersion: "skills.set-active-version"`,
   `skillsUpdateMeta: "skills.update-meta"` (title/description/enabled only),
   `skillsDelete: "skills.delete"`, `skillsRestoreDefaults: "skills.restore-defaults"`.
   Define each `Rpc.make(...)` with the Phase-1 schemas and add to `WsRpcGroup`.

2. **`apps/server/src/ws.ts`:** register read methods under
   `AuthOrchestrationReadScope` (~line 327), pull `SkillRepository` from context
   (~line 486), add handlers to the `WsRpcGroup.of({...})` map wrapped in
   `observeRpcEffect(..., { "rpc.aggregate": "skills" })`.

3. **`packages/client-runtime/src/state/server.ts`:** queries via
   `createEnvironmentRpcQueryAtomFamily` (`skillsList`, `skillsGet`), mutations via
   `createEnvironmentRpcCommand` (create / save-version / set-active-version /
   update-meta / delete / restore-defaults), matching the `knowledgeUpsert` pattern
   at lines 374-397.

4. **Tests:** one round-trip test per mutation through the ws handler layer
   (existing `serverSettings.test.ts` / ws test style).

---

## Phase 3 — Engine integration: serve skills from SQLite

**Deliverable:** MCP workflow tools read prompt content and delegation defaults from
the DB. Custom skills become invocable. `templates.ts`'s `workflows` constant is
deleted (content lives only in `defaults.ts` seed data + DB).

1. **`hydrateWorkflow` refactor** (`templates.ts:207-255`): change its input from
   implicit lookup of the `workflows` constant to an explicit `template: string`
   parameter. Placeholder substitution (`{{CONSENSUS_*}}`), delegation-section
   append, task-context and knowledge-snapshot append all stay identical.

2. **`engine/handlers.ts` `workflow()`** (`handlers.ts:88-181`): resolve the skill by
   slug via `SkillRepository.getBySlug(name)`:
   - Found + enabled → use `activeVersion.content` as the template.
   - Found + disabled → capability-style error ("skill disabled in settings").
   - Missing (user deleted it) → error telling the agent the skill was removed and
     can be restored from Settings → Skills.
   - Per-skill delegation: `resolveDelegationChains` currently reads
     `settings.skillOverrides[workflow]`; extend resolution order to
     **activeVersion.delegation_json → settings.skillOverrides → role defaults**,
     keeping `EngineDelegationSettings` global roles as the base layer. Because the
     delegation snapshot lives on the version, switching the version dropdown swaps
     both the prompt AND the agents/models the skill runs with.

3. **Custom-skill tools** in the engine toolkit (`engine/tools.ts` + handlers):
   - `engine_skill_list` — returns slug/title/description/version info for enabled
     custom skills (built-ins excluded; they have dedicated tools).
   - `engine_skill_run` — `{ slug, task }` → hydrates the custom skill's active
     content through the same pipeline (delegation section included when the skill
     has delegation config). Gate both behind an existing broad capability
     (`engine-knowledge`).

4. **Agent-authored skills** — the "ask T3 Code chat to create a skill" path:
   - `engine_skill_save` — `{ slug, title, description, content, delegation? }`;
     creates the skill (source `agent`) or appends a new version if the slug exists,
     returning the new version number. `created_by = 'agent'`. When updating an
     existing skill without passing `delegation`, carry the current active
     version's delegation forward into the new version (agents editing prose
     shouldn't silently reset the agent flow).
   - Add a short section to the engine developer instructions (where MCP usage
     guidance is rendered for providers, e.g. `CodexDeveloperInstructions.ts` and the
     Claude/OpenCode equivalents) stating: when the user asks to create or modify a
     T3 Code skill, use `engine_skill_save` — skills are stored in T3 Code's database
     with versioning, not in project files.

5. **Delegation guidance from content:** `renderDelegationSection` currently uses the
   hardcoded `workflowGuidance` map (`delegation.ts:63-112`). Parse the optional
   `## Delegation guidance` section from the skill markdown (scout/worker/
   consensus/judge bullet list) and use it when present, falling back to the
   hardcoded map for robustness. This makes the delegation prose user-editable
   without a schema change.

6. **Tests:** update `engine` handler tests for DB-sourced templates (happy path,
   deleted, disabled, custom run, agent save-new vs save-version), delegation
   precedence tests in `delegation.test.ts`.

---

## Phase 4 — Skills settings tab (UI)

**Deliverable:** a new **Skills** tab in Settings, presented like the MCP tab, with
list, per-skill agent-flow config, version dropdown, edit / delete / add.

1. **Navigation & route:**
   - Add `"/settings/skills"` to `SettingsSectionPath` and a
     `{ label: "Skills", to: "/settings/skills", icon: <lucide icon, e.g. SparklesIcon> }`
     entry in `SETTINGS_NAV_ITEMS` (`SettingsSidebarNav.tsx:31-54`).
   - New route file `apps/web/src/routes/settings.skills.tsx` (copy
     `settings.mcp.tsx`), rendering a new `SkillsSettingsPanel`.

2. **`SkillsSettingsPanel`** (`apps/web/src/components/settings/SkillsSettings.tsx`),
   built from `SettingsPageContainer` / `SettingsSection` / `SettingsRow`
   (`settingsLayout.tsx`) so it reads like the MCP tab:
   - **Header:** "Skills" section title with a `PlusIcon` icon-button
     (`Button size="icon-xs" variant="ghost"`) as the section `headerAction`,
     wrapped in `Tooltip`/`TooltipTrigger`/`TooltipPopup` ("New skill" tooltip) —
     same pattern as `SettingResetButton` (`settingsLayout.tsx:98-120`).
   - **Skill list:** one `Card` per skill (data from the `skillsList` query atom via
     `useEnvironmentQuery`): title, description, `Badge` for source
     (Built-in / Custom / Agent-created), enabled `Switch`, and in `CardAction`:
     - **Version dropdown:** `Select`/`SelectTrigger`/`SelectPopup`/`SelectItem`
       listing `v1 … vN` (from `skillsGet`), current = `active_version`; selecting
       calls the `skillsSetActiveVersion` command and refreshes.
     - **Pencil icon** (`PencilIcon`, tooltip **"Edit"**) → opens the editor view.
     - **Trash icon** (`Trash2Icon`, tooltip **"Delete"**) → `AlertDialog`
       confirmation (pattern: `KnowledgeSettings.tsx:765-786`), then `skillsDelete`.
   - **"Restore default skills"** ghost button at the section footer →
     `skillsRestoreDefaults` (only shown when at least one built-in is missing).

3. **Skill editor** (inline expanded view or dedicated sub-route
   `settings.skills.$skillId.tsx` — dedicated sub-route recommended for room):
   - **Content editing:** split view — `Textarea` (monospace) on the left / toggle,
     live preview rendered with **`ChatMarkdown`**
     (`apps/web/src/components/ChatMarkdown.tsx`) so skills are presented exactly the
     way T3 Code renders markdown everywhere else.
   - **Metadata:** title + description fields → `skillsUpdateMeta` (not versioned).
   - **Agent flow:** embed the existing chain-editing UI — extract `ChainEditor`
     from `EngineDelegationSettings.tsx` into a shared component and render one
     editor per role (scout / worker / consensus / scanner) bound to the version's
     `delegation_json`. This is the same provider / instance / model /
     reasoning-effort select stack users already know from the MCP tab.
   - **Saving:** one Save action commits the editor state — markdown + agent flow
     together — via `skillsSaveVersion`, creating vN+1 and setting it active; an
     optional "change note" input maps to `change_note`. Changing only the agent
     flow also produces a new version. No-op saves (identical combined hash)
     surface as "no changes". Selecting an older version in the dropdown loads
     that version's markdown and agent flow into the editor read-only until the
     user activates it or forks it into a new version.
   - **New skill flow (plus icon):** dialog asking for slug + title, then opens the
     editor with a starter template (front-matter-style heading + empty sections),
     saved as v1 via `skillsCreate`.

4. **MCP tab cleanup:** `McpSettingsPanel` keeps the toolkit toggles and
   Implementation Engine capability switches; the per-workflow
   `WorkflowOverride` list inside `EngineDelegationSettingsSection` is removed
   (superseded by per-skill delegation in the Skills tab). Global role chains
   (default scout/worker/consensus/scanner) stay in the MCP tab as the base layer.

5. **Tests:** presentation-logic tests (version dropdown ordering, delete/restore
   visibility) in the `session-logic.test.ts` / `skillToggleLogic.test.ts` style.

---

## Phase 5 — Polish, docs, verification

1. **Empty/edge states:** all skills deleted (tab shows restore CTA; MCP tools return
   the "removed" error), very large skill bodies (enforce a 256 KiB cap in
   `addVersion`, mirroring the artifact 1 MiB cap), slug collisions on create
   (unique-constraint error surfaced in the dialog), concurrent edits (last write
   wins is fine — versions mean nothing is lost).
2. **Version housekeeping:** no automatic pruning (versions are small text rows);
   optionally add a "delete version" affordance later — not in this scope.
3. **Docs:** update `docs/per-provider-skill-toggles.md` cross-references; add
   `docs/skills-store.md` describing the schema, versioning semantics, and the
   `engine_skill_*` tools for agent authors.
4. **End-to-end verification:**
   - Fresh DB → seeds ten built-ins at v1; MCP `engine_plan` output is byte-identical
     to the pre-migration hardcoded output (snapshot test).
   - Edit `implement` in the UI (change both the markdown and, say, the worker
     model) → v2 active → MCP tool serves v2 content with the v2 agent flow →
     dropdown back to v1 → tool serves v1 content AND the v1 agents/models.
   - Create a custom skill in the UI → `engine_skill_list`/`engine_skill_run` serve it.
   - Ask an agent in chat to create a skill → row appears in the Skills tab with
     source "Agent".
   - Delete a built-in → confirm dialog → tool errors with the removal message →
     restore defaults brings it back at v1.

## Risks & notes

- **Placeholder integrity:** users can edit/delete `{{CONSENSUS_*}}` tokens in the
  consensus skill. Hydration must tolerate missing placeholders (skip substitution)
  rather than error. A soft lint in the editor ("this skill normally contains
  {{CONSENSUS_MODE_PROTOCOL}}") is a nice-to-have.
- **Capability gating for built-ins** currently maps workflow → engine toggle in
  `handlers.ts:57-68` (`capabilityByWorkflow`). The `capability` column preserves
  this; custom skills ride the broad `engine-knowledge` capability.
- **Static MCP tool names:** custom skills do not get their own `engine_<slug>` tool
  because toolkits are registered at layer build. If per-skill tools become a hard
  requirement later, MCP `listChanged` notifications + per-session toolkit assembly
  in `McpSessionRegistry` is the follow-up — deliberately out of scope here.
- **Project scope:** skills are global by design (the point of this feature). The
  existing project `mcpOverrides` delegation overrides continue to work as a layer
  on top; per-project skill _content_ overrides are a possible future phase.
