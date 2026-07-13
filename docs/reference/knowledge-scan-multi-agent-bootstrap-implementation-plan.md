# Multi-Agent Codebase Scan (Knowledge Bootstrap) — Implementation Plan

## Problem statement

The knowledge bootstrap that populates a project's knowledge base (profile, reusable
components, rules, lessons, features) already exists on this branch, but it has two gaps:

1. **It is single-agent.** `engine_knowledge_bootstrap` returns a workflow that the _main
   agent itself_ executes inline — one context window reads manifests, maps layers,
   inventories components, and extracts rules. A fan-out across every provider the user
   has configured (Anthropic, Codex, Cursor, …) would be far more thorough: each provider
   scans independently with its strongest model, then the results reconvene into one
   merged, deduplicated knowledge set.
2. **There is no explicit trigger.** Today the scan only happens if the agent decides to
   follow the template guidance ("if knowledge is empty, run bootstrap"). Nothing in the
   UI lets the user opt in deliberately, and nothing runs automatically. We want an
   explicit, user-initiated **"Scan codebase"** button on the new-thread UI — the user
   decides whether to spend the tokens, and the scan is skipped entirely for projects
   with no code yet.

### Target behavior

- A **"Scan codebase"** button appears in the new-thread / draft UI. Tooltip: _"Performs a
  lookup of the entire codebase to generate a knowledge base for this project (reusable
  components, rules, conventions, lessons)."_
- The button is only enabled when the project **has a codebase** (non-empty workspace)
  and the engine-knowledge capability is on. It is de-emphasized (badge/hint) once the
  knowledge base is already populated, but still available for re-scans.
- Clicking it starts a **new thread** whose main model defaults to **Claude Opus 4.8
  (extra-high reasoning)** when an Anthropic/Claude provider instance is available,
  falling back down a preference chain otherwise. The thread is pre-seeded with the
  scan prompt.
- The main agent (Judge) fans the lookup out to **one scanner per available provider**,
  using per-provider defaults:

  | Provider available | Default scanner model | Effort     |
  | ------------------ | --------------------- | ---------- |
  | Anthropic / Claude | Claude Opus 4.8       | extra-high |
  | Codex              | Codex 5.6 Terra       | extra-high |
  | Cursor             | Grok 4.5              | extra-high |
  | Cursor             | GLM 5.2               | extra-high |

  (Cursor contributes **two** scanners when configured — Grok 4.5 and GLM 5.2.)

- All scanner targets (and the main-thread model preference) are **user-configurable in
  Settings**, following the same chain-editor pattern as the existing Scout / Worker /
  Consensus delegation settings.
- When scanners reconvene, the Judge merges, deduplicates, and reconciles their outputs,
  then saves everything to the knowledge DB as `proposed` (`source: "bootstrap"`), ending
  with the existing user review gate (confirm/reject in the Knowledge settings panel).

### Key constraint to resolve

Delegated runs currently support only `codex | cursor`
(`DelegatedRunProvider`, `packages/contracts/src/delegatedRun.ts`) — Claude cannot be a
delegated subagent. The plan handles this the same way the consensus panel does:
**the Claude lane runs inline in the main thread** (which is already Opus 4.8 xhigh),
while Codex/Cursor lanes run as delegated scanners in parallel. Extending
`DelegatedRunProvider` to include `claudeAgent` is an explicit non-goal here (Phase 6
stretch), matching the existing delegation plan's non-goals.

---

## Phase 1 — Contracts & settings: the `scanner` role and scan defaults

**Goal:** a typed, persisted configuration for "which models perform the codebase scan"
and "which model drives the scan thread".

- `packages/contracts/src/settings.ts`
  - Add a new engine delegation role: `scanner` (alongside `scout | worker | consensus`).
    `EngineDelegationSettings.roles.scanner: EngineDelegationTarget[]` — an ordered
    _panel_ (like consensus: all entries run, it is not a fallback chain).
  - Add `SCANNER_DEFAULTS` and extend `deriveDefaultDelegationRoles()` so availability
    drives the default panel:
    - Codex available → `{ provider: "codex", model: "gpt-5.6-terra", options: { reasoningEffort: "xhigh" } }`
    - Cursor available → two entries: Grok 4.5 and GLM 5.2 (both xhigh where the driver
      supports an effort option).
    - Claude lane is _implicit inline_ (see Phase 3) but represented in settings as an
      `{ provider: "inline", focus: "..." }`-style entry so the UI can show and let the
      user disable it. Reuse the existing inline-fallback representation if one exists;
      otherwise add `EngineDelegationTarget.provider: "inline"` support for this role only.
  - Add `settings.mcp.engine.knowledgeScan` block:
    - `mainThreadModelPreference: ModelSelection[]` — ordered preference for the scan
      thread's main model. Default: `claude-opus-4-8` (xhigh) → best available Codex →
      best available Cursor → project default.
- `packages/contracts/src/model.ts`
  - Add slug aliases for the new defaults where missing (`opus-4.8` already maps to
    `claude-opus-4-8`; add `5.6-terra`/`gpt-5.6-terra` for codex, `grok-4.5`, `glm-5.2`
    for cursor as appropriate).
- `packages/contracts/src/knowledge.ts`
  - Add `ScanLane` / `ScannerReport` schemas (Phase 2's merge contract): lane name,
    scanner identity (provider/model), and typed findings arrays keyed by knowledge
    table (`reusable_components`, `rules`, `lessons_learned`, `features`, profile facts).
- `packages/shared/src/serverSettings.ts` + settings tests: defaults, migration of
  existing persisted settings (missing `scanner` role → derive defaults), round-trip
  tests in `packages/contracts/src/settings.test.ts`.

**Exit criteria:** settings round-trip with the new role; `deriveDefaultDelegationRoles`
unit tests cover all provider-availability combinations; `engine_delegation_get/set`
accept the `scanner` role.

## Phase 2 — Server: multi-agent scan workflow (fan-out plan)

**Goal:** `engine_knowledge_bootstrap` becomes delegation-aware and emits a fan-out plan
instead of a single-agent 6-step checklist — when scanners are configured and the
project has a codebase.

- `apps/server/src/mcp/toolkits/engineKnowledge/handlers.ts`
  - **Codebase detection:** before building the workflow, check the project workspace
    for a non-trivial codebase (any tracked source files / a manifest — cheap heuristic:
    git ls-files count or presence of package manifests). If empty → return the current
    "nothing to scan yet; skip bootstrap" short-circuit. This is the "no code base → no
    scan" rule.
  - Resolve the effective `scanner` panel via the Phase 1 settings +
    `describeDelegatedProviderCapabilities` (drop targets whose provider instance is
    unusable — same pruning the consensus panel does).
  - Emit a **partitioned workflow**: the codebase is split into _lanes by concern_, and
    every scanner covers **all lanes for its own pass** (each provider scans the whole
    codebase independently — that's the thoroughness the feature buys), but each returns
    a `ScannerReport` in the Phase 1 schema. Lanes/sections per report: project profile
    & layer map, reusable components inventory, rules & conventions, lessons/gotchas,
    feature map.
  - If **no delegated scanners** are available (only Claude / no codex/cursor), fall back
    to the current single-agent bootstrap unchanged.
- `apps/server/src/knowledge/skills/templates.ts` + `skills/delegation.ts`
  - New `bootstrap-scan` workflow template: instructs the Judge (main agent) to
    (1) start one `codex_start`/`cursor_start` delegated run per scanner target with the
    scan prompt + report schema, (2) run its **own inline Claude lane** concurrently
    (the main thread _is_ the Claude Opus 4.8 xhigh scanner), (3) await all results,
    (4) proceed to the merge step (Phase 3).
  - Extend `resolveDelegationChains` / `renderDelegationSection` to render the scanner
    panel (mirror `renderConsensusPanelTargets`).
- Respect `MAX_CONCURRENT_RUNS_PER_PARENT` — if the panel exceeds the cap, the template
  instructs batching, and `log`s that in the workflow text (no silent truncation).

**Exit criteria:** with codex+cursor configured, `engine_knowledge_bootstrap` returns a
fan-out workflow naming each scanner target; with none, returns the legacy workflow;
with an empty project, returns the skip message. Handler unit tests for all three.

## Phase 3 — Reconvene: merge, dedupe, persist

**Goal:** N scanner reports become one coherent `proposed` knowledge set.

- New MCP tool `engine_knowledge_merge_reports` (engineKnowledge toolkit):
  - Input: array of `ScannerReport` (validated against the Phase 1 schema).
  - Server-side mechanical pass: normalize + dedupe by table-specific keys (component
    path/export name, rule text similarity via normalized-string match, feature slug).
    Attach provenance: which scanners reported each row (`agreedBy: ["codex/gpt-5.6-terra", ...]`).
  - Output: merged candidate rows + a **conflict list** (rows where scanners disagree on
    substance, not just phrasing) for the Judge to resolve in-context.
- The `bootstrap-scan` template's final steps: call the merge tool, resolve conflicts
  (Judge judgment, favoring multi-scanner agreement), then `engine_knowledge_save`
  everything as `status: "proposed"`, `source: "bootstrap"`, and open an implementation
  case + save the merged scan report as an artifact (`engine_artifact_save`,
  new `ArtifactKind: "knowledge-scan"`).
- Knowledge DB: add `knowledge/Migrations/002_ScanProvenance.ts` — provenance column(s)
  (e.g. `agreed_by` JSON on searchable tables, `scan_run` metadata in `bootstrap_state`).
  Wire into `ProjectKnowledgeStore`'s migrate step (the knowledge DB has its own
  migration system — do **not** touch the main `persistence/Migrations.ts`).
- End state remains the existing **user review gate**: rows land as `proposed` and are
  confirmed/rejected in the Knowledge settings panel.

**Exit criteria:** merge-tool unit tests (dedupe, provenance, conflict detection);
end-to-end: two fake scanner reports → merged proposed rows visible via
`knowledge.query` RPC with provenance.

## Phase 4 — Web UI: the "Scan codebase" button

**Goal:** the explicit user opt-in entry point.

- New-thread / draft UI (`apps/web/src/hooks/useHandleNewThread.ts`,
  `composerDraftStore.ts`, draft route components; also
  `NoActiveThreadState.tsx` for the empty state):
  - Add a **"Scan codebase"** button near the new-thread affordance. Tooltip as specified
    above.
  - Enabled/visible when: a project is selected, the engine-knowledge capability is on
    for that project (per-project MCP overrides respected via
    `resolveEffectiveMcpSettings`), and the workspace has a codebase. Add a lightweight
    RPC `knowledge.scanAvailability` (project → `{ hasCodebase, knowledgePopulated,
availableScanners }`) so the button can gate and the tooltip can enrich ("Knowledge
    base already populated — re-scan?").
  - On click: create a draft/thread with
    - **model**: first usable entry of `knowledgeScan.mainThreadModelPreference`
      (default resolves to Claude Opus 4.8 xhigh when an Anthropic instance exists,
      else next preference) — resolved server-side or via the existing provider
      snapshot the composer already uses for its model picker;
    - **seed prompt**: a fixed scan prompt instructing the agent to call
      `engine_knowledge_bootstrap` and follow the returned workflow;
    - auto-submit (it's an explicit action, the user already opted in).
- Surface scan progress with the existing subagent machinery — delegated scanner runs
  already appear in `SubagentsPanel` / transcript streaming; no new streaming work
  needed.

**Exit criteria:** button renders and gates correctly (no project / empty repo /
capability off); clicking produces a running scan thread on the expected model;
`session-logic.test.ts`-level tests for the draft seeding.

## Phase 5 — Settings UI: scanner panel & main-model preference

**Goal:** everything the defaults chose is user-editable.

- `apps/web/src/components/settings/EngineDelegationSettings.tsx` (inside
  `McpSettings.tsx`): add the **Scanner panel** editor — same provider + instance +
  model + reasoning-effort row editor as Scout/Worker/Consensus, panel semantics
  (all run), including the inline Claude lane toggle.
- Add the **scan thread model preference** editor (ordered `ModelSelection` list) under
  the same section, defaulting per Phase 1.
- `KnowledgeSettings.tsx`: show scan provenance (`agreedBy`) on proposed rows and a
  "last scan" summary from `bootstrap_state`; link to the scan artifact.
- Persist via the existing `usePrimarySettings` / `useUpdatePrimarySettings` path and
  `engine_delegation_set` (now accepting `scanner`).

**Exit criteria:** edits round-trip and change what `engine_knowledge_bootstrap` emits;
removing all scanners degrades to single-agent bootstrap.

## Phase 6 — Hardening, docs, stretch

- **Failure handling:** template guidance + merge tool tolerate partial scanner failure
  (a lane that dies is dropped with an explicit note in the scan artifact — never
  silently). Re-scan is idempotent: merge against existing rows, don't duplicate
  confirmed knowledge (update-or-skip by dedupe key; never downgrade `confirmed` rows
  to `proposed`).
- **Cost guardrail:** the button tooltip / a confirm dialog states this is a heavy,
  multi-model operation before auto-submitting on very large repos (file-count
  threshold from `scanAvailability`).
- **Tests:** e2e happy path with mocked providers; settings-derivation matrix;
  merge-conflict fixtures.
- **Docs:** update `docs/reference/engine-subagent-delegation-implementation-plan.md`
  addendum with the scanner role; document the scan flow in the knowledge feature docs.
- **Stretch (explicitly out of scope for now):** extend `DelegatedRunProvider` with
  `claudeAgent` so the Claude lane can run as a true parallel subagent instead of
  inline; automatic scan suggestion (banner) when a thread starts in a project with an
  empty knowledge base — still user-confirmed, never automatic.

---

## Sequencing & dependencies

```
Phase 1 (contracts/settings)
   └─→ Phase 2 (fan-out workflow) ─→ Phase 3 (merge/persist)
   └─→ Phase 5 (settings UI)                │
Phase 4 (scan button) ──────────────────────┘  (needs 1 for model preference,
                                                full value once 2+3 land)
Phase 6 last.
```

Phases 1–3 make the scan multi-agent; Phase 4 makes it user-triggered; Phase 5 makes it
configurable. Each phase is independently landable behind the existing engine-knowledge
capability gate.
