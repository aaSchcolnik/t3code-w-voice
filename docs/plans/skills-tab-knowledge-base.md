# Implementation Plan: "Skills" Tab in the Knowledge Base

**TLDR:** This is easily performed. The knowledge base UI already has a clean tab
system, and the project root is already known server-side
(`ProjectionProject.workspaceRoot`). The only genuinely new piece is a filesystem
scanner — t3code has never read project directories for agent config before
(verified: no CLAUDE.md/AGENTS.md/skills scanning exists anywhere; the
`knowledge/skills/templates.ts` folder is unrelated — those are Implementation
Engine workflow prompts).

## Design decision: live scan, not analysis-time capture

The idea of capturing skills during project analysis or when a thread starts was
considered. Neither is used as the foundation — instead, **scan the project
directory on demand when the tab opens**, because:

- There is no existing "project analysis" step to hook into. Bootstrap is
  agent-driven and optional, so snapshot-based capture would leave many projects
  empty.
- Skills live on disk and change outside t3code (git pulls, manual edits). A live
  scan is always correct; a snapshot goes stale.
- The scan is cheap (a few `readdir`s and small file reads), so it needs no DB
  table, no migration, and no invalidation logic.

**What counts as a skill:** `.claude/skills/<name>/SKILL.md` (Claude Code
convention) and `.agents/skills/<name>/SKILL.md` (open Agent Skills convention),
parsing frontmatter `name`/`description`. Presence of `CLAUDE.md`/`AGENTS.md` at
the root is surfaced as "agent instructions detected" metadata on the same tab.

## Phase 1 — Contracts + server-side scanner

1. **Schemas** in `packages/contracts/src/knowledge.ts` (~line 205, next to the
   other UI-facing schemas):
   - `ProjectSkill { name, description, path, source: "claude" | "agents" }`
   - `KnowledgeListSkillsInput { projectId }`
   - `KnowledgeSkillsResult { skills, agentFiles: { claudeMd, agentsMd }, scannedRoot: string | null }`
2. **RPC wiring** in `packages/contracts/src/rpc.ts`:
   - Add `WS_METHODS["knowledge.listSkills"]` (~line 250-260)
   - Add an `Rpc.make` definition with the `knowledgeError` union (~line 373-426)
   - Register it in the RPC group (~line 836-846)
3. **New scanner service** `apps/server/src/knowledge/ProjectSkillScanner.ts` (an
   Effect service; `ProjectFaviconResolver.ts` is the precedent for a small
   read-only filesystem service). Lists skill directories, reads `SKILL.md` with a
   size cap, extracts frontmatter with a tolerant regex (no YAML dependency needed
   for two fields; fall back to directory name). All filesystem errors degrade to
   empty results, and the whole scan gets `Effect.timeoutOption` — the OpenCode
   probe taught us unbounded probes freeze the UI. Unit tests against temp-dir
   fixtures.
4. **Handler** in `apps/server/src/ws.ts`:
   - Add the method to the read-scope group (~line 321-331)
   - Add a handler next to the other knowledge handlers (~line 1351-1450) that
     resolves `workspaceRoot` via `projectionProjects.getById` and calls the
     scanner (returning `scannedRoot: null` + empty lists when the root is
     missing, never an error)
   - Provide the scanner layer into the runtime (~line 2085)

## Phase 2 — Client atom + web UI tab

5. **Atom** in `packages/client-runtime/src/state/server.ts`: add
   `knowledgeListSkills` via `createEnvironmentRpcQueryAtomFamily` (~line 301-323,
   same pattern as `knowledgeQuery`).
6. **UI** in `apps/web/src/components/settings/KnowledgeSettings.tsx`:
   - Extend the `KnowledgeTab` union (line 42-49) and `tabs` array (line 50-58)
     with `skills`
   - Special-case it in the render filter (line 586-596) like `profile`/`artifacts`
   - New `<SkillsView>` component: skill cards with name, description, source
     badge, and path; a header row for detected CLAUDE.md/AGENTS.md; empty and
     "project directory unavailable" states; and a refresh button (which, being a
     live scan, is the entire staleness story). Reuses the existing project
     selector (lines 489-513) as-is.

## Phase 3 — Optional enrichment (ship later or skip)

- **Provider-reported skills**: the Codex provider already receives a skills list
  from the Codex app-server (`CodexProvider.ts:362` →
  `CodexAppServerProviderSnapshot.skills`). Merge those in with a "reported by
  Codex" badge — this catches user-global and plugin skills the filesystem
  heuristic can't see.
- **User-global skills**: optionally scan `~/.claude/skills` and show as a
  separate "Global" section.
- **Thread-start prefetch**: the thread-start idea survives as a latency
  optimization — where `ws.ts:1669` computes the effective cwd
  (`thread.worktreePath ?? workspaceRoot`), fire the same scan and cache in memory
  so the tab opens instantly. Same code path, and it naturally handles worktrees
  having different skills than the main root.

## Effort

Phases 1–2 are small — a ~150-line scanner + tests, ~30 lines of
copy-the-adjacent-pattern plumbing across contracts/ws/atoms, and one view
component. Each Phase 3 item is independent and skippable.
