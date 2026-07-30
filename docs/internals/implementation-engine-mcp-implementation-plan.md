# Implementation Engine MCP — Implementation Plan

Port the CS-skills workflow system (`/Users/aaschcolnik/Documents/CS-skills/`) into t3code's built-in
`t3-code` MCP server as a new capability family — the **Implementation Engine** — with per-ability
toggles in settings and a per-project SQLite knowledge base that replaces every Content Snare /
Angular-specific catalog with project-learned data.

## Source analysis summary (what we're porting)

Five parallel reads of the skill repo and t3code established:

**The skills split cleanly into generic mechanism vs. project-specific content.** The mechanism —
lane routing (Fast/Focused/Full), the plan→shape→chunk pipeline, the chunk-loop state machine
(`chunks.json`, `find-next-chunks.js`, `update-chunk-status.js`), enrichment budgeting (`enrich.js`),
the dual HTML report system (`report-helpers.cjs` + `report-base-template.html` for data reports,
`generate-styled-plan.cjs` + styled template for presentation plans), and typescript-magician
(already 100% generic) — carries over nearly as-is. The Content Snare specificity is concentrated in:

1. **Three JSON catalogs** in `cs-dev-enrich`: `rules-catalog.json` (24 concerns × rules/gotchas/imports),
   `examples-catalog.json` (7 Angular code templates), `feature-catalog.json` (36 product features).
2. **`audit.js`** (2,856 lines, ~50 Angular/signals-specific static checks) + `audit-checklist.md`/`tier-2-rules.md`.
3. **`scan-ui-components.js`** (hardcoded CS component/directive/library maps) and
   `count-legacy-patterns.js` (18 legacy vs 14 modern Angular regex patterns).
4. **Prose embedded in SKILL.md files**: layer vocabulary (`@domain`/`@feature`/`@ui`/`@lib`/`@core`),
   Serena memory names, `CSD-\d+` ticket regexes, `akturatech/contentsnare-client` repo slug,
   branch conventions (`development`/`master`), i18n path `public/assets/i18n/en/`, `xdg-open`,
   Angular MCP / Linear MCP / Figma MCP tool names, `.agents/...` path prefix, `contentsnare/` tile namespaces.
5. **Shared guideline docs** (`implementation-standards.md`, `test-standards.md`, `ui-element-guide.md`,
   `e2e-*.md`) — entirely stack-specific; these become per-project knowledge, not shipped content.

**t3code already has the hosting architecture.** Capability gating exists end-to-end:
`McpCapability` union (`apps/server/src/mcp/McpInvocationContext.ts:10`) → per-capability booleans in
`McpSettings` (`packages/contracts/src/settings.ts:43`) → `McpSessionRegistry.issue()` gate list
(`apps/server/src/mcp/McpSessionRegistry.ts:121-129`) → `requireMcpCapability()` in every handler →
toggle rows in `apps/web/src/components/settings/McpSettings.tsx`. SQLite runs via
`@effect/sql-sqlite-bun` (+Node fallback) with a migration runner (`apps/server/src/persistence/`),
but only as one global `state.sqlite` — per-project DBs are new. A thread's project/worktree resolves
through `ProjectionThreadRepository` (`apps/server/src/persistence/Services/ProjectionThreads.ts`);
`McpInvocationScope` currently carries only `threadId`.

## Design decisions

- **D1 — One capability family, per-ability gating.** Extend the existing `t3-code` MCP server rather
  than shipping a second MCP server. Each ability is its own `McpCapability` so settings toggles map
  1:1 to enforcement: `engine-planning`, `engine-enrich`, `engine-implement`, `engine-quality`,
  `engine-performance`, `engine-typescript`, plus `engine-knowledge` (the SQLite tools, required by
  the others and auto-enabled when any ability is on).
- **D2 — Skills are served as instructions, not executed server-side.** MCP tools can't run
  multi-phase agent workflows. Each ability tool (`engine_plan`, `engine_audit`, …) returns the
  genericized SKILL workflow as markdown, pre-hydrated with the project profile, matched rules,
  reusable components, and lessons from SQLite — the calling agent then executes the workflow. This is
  how the skills become framework-agnostic: the same workflow text, different injected knowledge.
- **D3 — Knowledge lives in one SQLite DB per project**, stored server-side at
  `<stateDir>/knowledge/<projectId>.sqlite` (not inside the repo — keeps user repos clean, survives
  worktrees, and multiple checkouts of one project share a brain). Keyed by `ProjectId`; resolved from
  the MCP scope's `threadId` via `ProjectionThreadRepository`.
- **D4 — Rows carry provenance.** Every knowledge row has `status: proposed | confirmed | rejected`
  and `source: bootstrap | agent | user`. Agents write `proposed`; the user confirms via the web UI
  (or the agent relays confirmation). Ability tools serve confirmed rows always and proposed rows
  flagged as unverified.
- **D5 — Static checks become rule packs, not a ported `audit.js`.** The 2,856-line Angular scanner
  is not portable. Quality abilities run from DB-stored audit rules (id, severity, description,
  detection hint, fix guidance) that the agent evaluates with its own tools (grep/read). We ship two
  seed packs: `generic` (language-agnostic: complexity, security, dead code, error handling) and
  `angular-signals` (derived from audit.js's checklist — so Content Snare loses nothing). Packs are
  imported into a project's DB at bootstrap based on detected stack; users/agents add project rules over time.
- **D6 — Report system ships as server assets + one rendering tool.** `report-helpers.cjs` logic,
  both HTML templates, and the style guide port to TypeScript in the server. A single
  `engine_report_render` tool takes markdown (+ kind: `report | styled-plan`), renders themed HTML,
  and stores it as an artifact (D8) — never into the project tree. The Content Snare-specific
  `Verified/Inferred/Unknown` badge convention stays (it's a good convention), documented in the template.
- **D7 — Naming.** Ability family: "Implementation Engine". Tool prefix `engine_*` / `engine_knowledge_*`.
  No `cs-` anywhere. External-service couplings (Linear, Figma, Serena, Angular-docs MCP) become
  optional generic steps: "if a ticket/design/docs MCP is connected, use it; otherwise skip/ask".
- **D8 — All workflow outputs live in the DB, not the project tree.** The CS-skills convention of
  writing `temp/plans/`, `temp/implement/<slug>/`, `temp/reports/` into the repo is replaced by an
  `artifacts` table in the per-project knowledge DB. Every plan, context file, chunk spec, chunk-loop
  state document, stress-test report, audit report, and rendered HTML is a row keyed by
  `(case_slug, kind, seq)` and grouped into an implementation case. Reads through the artifact tools
  bump `last_accessed_at`; a background sweeper deletes artifacts not read or written for **21 days**
  (plans stop clogging the workspace and expire on disuse). Markdown remains the canonical plan format
  (per D2 workflows produce markdown); HTML is a rendered artifact alongside it. When a human wants to
  view an HTML artifact in a browser, it is materialized on demand to the OS temp dir (or served over
  the existing authenticated HTTP server) — never written into the user's repo. Knowledge tables
  (profile/components/lessons/rules/features) are explicitly **exempt** from TTL cleanup; only
  artifacts expire.

## Phase 1 — Contracts, capabilities, settings

1. `packages/contracts/src/settings.ts`: add `McpEngineSettings` struct — booleans
   `planning`, `enrich`, `implement`, `quality`, `performance`, `typescript` (all default **false**;
   unlike preview, this is opt-in) — nested as `mcp.engine` in `ServerSettings` + mirrored in
   `ServerSettingsPatch` (all `Schema.optionalKey`).
2. `apps/server/src/mcp/McpInvocationContext.ts`: extend `McpCapability` union with the seven
   `engine-*` members. Extend `McpInvocationScope` with `projectId` and `worktreePath`
   (resolved at issue time — see Phase 2 step 3).
3. `apps/server/src/mcp/McpSessionRegistry.ts` (`issue()`): add gating lines — each
   `settings.mcp.engine.<ability>` adds its capability; any of them also adds `engine-knowledge`.
4. `apps/web/src/components/settings/McpSettings.tsx`: new "Implementation Engine" section in the
   existing MCP panel — one `SettingsRow`+`Switch` per ability with descriptions
   (Planning, Enrichment, Implementation loop, Quality audits, Performance analysis, TypeScript expert).
5. Tests: settings decode defaults, registry capability-set derivation, patch round-trip
   (extend `serverSettings.test.ts`, `McpSessionRegistry.test.ts`).

## Phase 2 — Per-project knowledge store (SQLite)

1. **`ProjectKnowledgeStore` service** (`apps/server/src/knowledge/ProjectKnowledgeStore.ts`,
   `Context.Service`): `forProject(projectId)` returns a scoped handle opening (and caching, with
   idle-close) `<stateDir>/knowledge/<projectId>.sqlite` using the existing
   `makeRuntimeSqliteLayer` machinery with a dynamic dbPath + its own migration list
   (`apps/server/src/knowledge/Migrations/`). WAL + foreign keys, same as `Sqlite.ts`. Add the
   `knowledge/` dir to `ensureServerDirectories` (`apps/server/src/config.ts`).
2. **Schema** (migration 001):
   - `project_profile` — single row: framework, language, package_manager, test_runner, async_model
     (e.g. "RxJS, no promises"), state_management, component_library, styling, i18n, layer_model
     (JSON: layer names + import matrix), path_aliases (JSON), file_suffix_conventions (JSON),
     ticket_pattern (regex), default_branch, notes.
   - `reusable_components` — name, kind (component/directive/hook/util/service/store), import_path,
     summary, when_to_use, props_or_api (JSON), example_snippet, keywords (JSON), consumer_count,
     status, source, created_at, updated_at.
   - `lessons_learned` — title, body (symptom/root-cause/guidance), category
     (never-do/prefer/gotcha/debugging), scope_glob (optional path scope), keywords (JSON), status, source, timestamps.
   - `rules` — concern (free text, replaces the fixed concern vocabulary), risk (high/medium/low),
     rule_text, gotchas (JSON), imports (JSON), example_template, keywords (JSON), status, source, timestamps.
   - `audit_rules` — pack (generic/angular-signals/custom), rule_id, tier (1/2), severity,
     description, detection_hint, fix_guidance, enabled, status, source.
   - `features` — key, name, summary, keywords (JSON), capabilities (JSON), relationships (JSON),
     gotchas (JSON), when_touched_ask (JSON), status, source, timestamps. (Direct port of the
     feature-catalog schema — it was already generic.)
   - `bootstrap_state` — phase, completed_at, stats (JSON).
   - `implementation_cases` — id, case_slug (unique), title, kind (plan-brief/plan/implement/audit/pr-review/hot-loops/report-only),
     status (active/completed/abandoned), created_at, last_accessed_at. Groups all artifacts of one
     piece of work (the old `temp/implement/<slug>/` directory becomes one case).
   - `artifacts` — id, case_id (FK → implementation_cases, ON DELETE CASCADE), kind
     (plan/knowledge/context/chunk-spec/chunk-state/stress-test/edge-cases/concern-map/lift-audit/
     audit-report/pr-review/hot-loops/html-report), seq (per case+kind ordering; replaces the
     `00-ticket.md`…`07-stress-test.md` numbering), title, format (markdown/json/html), content (TEXT),
     content_hash, created_at, updated_at, last_accessed_at. Unique index on `(case_id, kind, seq)`.
     Every read via the artifact tools updates `last_accessed_at` on both the artifact and its case.
   - FTS5 virtual tables (or LIKE-based keyword match fallback) over components/lessons/rules/features
     for the query tools.
3. **Artifact TTL sweeper**: an Effect fiber started with the knowledge layer (and re-run on a daily
   schedule plus on each `forProject` open) deletes `implementation_cases` — cascading to their
   artifacts — where `last_accessed_at < now - 21 days`, then `VACUUM`s opportunistically. TTL constant
   lives in one place (`ARTIFACT_TTL_DAYS = 21`); log a one-line summary of what was purged. Knowledge
   tables are never touched by the sweeper.
4. **Project resolution**: in `McpSessionRegistry.issue()`, look up the thread via
   `ProjectionThreadRepository` and bake `projectId`/`worktreePath` into the scope (option (a) from
   the architecture read — one lookup at issue time, not per tool call).
5. Tests: store open/migrate/cache lifecycle, two-projects isolation, schema round-trips, TTL sweeper
   (expired case purged with artifacts, fresh case kept, read bumps `last_accessed_at` and rescues a
   near-expiry case, knowledge tables untouched).

## Phase 3 — Knowledge toolkit (`engine-knowledge` capability)

New toolkit `apps/server/src/mcp/toolkits/engineKnowledge/{tools.ts,handlers.ts}` mirroring the
`codexAgent/` pattern (`Tool.make` + `Toolkit.toLayer`, `requireMcpCapability("engine-knowledge")` first):

- `engine_knowledge_status` — profile summary + row counts + bootstrap state. This is the entry
  point every ability workflow calls first; if the DB is empty it returns bootstrap instructions.
- `engine_knowledge_search` — table (components/lessons/rules/features/audit_rules), query keywords,
  optional scope path, limit; returns ranked matches. Replaces `feature-lookup.js` + `enrich.js` catalog reads.
- `engine_knowledge_get` — full record by table+id (replaces `get-example.js`).
- `engine_knowledge_save` — upsert row(s) as `proposed` (or `confirmed` when `confirmed: true` is
  passed after explicit user approval relayed by the agent). Validates against per-table schemas.
- `engine_knowledge_bootstrap` — returns the bootstrap analysis workflow: instructs the calling agent
  to detect the stack (read package.json/config files), map layers/aliases, inventory the most-reused
  components (imports ranking, the `count-consumers` idea expressed as instructions), extract
  conventions from lint configs/CONTRIBUTING/CLAUDE.md/AGENTS.md, then submit everything via
  `engine_knowledge_save` and present the proposed profile to the user for confirmation. Also selects
  which seed audit-rule pack(s) to import (server-side import triggered by a `packs` argument).
- Seed packs ship as JSON assets in `apps/server/src/knowledge/packs/` (`generic.json`,
  `angular-signals.json` — the latter transcribed from `audit-checklist.md`/`tier-2-rules.md`).

**Artifact tools** (same toolkit, same `engine-knowledge` capability — D8):

- `engine_case_open` — create or resume an implementation case by slug (returns case id, existing
  artifact index with kinds/seqs/titles, and status). Ability workflows call this first instead of
  `mkdir temp/implement/<slug>`; resuming an existing case is the replacement for the skills'
  "resume check if temp/... exists" steps.
- `engine_artifact_save` — upsert artifact content by `(case_slug, kind, seq)`; returns id. Size-capped
  per artifact (~1 MB) with a clear error telling the agent to split.
- `engine_artifact_get` — fetch by id or `(case_slug, kind, seq)`; bumps `last_accessed_at`. Supports
  `head_lines` for the skills' "read TL;DR only" two-pass loading pattern.
- `engine_artifact_list` — list cases (with age + expiry countdown) or artifacts within a case.

Register the toolkit layer in `McpHttpServer.layer` (unconditional, like the existing three).
Tests: capability rejection, search ranking, proposed/confirmed lifecycle, bootstrap pack import,
artifact CRUD + access-bumping + head-lines truncation.

## Phase 4 — Ability toolkits (skill content, genericized)

Skill workflows become markdown templates in `apps/server/src/knowledge/skills/` (bundled assets),
with `{{placeholders}}` hydrated from the project DB at call time. One thin toolkit
`apps/server/src/mcp/toolkits/engine/` exposes them:

| Tool                                           | Capability         | Source skills                                                                               | Genericization notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine_plan_brief`                            | engine-planning    | cs-plan-brief                                                                               | Concern vocabulary → DB rules concerns; feature lookup → `engine_knowledge_search features`; Serena memories → lessons search; ENTITIES section reworded generically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `engine_plan`                                  | engine-planning    | cs-plan-implement (+ detail's GWT/UX-states discipline folded in as the "full detail" path) | Context-gathering subagents become optional generic steps (ticket MCP if connected, design MCP if connected, docs if available); `CSD-\d+` → profile `ticket_pattern`; layer-boundary hard-fail → profile `layer_model` import matrix; `temp/implement/<slug>/plans/*` → artifacts in one case (`kind=context` seq-numbered for the old `00-ticket`…`06-web-research` files, `kind=stress-test`, `kind=plan`, `kind=knowledge`); keeps R/S fit-check matrix, stress-test phase, plan+knowledge outputs verbatim as markdown.                                                                                                                   |
| `engine_enrich`                                | engine-enrich      | cs-dev-enrich                                                                               | `enrich.js` logic reimplemented server-side: seed/expand modes, risk-ordered budgeting — but rules/gotchas/imports/examples come from the `rules` table and features from `features`. Scope snapshots (describe-component) become instructions using the agent's own read tools.                                                                                                                                                                                                                                                                                                                                                               |
| `engine_implement`                             | engine-implement   | cs-dev-implement                                                                            | Chunk pipeline preserved: chunk state machine, spec files, concern-placement gate, independent completeness check, retry classification (compile vs test failure). `find-next-chunks`/`update-chunk-status` logic becomes two small tools (`engine_chunks_next`, `engine_chunks_update`) operating server-side on the case's `kind=chunk-state` artifact (the old `chunks.json`, now a DB row — still the crash-survivable source of truth, and TTL-rescued every time the loop touches it); chunk specs are `kind=chunk-spec` artifacts. Test command comes from profile `test_runner`; changelog/i18n-cleanup steps gated on profile fields. |
| `engine_quality_audit`, `engine_quality_quick` | engine-quality     | cs-quality-audit, cs-quality-quick-audit                                                    | audit.js execution → `audit_rules` table walk (D5); false-positive filter + severity/disposition/suppression conventions kept; `audit-finding-outcomes` feedback loop → lessons_learned writes via `engine_knowledge_save`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `engine_quality_pr`                            | engine-quality     | cs-quality-pr                                                                               | Semantic-block grouping, blast radius, cross-cutting checks, verdict rubric all kept; repo slug/base-branch from profile (`default_branch`) + `gh` detection; layer grouping from profile `layer_model`; symbol tracing reworded to "use your language/LSP tools".                                                                                                                                                                                                                                                                                                                                                                             |
| `engine_hot_loops`                             | engine-performance | cs-hot-loop-analyzer                                                                        | Category A–E checks are already framework-agnostic; Category F (Angular) served only when profile framework matches, with room for equivalent packs per framework (React deps arrays, etc. — future).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `engine_typescript`                            | engine-typescript  | typescript-magician                                                                         | Ships nearly verbatim (skill + 13 rule files); drop the two CS references. Only served when profile language is TypeScript.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `engine_report_render`                         | any engine cap     | shared/report                                                                               | D6+D8. Markdown → themed HTML (`report` kind) or scaffold+fill contract (`styled-plan` kind); stores the result as a `kind=html-report` artifact on the case and returns its id plus a view URL/materialized OS-temp path for opening in a browser. Port `report-helpers.cjs` (escapeHtml, markdownToHtml, mermaid sanitize, section/TOC builders) to TS with unit tests.                                                                                                                                                                                                                                                                      |

Cross-cutting rewrites applied to all workflow texts: Fast/Focused/Full lane contract kept (ported
`skill-runtime-lanes` as a shared preamble section); `.agents/...` paths → tool calls;
`xdg-open` → "open in browser via preview tool if available, else report the path"; Serena symbol
tools → "your code navigation tools"; TodoWrite/subagent phrasing kept abstract ("track these phases",
"delegate to a subagent if your harness supports it") since Claude/Codex/Cursor all consume this MCP.

Also: extend `delegationPolicy.ts`-style system-prompt injection so sessions with engine capabilities
get a one-paragraph advert ("Implementation Engine tools are available: call `engine_knowledge_status`
before coding tasks; use `engine_plan`/`engine_implement`/… for structured workflows").

## Phase 5 — Web UI: knowledge review panel

1. RPCs in `packages/contracts/src/rpc.ts` + handlers in `apps/server/src/ws.ts` (+ auth scopes):
   `knowledge.listProjects`, `knowledge.query` (table+filter+pagination), `knowledge.upsert`,
   `knowledge.setStatus` (confirm/reject, bulk), `knowledge.deleteRow`, `knowledge.getProfile`,
   `knowledge.updateProfile`, plus artifact RPCs: `knowledge.listCases`, `knowledge.listArtifacts`,
   `knowledge.getArtifact` (bumps `last_accessed_at`, so viewing a plan in the UI also rescues it
   from expiry), `knowledge.deleteCase`. Atom commands in `packages/client-runtime/src/state/server.ts`.
2. New settings-adjacent panel (route `settings.knowledge.tsx` or a per-project view): project
   selector → tabbed tables (Profile / Components / Lessons / Rules / Audit rules / Features) with
   a "Pending review" filter surfacing `proposed` rows for one-click confirm/reject — this is the
   "present to the user to define if correct" flow from the requirements.
3. **Artifacts tab**: cases listed with age and an "expires in N days" countdown; expanding a case
   shows its artifacts; markdown rendered inline, HTML artifacts openable in a browser tab; manual
   delete per case. No pinning mechanism in v1 — opening an artifact resets its 21-day clock, which
   is exactly the requested retention behavior.
4. Badge count of pending proposals on the nav item.

## Phase 6 — Verification

1. Unit/integration tests across phases (already listed per phase); `McpHttpServer.test.ts` coverage
   for the two new toolkits' registration + capability rejection paths.
2. End-to-end manual pass: enable abilities in settings → start a Claude session on a fresh project →
   `engine_knowledge_status` triggers bootstrap → confirm proposals in the web panel → run
   `engine_plan` + `engine_implement` on a small feature → run `engine_quality_audit` → render an HTML
   report and open it from the Artifacts tab → verify a second project gets an isolated DB → verify
   nothing was written into either project's working tree (no `temp/`, no `.t3/engine/`).
3. TTL pass: backdate a case's `last_accessed_at` in a test DB, trigger the sweeper, confirm the case
   and its artifacts are gone while knowledge rows and fresh cases survive.
4. Confirm delegated (subagent) sessions: engine capabilities should be available to delegated runs
   too (unlike codex/cursor-agent which exclude `delegatedSession`) — they operate on the same project DB.

## Out of scope (deliberate)

- Porting `audit.js`/`scan-ui-components.js`/`count-legacy-patterns.js` as executable scanners
  (replaced by rule packs; the scripts remain usable inside Content Snare's own repo).
- E2E pipeline skills (`cs-test-e2e`, e2e-requirements/standards) — too bespoke; a later rule-pack candidate.
- cs-plan-shape / cs-analyze-_ / cs-fix-_ skills — follow-ups once the core ten prove out.
- Cross-project knowledge sharing/export, team sync of knowledge DBs.
- Automatic knowledge capture hooks (auto-saving lessons without agent intent).

## Risks

- **Instruction-serving fidelity**: skills relied on the Claude skill harness (TodoWrite, subagents,
  slash-command chaining). Served-as-tool-output workflows must stay self-contained; mitigated by the
  abstract phrasing rewrite and by `engine_implement`'s state living in the DB chunk-state artifact,
  not the harness.
- **Artifacts leaving the repo changes agent habits**: agents can no longer `cat temp/plans/foo.md`;
  every workflow text must consistently route reads/writes through the artifact tools, and
  `engine_case_open`'s artifact index is the replacement for directory listing. A missed rewrite shows
  up as an agent writing to the repo — Phase 6 step 2 explicitly checks for this.
- **TTL surprise**: a user returning after >3 weeks finds the plan gone. Mitigated by the expiry
  countdown in the Artifacts tab and by the fact that any read (agent or UI) resets the clock;
  accepted per the requirement that stale plans disappear.
- **Bootstrap quality** varies by codebase; mitigated by proposed/confirmed review gate (D4).
- **Tool-surface size**: ~14 new tools on one MCP server; names are prefixed and capabilities hide
  nothing at list time (matching existing behavior), so disabled abilities still appear in tool lists —
  acceptable today (preview behaves the same), revisit if providers mishandle it.
- **DB keyed by `projectId`**: renaming/re-adding a project orphans its DB; acceptable, note in docs.
