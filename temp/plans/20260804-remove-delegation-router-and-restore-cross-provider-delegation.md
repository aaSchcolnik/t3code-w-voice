# Remove the delegation router and restore direct cross-provider delegation

**Status:** Ready for implementation  
**Date:** 2026-08-04  
**Branch:** `subagents-and-mcps`

## Goal

Remove the provider-neutral delegation router as a product and runtime concept while preserving the
useful provider-specific delegated-run system:

- `codex_start` / `codex_cancel` / `codex_capabilities`
- `cursor_start` / `cursor_cancel` / `cursor_respond` / `cursor_capabilities`
- `claude_start` / `claude_cancel` / `claude_capabilities`
- tracked lifecycle, transcripts, parent wake-up, provider/model resolution, idempotent starts,
  cancellation, structured Cursor questions, and native-subagent tracking
- the MCP transport/catalog improvements that happened to ship in the same commit as the router
- engine/knowledge-scan provider preferences, which still select the provider-specific tool an agent
  should call and are not themselves the delegation router

The implementation is complete when a Claude parent can start multiple Cursor delegated runs in the
same workspace without a router lease rejection, the provider-specific tools work from every eligible
parent provider, no router surface remains in active contracts/runtime/settings/UI/docs, all repository
checks pass, and an integrated Claude-to-Cursor browser walkthrough succeeds.

## Verified findings

1. `cursor_start` and `claude_start` now call `startActiveDelegatedRun` directly, but all three
   provider-specific handlers still reject starts when `scope.effectiveMcp.router.mode === "off"`.
   `codex_start` is even less consistent: profile-less calls still pass through
   `startCompatibilityDelegation` and the router coordinator.
2. `DelegatedRunService.startInternal` still uses router settings for per-parent/environment
   admission, default timeout, and pre-dispatch fallback. Provider-specific delegation therefore is
   not independent of the router.
3. A real Claude-parent `cursor_start` failure in the read-only live state was recorded as:
   `Another delegated run owns the whole workspace.` A neighboring Claude-to-Cursor run completed,
   proving the Cursor adapter is not universally broken. The reproducible defect is the router-era
   whole-workspace writer lease rejecting a second compatibility start.
4. The focused handler/service/session tests currently pass (47 tests). The handler tests inject a
   service and exercise only one start, so they cannot catch repository admission on a second
   concurrent start.
5. The original router commit also introduced MCP 2026 transport support and useful delegated-run
   reliability/diagnostic work. Reverting the whole commit would remove unrelated functionality and
   make persisted router-era run files unreadable. The change must be surgical.

## Product and architecture decisions

### The surface after removal

- Delete `delegate_start`, `delegate_cancel`, and `delegate_respond` entirely.
- Delete router mode, batch sizing, environment admission, diversity, fallback, explanation, routing
  decisions, route groups, batches, workspace leases, and edit scopes.
- Provider-specific starts are advertised whenever their provider toggle is enabled and a usable
  provider instance exists. They are not gated by another setting.
- A delegated child continues to receive no delegation capability, preventing recursive delegation.
- Direct starts resolve exactly the provider named by the tool. Profiles may still refine that same
  provider's instance/model/options; they may never switch providers.
- Keep the existing fixed limit of four active delegated runs per parent. Remove environment-wide and
  workspace ownership admission. Two provider-specific runs in one workspace MUST be accepted. Agents
  remain responsible for assigning disjoint work when parallel writers are used; T3 no longer claims
  to enforce edit ownership.
- Remove the router-configured deadline and pre-dispatch fallback. A direct run uses one explicitly
  selected provider and retains normal cancellation/restart recovery semantics.

### Contract separation

`packages/contracts/src/delegationRouter.ts` must not survive as an active module. Move only genuinely
provider-agnostic delegated-run contracts to a plainly named module such as `delegation.ts` (or colocate
them in `delegatedRun.ts`):

- idempotency key and request hash
- dispatch-state/attempt/result-completeness diagnostics, if retained by the direct run UI
- direct provider-resolution failure codes actually used by `DelegatedProviderResolver`

Delete router-only types: mode/settings and overrides, neutral task/lane/batch/result schemas, route
decision/summary/policy source, diversity/fallback/explanation, route group/workflow/batch/lane IDs,
delivery mode, edit scopes, and router-only reason codes. Remove their projections from `DelegatedRun`,
`SubagentRun`, and `SubagentRunDetails`. Keep old persisted records readable by decoding and ignoring
unknown router fields; do not keep active public contracts merely to render historical routing data.

### Persistence compatibility

Do not revert blindly to the pre-router JSON array decoder. Existing installations have router-era
envelopes with `runs`, `batches`, `leases`, `idempotency`, `parentDeliveries`, revision, and checksum.

Replace the router repository model with a small delegated-run store whose only responsibilities are:

- atomic run persistence and monotonic update-by-run-id
- parent-scoped idempotent start reservation (`same key + same canonical request => replay`, `same key
  - different request => conflict`)
- the fixed four-active-runs-per-parent admission limit
- parent-delivery durability if the current wake-up reliability path still needs it
- canonical workspace authorization
- startup recovery of non-terminal runs

The decoder must accept the pre-router array and all router-era envelopes. During decode, project runs
through the new direct schema, discard batches/leases/router metadata, rebuild idempotency from retained
run keys/hashes, preserve terminal history, and mark non-terminal runs failed as restart orphans. Add a
fixture-driven migration test using an envelope that contains a whole-workspace lease and route
decision. After migration, a new direct start in that workspace must succeed.

## Implementation sequence

### Phase 0 — Protect the dirty worktree and establish the boundary

1. Read root `AGENTS.md` and `.repos/effect-smol/LLMS.md` before editing Effect code.
2. Capture `git status --short` and `git diff --name-status`; do not use reset, checkout, restore,
   clean, or any Git mutation.
3. Preserve unrelated existing edits, especially the `.repos/alchemy-effect` PNGs and
   `apps/mobile/app.config.ts`. Router-specific dirty edits and the untracked
   `DelegationEditScope.{ts,test.ts}` are in scope for removal.
4. Do not delete untracked `temp/plans` artifacts. Remove shipped router docs/code only.

### Phase 1 — Remove router contracts and settings

1. Delete/split `packages/contracts/src/delegationRouter.ts` and delete its router tests.
2. Update `delegatedRun.ts`, `subagent.ts`, `projectMcpOverrides.ts`, `settings.ts`, their tests, and
   `packages/contracts/src/index.ts` so no active contract exports router settings or routing metadata.
3. Remove `mcp.router` from global/project settings and settings patches. Existing JSON containing that
   now-unknown key must still decode successfully and be normalized away on a later write.
4. Preserve engine delegation role/skill/scanner settings and delegation profiles; they remain useful
   inputs for provider-specific workflows.
5. Update `packages/shared/src/serverSettings.ts` and focused tests so settings merging has no router
   branch.

**Acceptance:** `rg` finds no active `DelegationRouterSettings`, `DelegationMode`, route-decision,
batch, lease, or edit-scope references outside historical/untracked planning artifacts and explicit
legacy migration fixtures.

### Phase 2 — Remove the neutral MCP router surface

1. Delete `apps/server/src/mcp/toolkits/delegationRouter/`.
2. Delete `DelegationRouter.ts`, `DelegationRouterService.ts`, `DelegationCoordinator.ts`,
   `DelegationEditScope.ts`, their tests, and the routing corpus fixture.
3. Remove the router toolkit registration and router/coordinator layers from `McpHttpServer.ts` and
   `server.ts`.
4. Remove the `delegation-router` capability, `trustedRoutingContext`, and `delegationMode` from
   `McpInvocationContext`, `McpProviderSession`, and `McpSessionRegistry`.
5. Keep `McpToolCatalogService` and MCP 2026 transport support, but remove every `delegate_*` catalog
   entry. Provider-specific tool entries remain capability-filtered.
6. Simplify delegation instructions: list only callable provider-specific tools, honor explicit
   provider requests, start all independent runs then yield, never poll, and warn that concurrent
   writers must have disjoint work because T3 no longer leases edit scopes.
7. Revert only the router-specific prose/chain-resolution additions in
   `knowledge/skills/delegation.ts`. Preserve engine-selected provider/model/options and render the
   matching `codex_start`, `cursor_start`, or `claude_start` call with stable idempotency keys.
8. Remove adapter/registry `ProviderDelegationCapabilities` and `getDelegatedCandidates` machinery if
   it has no remaining consumer. Do not disturb provider-instance hydration, model discovery, native
   subagent tracking, or normal ProviderService behavior.

**Acceptance:** both legacy and MCP 2026 `tools/list` expose eligible provider-specific tools and no
`delegate_*` tool; delegated-child credentials expose no `*_start` tool.

### Phase 3 — Make every provider-specific start use the direct run service

1. Make `codex_start`, `cursor_start`, and `claude_start` structurally identical at their boundary:
   require only their own capability, add the fixed provider and parent owner thread, preserve optional
   profile/instance/model/options/idempotency inputs, and call the direct tracked run service.
2. Remove every `mcp.router.mode` check and remove coordinator/repository dependencies from the tool
   schemas/layers.
3. Refactor `DelegatedRunService` to one direct start path. Delete `startResolved`, `startAllocated`,
   route/fallback targets, batch allocation, edit-scope task decoration, router timeout, and router
   fallback logic.
4. Keep provider resolution strict and actionable: configured instance exists, enabled, installed,
   available, owned by the requested driver, requested model/options valid.
5. Retain lifecycle diagnostics that help users understand provider startup (`allocated`, session
   starting/started, dispatch, accepted), but name and type them as direct-run diagnostics rather than
   route attempts.
6. Replace router workspace/environment admission with the fixed per-parent count. Two same-workspace
   starts must reserve and launch independently; the fifth active run for one parent must fail with the
   existing clear limit message.
7. Preserve `cursor_respond`, cancellation ownership checks, parent wake aggregation, transcript
   streaming, server-restart orphan recovery, and Git/workspace safety instructions.

**Acceptance:** no provider-specific handler imports the router/coordinator; a real service-layer test
accepts two concurrent Cursor starts for one Claude-owned parent and invokes ProviderService twice with
`provider: "cursor"`.

### Phase 4 — Remove router presentation while preserving subagents

1. Web: remove the router settings section and helpers/tests from `McpSettings`; retain provider
   toggles and engine-specific delegation editors. Remove route decision, workflow/batch/lane, fallback,
   edit ownership, and scope diagnostics from the Subagents panel/details. Keep provider/model/status,
   attempts if retained, transcript, cancel, and Cursor response UI.
2. Mobile: delete `SettingsRouterRouteScreen`, its presentation helper/tests, Stack route/linking, and
   route/edit-scope details. Keep the subagent list/details/cancel/respond flow.
3. Client runtime: remove router-setting and route/edit-scope presentation helpers. Preserve shared
   subagent subscriptions and control inputs.
4. Docs: delete `docs/internals/delegation-router.md`; rewrite the user subagent documentation around
   explicit provider-specific delegation; update `docs/README.md` and glossary links/definitions.
   Historical files under untracked `temp/plans` are not product documentation and remain untouched.

**Acceptance:** settings contain only provider toggles plus engine-specific options, old persisted
router keys do not crash either client, and old router-era runs render as ordinary delegated runs.

### Phase 5 — Add the missing regression matrix

Add focused tests before relying on the full suite:

1. **MCP session capability matrix:** with all providers installed/enabled and native tracking active,
   Claude gets Codex+Cursor, Codex gets Claude+Cursor, Cursor gets Claude+Codex; same-provider native
   delegation is withheld as today; delegated children get no agent delegation.
2. **Catalog/transport:** legacy and MCP 2026 tool lists contain the provider-specific tools allowed by
   the credential and contain none of `delegate_start`, `delegate_cancel`, `delegate_respond`.
3. **HTTP call path:** use a Claude-scoped MCP credential to call `cursor_start` through the real HTTP
   toolkit registration with a direct-run service stub/fixture; assert the owner thread, provider,
   model/options, and idempotency key reach the service unchanged.
4. **Handler matrix:** every provider-specific handler fixes its own provider regardless of the parent
   provider. Profile and explicit-configuration validation remains covered.
5. **Concurrency regression:** start two Cursor runs for the same parent/workspace before either
   terminates; both allocate and dispatch. Start four total successfully; the fifth receives only the
   per-parent admission error. There must be no workspace-owner/lease error.
6. **Persistence migration:** decode a router-era envelope with batches, leases, route metadata, and
   active/terminal runs; preserve history, fail the orphan, drop router metadata, and allow a new start.
7. **Provider selection:** Claude-to-Cursor calls must start the configured Cursor instance and exact
   resolved model/options; no parent-provider instance may leak into the child start.
8. **UI characterization:** web/mobile settings no longer render router controls, ordinary delegated
   run details still render, and legacy router metadata is ignored safely.

### Phase 6 — Repository verification

Run targeted tests while editing, then the explicit full checks requested for this task. `vp` is not on
the shell PATH in this workspace, so invoke it through pnpm or use the root scripts:

```text
pnpm exec vp test run <focused files>
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Do not substitute `vp check`. Report every command and result. If a full-suite/build failure is
unrelated to the change, verify and identify it with evidence; do not hide it or weaken the check.
Finish with focused `rg` checks for deleted router symbols/tools/settings and `git diff --check`.

### Phase 7 — Integrated browser verification

Use the `test-t3-app` workflow and T3 Preview (preferred) or Helium only if preview is explicitly
unavailable.

1. Start `pnpm dev` against a new disposable `mktemp -d /tmp/t3code-test.XXXXXX` base directory. Never
   point a server at `~/.t3/userdata`, never set `VITE_HTTP_URL`/`VITE_WS_URL`, do not auto-open a
   browser, and capture the spawned PID and actual ports from the dev-runner output.
2. Copy only the settings/secrets required for provider availability into the isolated base directory,
   or configure them through the test UI. Authenticate the controlled browser with a fresh one-use
   pairing URL exactly once.
3. Register this workspace as the project and create a Claude parent thread.
4. Ask Claude to call `cursor_capabilities`, then start **two independent Cursor tasks before ending
   its turn**. Use bounded read-only inspection tasks that do not edit files, while still exercising the
   direct workspace-write delegated-run transport.
5. Verify in the UI and runtime evidence:
   - both `cursor_start` calls are accepted; neither reports a workspace owner/lease conflict
   - both Subagents rows identify Cursor and reach a terminal state
   - transcripts stream and final results wake the Claude parent
   - cancel remains available during a running task
   - no `delegate_*` tool or router setting is visible
   - browser console/runtime has no new error
6. Capture screenshots of the settings surface without router controls and the two completed Cursor
   subagents. If timing/motion is relevant, capture a short recording.
7. Stop only the dev PID captured at spawn after verification is complete. Preserve the isolated state
   directory if it contains useful failure evidence; otherwise remove only that verified temporary
   directory.

## Final acceptance checklist

- [ ] No active delegation-router code, toolkit, capability, settings, UI, or product documentation.
- [ ] No `delegate_start`, `delegate_cancel`, or `delegate_respond` is advertised or callable.
- [ ] Provider-specific tools remain available across eligible parent providers.
- [ ] Claude-to-Cursor parallel starts succeed in the same workspace.
- [ ] Direct starts are not gated by a removed router setting.
- [ ] Direct runs preserve provider/model/options, idempotency, transcripts, cancel/respond, and parent
      wake behavior.
- [ ] Router-era persisted state/settings decode without startup or UI failure.
- [ ] Focused tests, formatting, lint, typecheck, all unit tests, and build pass.
- [ ] Integrated T3 Preview/Helium walkthrough passes with screenshot evidence.
- [ ] Unrelated dirty worktree changes remain intact.
