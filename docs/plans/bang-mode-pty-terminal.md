# Bang mode: PTY-backed execution, correct rendering, theme-true surface

## Problem

Three user reports against bang mode (`!command` in the composer), two confirmed at root cause, one re-diagnosed:

1. **Shell fidelity.** `CommandProcess.ts` runs the command as `$SHELL -c 'eval "$T3CODE_SUPERVISED_COMMAND" 2>&1'` over pipes. A `-c` shell is non-interactive, so zsh only reads `.zshenv` — aliases, `nvm`, and everything else in `.zshrc` is missing. Verified: `zsh -c 'type nvm'` → not found; `zsh -i -c 'type nvm'` → shell function.
2. **Staircase output.** No PTY means no `ONLCR` line-discipline translation, so the stream carries bare `\n`. Nothing on the path normalizes it — `TerminalReplaySanitizer` deliberately preserves `\n`/`\r`, and `GhosttyTerminalSurface.resetAndWrite` writes straight through. Ghostty treats LF as line-feed-only, so each line starts at the previous line's end column.
3. **Theme mismatch.** The originally blamed drawer-selector fallback in `terminalThemeFromApp` (`apps/web/src/terminal/ghostty/theme.ts:44-45`) is real code smell but not the cause: `--terminal-background`/`--terminal-foreground` are always defined on `documentElement` (`apps/web/src/index.css:1079`, `:1239`), so the drawer-derived colors are never actually consumed. What the user saw was **no ANSI color at all**: with no tty, every tool disables color, so output renders as flat foreground text — on top of the staircase. `GhosttyTheme` (`apps/web/src/terminal/ghostty/core.ts:66`) carries only fg/bg/cursor/selection; ANSI 16 rendering comes from Ghostty's built-in palette and only appears once programs emit SGR again.

One fix resolves 1, 2, and most of 3: run bang commands under a real PTY with an interactive shell, like the drawer terminal already does — while keeping the out-of-process orphan supervisor that the current design provides and the drawer does not.

## Decisions (locked)

- **Read-only stays.** No `terminalExecWrite` RPC, no writable row surface. With a PTY the child _does_ get a tty, so a prompting command now blocks instead of failing fast; the existing `timeoutMs` path (`CommandManager.ts:411`) and Cancel cover it. Update the docs wording accordingly.
- **Fixed 80×30 PTY, no contract change.** Not the drawer's 120×30: the readonly row surface derives its own `cols` from the measured mount (`surface.ts:787`), typically well under 120 in a chat block, and a 120-col child double-wraps there. 80 is the least-surprising width for `ls`, tables, and progress bars. Passing measured `cols` through `TerminalExecStartInput` is a possible follow-up, not this change (the persisted-replay-at-a-different-width problem exists at any fixed number anyway).
- **Keep the supervisor.** `COMMAND_SUPERVISOR_SOURCE` exists so a hard server exit still tears down the command tree — the drawer does not have that guarantee and bang should not lose it. The PTY hosts the supervisor; the supervisor hosts the shell.
- **Theme-driven ANSI 16 palette is out of scope.** After the PTY fix, colors render from Ghostty's default palette. Mapping the ANSI 16 to appearance-theme roles is a separate feature (new `GhosttyTheme` fields + theme roles + drawer parity) and needs a product decision first.

## Phase 1 — server: PTY-backed CommandProcess

Files: `apps/server/src/terminal/CommandProcess.ts`, `apps/server/src/terminal/Manager.ts`, new `apps/server/src/terminal/spawnEnv.ts` (or similar), `apps/server/src/server.ts`.

1. **Extract shared spawn helpers from `Manager.ts`.** `createTerminalSpawnEnv` + `stripAppImageRuntimeEnv` + `shouldExcludeTerminalEnvKey` (env scrub), and `resolveShellCandidates`/`shellCandidateFromCommand`/`normalizeShellCommand` (shell fallback chain) move to a shared module. `Manager.ts` re-imports; behavior identical, its tests keep passing.
2. **Rework `TerminalCommandProcess` to spawn through `PtyAdapter`.**
   - The PTY spawns `process.execPath -e COMMAND_SUPERVISOR_SOURCE` at 80×30 with the scrubbed env plus the existing `T3CODE_BANG_*` carriers. `server.ts` provides the same `PtyAdapter` layer (Bun/Node selection at `server.ts:154-158`) to `TerminalCommandProcess.layer`.
   - The supervisor spawns the shell with `stdio: "inherit"` so the child owns the PTY directly. The `child.stdout.pipe(...)` plumbing and the `2>&1` redirect go away — a tty is one merged stream by nature.
   - POSIX shell args become interactive: `["-i", "-c", 'unsetopt monitor 2>/dev/null; eval "$T3CODE_SUPERVISED_COMMAND"']` for zsh (`set +m` equivalent for bash). Disabling job control matters: an interactive shell with a tty puts the eval'd command in its own process group, which would escape the supervisor's `kill(-pid)` orphan cleanup. Verify tree kill with a `zsh -i` child in a test.
   - Windows keeps `cmd /d /s /c` semantics through ConPTY (node-pty) and the existing `taskkill /t /f` escalation. rc-file behavior doesn't apply there; the win is `ONLCR`-equivalent output and color.
   - The ppid watchdog is unchanged — node-pty children are direct children of the server, so `process.ppid === parentPid` still holds.
3. **Signals.** `interrupt` writes ETX (`\x03`) to the PTY — SIGINT to the foreground process group, exactly what Ctrl-C does — then escalates to a tree SIGKILL after the existing 3s grace. `kill` stays a hard tree kill. Exit code still flows supervisor → PTY `onExit`.
4. **Output path.** `onOutput` wires to the PTY's `onData`. `TerminalReplaySanitizer` already preserves `\r` and allowlists SGR (`m`), so CRLF and color survive to the client; confirm the CSI allowlist doesn't eat anything an interactive-shell startup emits (OSC title sequences are stripped — correct).
5. **Wiring.** `TerminalCommandLayerLive` (`server.ts:366`) gains the `PtyAdapter` provision. `CommandManager.ts` is untouched apart from whatever the `TerminalCommandProcessStartInput` shape needs (nothing, if cols/rows are constants inside CommandProcess).

## Phase 2 — web: theme resolution + row rendering checks

Files: `apps/web/src/terminal/ghostty/theme.ts`, `apps/web/src/components/chat/TerminalCommandRow.tsx`.

1. **Fix `terminalThemeFromApp` surface resolution.** Drop the `document.querySelector(".thread-terminal-drawer")` global fallback; resolve fallback colors from the `mountElement` itself (falling back to `document.body`). Currently latent — the `--terminal-*` variables always win — but it's the correct shape and stops a chat row from ever borrowing drawer styles if a theme drops those variables.
2. **Verify row height with wrapped output.** `countOutputRows` counts logical `\n` only. With PTY output, lines longer than the surface's measured cols wrap visually without a newline character, so the computed `contentHeightForRows` can undercount and clip. Check against real wide output (`ls -la` in a narrow block); if it clips, derive rows from the surface's post-write cursor row instead of the raw string. `trimTrailingNewlines` already handles `\r\n`.
3. **Confirm ANSI color renders** through Ghostty's default palette on the readonly surface once PTY output carries SGR. No code expected; this is the acceptance check for report 3.

## Phase 3 — tests

- `CommandProcess.test.ts`: rewrite around a fake/real `PtyAdapter`. Cover: CRLF line endings present in output, interactive shell resolves rc-file functions (guard the assertion to environments where that's controllable — a temp `ZDOTDIR` with a known alias makes it hermetic), ETX interrupt then hard-kill escalation, exit-code propagation, orphan-kill path with job control disabled.
- Shared spawn-helper module gets its own focused tests (moved, not new coverage); `Manager.test.ts` must pass unmodified.
- `outputSanitizer.test.ts`: add a case asserting SGR + CRLF pass through untouched.
- Run only the touched files with `vp test run`; targeted typecheck for `apps/server` and `apps/web`. No repo-wide checks.

## Phase 4 — docs

- `docs/user/bang-mode.md:11`: commands now run in an interactive login-like shell with a real terminal — aliases, `nvm`, and colored output work. Keep and sharpen the "not for interactive prompts" promise: input is not accepted; a command that waits for input runs until it times out or is cancelled.
- `docs/internals/glossary.md` only if the supervisor/PTY split earns a named term (likely not).

## Verification

Smallest proof: the Phase 3 tests plus one integrated pass in the web client (`test-t3-app`, with permission) running `!nvm use && node -v`, `!ll`, and a color-emitting command (`!ls -G` / `!git status`) — checking left-anchored lines, ANSI color, and theme-consistent background in both light and dark. Mobile needs no change: `sanitizeTerminalCommandPlainText` already normalizes `\r\n` for its plain-text rendering.

## Risks

- **rc-file noise.** Interactive startup can print (this user's `.zshrc` sources a missing spaceship path). With a real tty the `zle`/`tput` errors from the no-tty repro disappear, but genuine rc noise will show in the block. That's faithful terminal behavior — accept it.
- **Startup latency.** `zsh -i` pays rc-file cost (~100–300ms typical, oh-my-zsh can be worse). Acceptable for an explicit user-run command; not on any hot path.
- **Job-control escape.** The `unsetopt monitor` detail above is load-bearing for orphan cleanup; it gets a dedicated test.
- **Prompting commands now hang instead of failing fast.** Mitigated by Cancel and `timeoutMs`; called out in docs.

## Out of scope (follow-ups needing a decision)

- Theme-role-driven ANSI 16 palette for Ghostty surfaces (row _and_ drawer).
- Optional `cols` in `TerminalExecStartInput` so the client can pass measured block width.
- A writable one-shot terminal (interactive bang).
