# Codex delegation fix — event fiber lifetime + `command_lifecycle` work-log noise

Implementation plan for the two defects found while diagnosing the failed Codex
delegation on branch `subagents-and-mcps` (2026-07-11).

## Symptoms

1. A Claude parent session delegated a research task to Codex via the t3-code MCP
   (`codex_start`). The Subagents panel showed the run stuck at **Running** with an
   empty transcript forever; `codex_status` never progressed; the run never completed,
   was never persisted to `delegated-runs.json`, and produced no work-log activity.
2. The parent session's Work Log showed a red-X error row:
   `Claude SDK message 'command_lifecycle' — command_uuid: … · state: started`.

These are **two independent bugs**. (2) is cosmetic and unrelated to (1).

## Evidence

- t3code's delegated-run event log
  (`~/.t3/dev/logs/provider/delegated-7a851ddd-….log`) receives startup events
  normally, then goes silent at `23:11:07.798` — the last entries are
  `turn/started` (CANON `turn.started`) and the t3-code `mcpServer/startupStatus`
  "ready" notification.
- Codex's native rollout for the same thread
  (`~/.codex/sessions/2026/07/11/rollout-…019f5372….jsonl`) shows the agent kept
  working for 34 more seconds — dozens of `function_call`s, agent messages — and
  finished with `task_complete` and a full final answer at `23:11:41`. None of it
  reached t3code.
- The two Cursor delegations from the same afternoon completed end-to-end
  (full transcripts, terminal status in `delegated-runs.json`).

## Root cause (bug 1)

`CodexAdapter.startSession` forks the per-session event pump — the fiber that
consumes `runtime.events` and feeds both the native event log and
`runtimeEventQueue` — with **`Effect.forkChild`**
(`apps/server/src/provider/Layers/CodexAdapter.ts:1470-1485`). `forkChild` ties the
fiber's lifetime to the _calling fiber_.

`DelegatedRunService.start` runs `startSession` + `sendTurn` inside a short-lived
**`Effect.forkDetach`** fiber
(`apps/server/src/orchestration/DelegatedRunService.ts:448-505`). Codex's
`sendTurn` resolves as soon as `turn/start` responds (turn _created_, not
finished), so that detached fiber marks the run "running" and completes within
milliseconds. When it completes, its `forkChild` children are interrupted — the
event pump dies, and every subsequent Codex notification (`item/*`,
`turn/completed`, token usage) is produced by the runtime into its internal queue
but never consumed. The run can never observe `turn.completed`, so it stays
"running" forever.

Why the other paths don't show it:

- **Normal (non-delegated) Codex sessions** — `startSession` is called from
  `ProviderRuntimeIngestion`'s long-lived stream loop
  (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1838`), a
  fiber that never completes, so the child pump survives.
- **Cursor delegation** — `CursorAdapter.sendTurn` awaits the entire ACP
  `session/prompt` (`CursorAdapter.ts:1006`), so the detached delegated-run fiber
  stays alive for the whole turn and emits `turn.completed` from inside `sendTurn`
  itself. The same latent `forkChild` pattern exists there
  (`CursorAdapter.ts:876`) and in `GrokAdapter.ts:878`; it just isn't load-bearing
  for single-turn delegated runs.

## Fix overview

| Phase | Change                                                                 | Files                                           |
| ----- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| 1     | Fork the Codex event pump into the session scope, not the caller fiber | `CodexAdapter.ts`                               |
| 2     | Same change for the Cursor and Grok notification fibers (latent)       | `CursorAdapter.ts`, `GrokAdapter.ts`            |
| 3     | Stop rendering `command_lifecycle` SDK messages as errors              | `ClaudeAdapter.ts`                              |
| 4     | Regression tests                                                       | `CodexAdapter.test.ts`, `ClaudeAdapter.test.ts` |

No contract, schema, or client changes. No data migration: stuck runs are
in-memory only (never persisted), so a server restart clears them.

---

## Phase 1 — Codex event pump lifetime (the actual bug)

**File:** `apps/server/src/provider/Layers/CodexAdapter.ts`

At line 1485, change the event fiber fork from caller-fiber-scoped to
session-scoped:

```ts
// before
).pipe(Effect.forkChild);

// after
).pipe(Effect.forkIn(sessionScope));
```

Why `sessionScope` is the right lifetime:

- It is created per session at line 1449, transferred into the `sessions` map
  entry (`sessionScopeTransferred = true`, line 1513), and closed by
  `stopSessionInternal` (line 1685) and by the adapter-level `stopAll` finalizer.
  That is exactly "as long as the session lives".
- The runtime already uses the same idiom for its internal fibers
  (`CodexSessionRuntime.ts:1144/1177/1204` use `Effect.forkIn(runtimeScope)`).

Adjacent code that stays as-is (verify while editing):

- `stopSessionInternal` (line 1686) still explicitly interrupts
  `session.eventFiber`. With `forkIn`, closing the scope already interrupts it;
  the explicit interrupt becomes a harmless no-op. Keep it (defensive) or drop
  it — either is fine, but if dropped, keep the `Scope.close` ordering.
- The `runtime.start()` error path (lines 1497-1503) closes `sessionScope` and
  interrupts `eventFiber`; both remain correct.
- The `sessions` map entry keeps storing the fiber handle (`eventFiber`, line 1510) — `Effect.forkIn` still returns a `Fiber`, so no type changes.

## Phase 2 — same latent pattern in Cursor and Grok adapters

**Files:** `apps/server/src/provider/Layers/CursorAdapter.ts` (line 876),
`apps/server/src/provider/Layers/GrokAdapter.ts` (line 878)

Both adapters fork their per-session `notificationFiber` with `Effect.forkChild`
inside `startSession`, with the same `sessionScope` + `sessionScopeTransferred`
structure around them. Apply the identical change:

```ts
Effect.forkChild → Effect.forkIn(sessionScope)
```

(Use whatever the local scope variable is named in each adapter; both create it
just before building the runtime, mirroring Codex.)

Note: Cursor delegation currently _works_, but only because its `sendTurn`
blocks for the whole turn. Any future caller that starts a Cursor/Grok session
from a short-lived fiber (multi-turn delegated runs, background session warm-up,
a reworked ingestion) would silently lose all notifications after the caller
exits — same failure mode, harder to spot. Fix all three in one pass.

**Not part of this bug:** `ClaudeAdapter.ts:2824` also uses `forkChild`, but for
a _bounded_ MCP-status poller (20 × 500 ms) whose parent is the long-lived SDK
stream consumer — its lifetime is intentional. Leave it.

## Phase 3 — `command_lifecycle` rendered as a red-X error

**File:** `apps/server/src/provider/Layers/ClaudeAdapter.ts`

The Claude Code CLI now emits `command_lifecycle` SDK messages (background
command started/completed, with `command_uuid` + `state`). The installed
`@anthropic-ai/claude-agent-sdk@0.3.170` typings do **not** include it in the
`SDKMessage` union, so it falls through `handleSdkMessage`'s `switch`
(line 3133) to the `default` branch, which calls `emitRuntimeWarning`
(line 3156) — rendered as a red-X error row in the Work Log. The parent session
in the incident logged 8 of these (started/completed pairs) while it polled the
delegated run with a background command.

Because the type isn't in the SDK union, a `case "command_lifecycle":` label
won't typecheck. Instead, add a string-keyed allowlist checked before the
`default` warning:

```ts
// SDK message types the CLI emits but @anthropic-ai/claude-agent-sdk@0.3.170
// does not model yet. They carry no transcript content; log at debug instead
// of surfacing a work-log warning.
const UNMODELED_BENIGN_SDK_MESSAGE_TYPES: ReadonlySet<string> = new Set(["command_lifecycle"]);
```

In `handleSdkMessage`'s `default` branch (lines 3155-3161):

```ts
default:
  if (UNMODELED_BENIGN_SDK_MESSAGE_TYPES.has((message as { type: string }).type)) {
    yield* Effect.logDebug("ignoring unmodeled Claude SDK message", {
      type: (message as { type: string }).type,
    });
    return;
  }
  yield* emitRuntimeWarning(/* unchanged */);
```

The message still lands in the native NDJSON log via `logNativeSdkMessage`
(line 3130), so nothing is lost for debugging. Genuinely unknown message types
keep producing the warning.

When the SDK dependency is bumped to a version that types `command_lifecycle`,
promote it to a real `case` (likely alongside the other telemetry types routed
to `handleSdkTelemetryMessage`) and delete it from the set.

## Phase 4 — regression tests

### CodexAdapter — event pump survives the starting fiber (the core regression)

`apps/server/src/provider/Layers/CodexAdapter.test.ts` already has the pieces:
`makeRuntimeFactory()` builds a fake runtime with an `emit(event)` helper backed
by a queue (lines 62-163), and adapters are constructed with
`options.makeRuntime`.

Add a test:

1. Build the adapter with a fake runtime factory.
2. Run `adapter.startSession(...)` **inside a fiber that then completes**, e.g.
   `yield* Effect.forkChild(adapter.startSession(input))` followed by
   `Fiber.await` — after the await, the starting fiber is done, mimicking
   `DelegatedRunService`'s detached fiber.
3. Then `yield* runtime.emit({ kind: "notification", method: "turn/completed", ... })`.
4. Assert the mapped event arrives on `adapter.streamEvents` (existing
   `Stream.runHead` pattern in the file).

With `forkChild` this test hangs/times out (event never delivered); with
`forkIn(sessionScope)` it passes. Mirror the same test shape in
`CursorAdapter.test.ts` / `GrokAdapter.test.ts` if their fakes support it
cheaply; otherwise the Codex test covers the shared idiom.

### DelegatedRunService — end-to-end completion (already exists, re-verify)

`DelegatedRunService.test.ts` drives runs with a stubbed `ProviderService`, so
it cannot catch this fiber bug (the stub doesn't fork). No change required, but
re-run it: the `turn.completed` → run-completed → `stopSession` path is what the
Phase 1 fix newly exercises in production.

### ClaudeAdapter — `command_lifecycle` no longer warns

In `ClaudeAdapter.test.ts`, feed a synthetic
`{ type: "command_lifecycle", command_uuid: "…", state: "started" }` message
through the SDK stream fake and assert **no** `runtime.warning` event is
emitted (and that a genuinely unknown type, e.g. `type: "bogus_message"`, still
produces one).

## Verification

1. `vp run typecheck` and `vp test run` in `apps/server` (repo gates: `vp check`,
   `vp run typecheck` per AGENTS.md).
2. Manual end-to-end (the incident scenario):
   - Start the dev stack, open a Claude session, ask it to delegate a small
     read-only research task to Codex.
   - Expect: Subagents panel streams Codex items live; run reaches
     **completed**; `codex_result` returns the final message; the run appears in
     `~/.t3/dev/delegated-runs.json`; the provider log
     `~/.t3/dev/logs/provider/delegated-<runId>.log` contains `item/*` and
     `turn/completed` entries (it previously stopped at `turn/started`).
   - The parent Work Log shows no `command_lifecycle` red-X rows while polling.
3. Sanity-check a normal (non-delegated) Codex session and a Cursor delegation
   still stream correctly after the fork changes.

## Risks / notes

- `Effect.forkIn(sessionScope)` widens the pump's lifetime from
  "caller fiber ∩ session" to "session". The session scope is closed on
  `stopSession`, `stopAll`, adapter layer teardown, and the `runtime.start()`
  error path, so there is no leak path; this is strictly the intended lifetime.
- After Phase 1, delegated Codex runs will start reaching the
  `turn.completed` branch of `DelegatedRunService.handleProviderEvent`
  (`DelegatedRunService.ts:277-297`), which stops the provider session and
  unregisters the thread mapping — code that was previously unreachable for
  Codex. The existing service tests cover it, but watch the first manual run for
  double-stop noise (`stopSession` is idempotent via the `stopped` flag).
- The 23:18:24 "session resurrected then immediately stopped" tail seen in the
  incident log was the cancel path recovering a session just to interrupt it —
  a consequence of the stuck run, not a separate defect; no action.
