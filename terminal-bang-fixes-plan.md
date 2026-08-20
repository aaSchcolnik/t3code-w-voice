# Terminal bang fixes: environment hygiene, multi-line header, copy button

## Background: what the investigation found

### The `nvm use` + `prep` failure

The bang executed the multi-line command correctly — `nvm use` read `.nvmrc` and node
v24.19.0 ran the whole chain. The crash (`TypeError: indexedResults is not iterable` in
eslint's multithread worker aggregation) was **not reproducible** in three attempts under
the same conditions (same repo, node 24.19.0, PTY, interactive zsh). The crash site is a
known robustness gap in eslint's `--concurrency` worker code: `runWorkers`
(`eslint/lib/eslint/eslint.js:489-515`) has no `worker.on("exit")` guard and no payload
validation, so one malformed/extra worker-port message kills the whole `ng` process. The
likeliest trigger was heavy machine load (auto-sized workers, no load awareness) — an
upstream eslint fragility, not a T3 bug per se.

**However**, the investigation found a real T3 defect in the same area: the bang shell
inherits the T3 server's own process environment nearly wholesale. When the server is a
pnpm dev runner, every bang child gets:

- `NODE_CHANNEL_FD=3` + `NODE_CHANNEL_SERIALIZATION_MODE=json` — every node process in the
  bang believes it's a `child_process.fork` child with an IPC channel on an fd it doesn't own
- `NODE_PATH` pointing into t3code's pnpm store — CJS fallback resolution reaches into a
  foreign repo's node_modules
- `npm_*` / `pnpm_config_*` / `COREPACK_*` lifecycle vars from t3code's own `pnpm run dev`
  (`npm_package_json`, `npm_lifecycle_event=dev`, `INIT_CWD`, `PNPM_SCRIPT_SRC_DIR`, …)
- `PATH` prefixed with t3code's `node_modules/.bin`
- `NO_COLOR=1`, `COLORTERM=""` — bang output is silently colorless even though it runs in a PTY

This is exactly the class of contamination that makes "works in my terminal, fails in a
bang" bugs, and it's cross-project: `npm run` for another repo inside a bang inherits
t3code's npm lifecycle state. Whether or not it caused this specific eslint crash, it must
go. This is the root-cause-class fix.

Two adjacent defects found while auditing the spawn path (fix alongside):

- **Bang is broken on the packaged desktop app.** `CommandProcess.ts:159` spawns the
  supervisor via `process.execPath`, but `spawnEnv.ts` strips `ELECTRON_RUN_AS_NODE` — on
  packaged desktop that launches the Electron GUI instead of Node. The user's bang only
  worked because they were on the worktree dev server (real node binary).
- **Shell parity gaps.** The bang shell is interactive but not login (`-i`, not `-l -i`),
  so `~/.zprofile`/`~/.zlogin` never run, unlike Terminal.app. And
  `CommandProcess.ts:152-156` drops the resolved shell candidate's `args` (zsh's
  `-o nopromptsp` used by the interactive terminal at `Manager.ts:1597`).

### The header bug

`TerminalCommandRecord.command` stores the multi-line string verbatim (newlines intact —
that's why execution was correct). The web header (`TerminalCommandRow.tsx:239`) renders it
in a single truncating `<span>`, and HTML whitespace collapsing turns `nvm use\nprep` into
`nvm use prep`. Mobile (`ThreadFeed.tsx:871`) has the same single-`Text` rendering.
Display-only bug.

### Copy button

Web already has `MessageCopyButton` (`apps/web/src/components/chat/MessageCopyButton.tsx`,
used for user messages in `MessagesTimeline`), a clipboard hook with "Copied!" toast.
Mobile already has an ANSI-strip helper `terminalCommandPlainText`
(`ThreadFeed.tsx:137-142`). The row already knows how to page in the full retained output
via `terminalEnvironment.execReadOutput` (`TerminalCommandRow.tsx:200-220`).

---

## Work item 1 — Stop leaking the server's environment into bang shells

**Files:** `apps/server/src/terminal/spawnEnv.ts`, `apps/server/src/terminal/spawnEnv.test.ts`

Widen `TERMINAL_ENV_BLOCKLIST` / `shouldExcludeTerminalEnvKey` (the allowlist approach was
deliberately rejected per the comment near `Manager.ts:944`; stay with a targeted blocklist):

- Exact keys: `NODE_CHANNEL_FD`, `NODE_CHANNEL_SERIALIZATION_MODE`, `NODE_PATH`,
  `NODE_OPTIONS`, `INIT_CWD`, `PNPM_SCRIPT_SRC_DIR`, `WATCH_REPORT_DEPENDENCIES`
- Prefix rules: `npm_` / `NPM_CONFIG_`, `pnpm_` / `PNPM_`, `COREPACK_`, `NODE_REPL_`

Note the blast radius: `createTerminalSpawnEnv` is shared by the interactive terminal
(`Manager.ts:1659`) and bang (`CommandProcess.ts:148`), so this changes both surfaces.
That's desirable — the interactive terminal has the same contamination — but call it out in
the PR.

Color/TTY hygiene: the bang child _is_ a TTY (node-pty), yet inherits `NO_COLOR=1` and an
empty `COLORTERM` from the dev runner. In the bang path's `runtimeEnv`, clear `NO_COLOR`
and set `COLORTERM=truecolor` (matching what a real terminal advertises). Skip
`FORCE_COLOR` — the PTY makes forcing unnecessary.

Tests: extend `spawnEnv.test.ts` with cases per new rule (leaked pnpm-dev env fixture in,
clean env out; assert benign vars like `NG_LINT_FLAGS`, `HOME`, `PATH` survive).

## Work item 2 — Fix the supervisor on packaged desktop

**Files:** `apps/server/src/terminal/CommandProcess.ts`, `CommandProcess.test.ts`

On packaged desktop `process.execPath` is the Electron binary and needs
`ELECTRON_RUN_AS_NODE=1` to behave as node — but `spawnEnv` strips that key, so the
supervisor spawn launches the GUI. Fix: set `ELECTRON_RUN_AS_NODE=1` on the supervisor's
env explicitly when the server itself runs under it (after `createTerminalSpawnEnv`), and
`delete process.env.ELECTRON_RUN_AS_NODE` inside `COMMAND_SUPERVISOR_SOURCE` next to the
existing `T3CODE_BANG_*` deletes, so the user's shell doesn't inherit it.

Also: a supervisor-level failure currently reads as a genuine `exit 1` in the UI. Emit a
distinct failure (e.g. supervisor exits with a sentinel code when its own spawn fails, and
the record surfaces "failed to start" rather than a fake shell exit).

Tests: add a `CommandProcess.test.ts` case covering the Electron-shaped `execPath` +
`ELECTRON_RUN_AS_NODE` passthrough (currently only `/usr/bin/node` is exercised).

## Work item 3 — Shell parity with a real terminal

**Files:** `apps/server/src/terminal/CommandProcess.ts`

- Spawn the user shell as login + interactive (`-l -i` for zsh/bash) so
  `/etc/zprofile`/`~/.zprofile`/`~/.zlogin` run as they do in Terminal.app. This is the
  difference that most often breaks `nvm`, version managers, and PATH setup.
- Stop discarding the resolved shell candidate's `args` at `CommandProcess.ts:152-156`
  (parity with `Manager.ts:1597`).

## Work item 4 — Multi-line commands in the bang header

**Files:** `apps/web/src/components/chat/TerminalCommandRow.tsx`,
`apps/mobile/src/features/threads/ThreadFeed.tsx`

Web: replace the single truncating span with per-line rendering. Split
`record.command` on newlines (drop blank lines), render each on its own truncating row so
`nvm use` and `prep` read as two commands. Keep the header a single flex row for the
chevron/icon/status; stack the command lines in a `min-w-0 flex-1` column. Collapsed state
keeps the status label on the first line. If very long scripts are a concern, cap at ~4
lines with a `+N more` suffix (full text is in the copyable block anyway).

Mobile: same split in the `$ {record.command}` header — one `Text` per line, each prefixed
`$ `.

## Work item 5 — Copy button on the bang result

**Files:** `apps/web/src/components/chat/TerminalCommandRow.tsx` (+ shared helper),
`apps/mobile/src/features/threads/ThreadFeed.tsx` (parity decision)

Web:

- Add `MessageCopyButton` to the row's footer (the `exit 0 · 25.1s` strip), matching the
  ghost variant used for user messages.
- Copied payload: each command line prefixed `$ `, blank line, then the output as plain
  text, then the status line — the "full terminal block" the user asked for:

  ```
  $ nvm use
  $ prep

  <output>

  exit 1 · 25.1s
  ```

- Output must be plain text: port mobile's `terminalCommandPlainText` ANSI-strip helper to
  a shared spot in `packages/client-runtime` (both surfaces then import it; mobile drops
  its local copy).
- Full output, not the excerpt: `MessageCopyButton` takes a static `text` prop, so either
  give the row an async path (small local wrapper that fetches-then-copies, reusing the
  `loadFullOutput` paging loop when `record.truncated`), or extend `MessageCopyButton` to
  accept `text: string | (() => Promise<string>)`. Prefer the latter only if it stays
  trivial; otherwise a local button in `TerminalCommandRow` using `useCopyToClipboard`
  directly is fine. Note Safari requires clipboard writes synchronous-ish with the user
  gesture — if the async fetch breaks copy there, fall back to copying the excerpt when
  truncated and note it, or pre-fetch on hover.
- Show the button only when the command is finished (not queued/running), alongside the
  status label; keep the "View retained output" affordance as-is.

Mobile: output text is already `selectable`; add a copy affordance in the footer using the
same shared payload builder (expo-clipboard) for parity, or explicitly decide "not
supported here" in the PR. Recommendation: add it — it's a few lines once the payload
builder is shared.

## Explicitly out of scope

- The eslint `indexedResults` crash itself: upstream eslint robustness gap
  (no exit guard / payload validation in `runWorkers`). Nothing T3-fixable; if it recurs
  for the user after the env fix, the user-side mitigation is a bounded `--concurrency`
  value under load. Items 1–3 remove every T3-created difference between a bang and a
  fresh terminal, which is the honest fix boundary.

## Surfaces checklist (per AGENTS.md)

- **Clients:** web (header + copy), mobile (header + copy parity), desktop (inherits web UI;
  item 2 is desktop-specific server fix). Shared payload/ANSI helper in `client-runtime`.
- **Contracts:** no schema change — `command` already stores newlines; all fixes are
  server-spawn or display side.
- **Providers:** not provider-shaped; no adapter work.
- **Reverse states:** copy is stateless; header collapse behavior unchanged.
- **Connection modes:** clipboard is client-local; full-output fetch already goes over the
  existing `execReadOutput` RPC, so remote/tunnel work unchanged.
- **Docs:** if bang shell behavior is user-documented, note in `docs/user/` that bang runs
  a login+interactive shell with a cleaned environment.

## Verification

- `vp test run` on: `spawnEnv.test.ts`, `CommandProcess.test.ts` (targeted, not repo-wide).
- Manual: in a worktree dev server, run a bang in a foreign repo and `env | sort` — assert
  no `npm_*`/`pnpm_*`/`NODE_CHANNEL_FD`/`NODE_PATH`; assert colors appear.
- Manual: multi-line bang → header shows two lines; copy → paste matches the block format,
  including full output for a truncated result.
- Packaged desktop smoke test for item 2 (bang starts at all).

## Suggested sequencing

1. Item 1 (env blocklist) — smallest, highest value, isolated tests.
2. Items 2–3 together (CommandProcess spawn path).
3. Item 4 (header) — display-only.
4. Item 5 (copy) — builds on the shared plain-text helper.

Each is one concern; per repo rules they should land as separate PRs if PRs are requested.
