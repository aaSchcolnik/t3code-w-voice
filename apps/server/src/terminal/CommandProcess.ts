import { TerminalExecFailure, type ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PtyAdapter from "./PtyAdapter.ts";
import {
  createTerminalSpawnEnv,
  defaultShellResolver,
  resolveShellCandidates,
} from "./spawnEnv.ts";

const COMMAND_COLS = 80;
const COMMAND_ROWS = 30;
const INTERRUPT_GRACE = Duration.millis(3_000);
const SUPERVISOR_SPAWN_FAILURE_EXIT_CODE = 254;

// This process stays alive if the server exits abruptly and kills the command
// process group before it exits itself. The command travels through the
// environment so neither its source nor argv needs string interpolation.
const COMMAND_SUPERVISOR_SOURCE = String.raw`
const childProcess = require("node:child_process");
const path = require("node:path");
const parentPid = Number(process.env.T3CODE_BANG_PARENT_PID);
const command = process.env.T3CODE_BANG_COMMAND || "";
const shell = process.env.T3CODE_BANG_SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
const shellArgs = (process.env.T3CODE_BANG_SHELL_ARGS || "").split("\u001f").filter(Boolean);
delete process.env.T3CODE_BANG_PARENT_PID;
delete process.env.T3CODE_BANG_COMMAND;
delete process.env.T3CODE_BANG_SHELL;
delete process.env.T3CODE_BANG_SHELL_ARGS;
delete process.env.ELECTRON_RUN_AS_NODE;
const shellName = path.basename(shell).toLowerCase();
const args = process.platform === "win32"
  ? [...shellArgs, "/d", "/s", "/c", command]
  : shellName === "zsh"
    ? [...shellArgs, "-l", "-i", "-c", "unsetopt monitor 2>/dev/null; eval \"$T3CODE_SUPERVISED_COMMAND\""]
    : shellName === "bash"
      ? [...shellArgs, "-l", "-i", "-c", "set +m 2>/dev/null; eval \"$T3CODE_SUPERVISED_COMMAND\""]
      : [...shellArgs, "-i", "-c", "set +m 2>/dev/null; eval \"$T3CODE_SUPERVISED_COMMAND\""];
const env = { ...process.env, T3CODE_SUPERVISED_COMMAND: command };
process.on("SIGINT", () => {});
const child = childProcess.spawn(shell, args, {
  cwd: process.cwd(),
  env,
  detached: false,
  stdio: "inherit",
  windowsHide: true,
});
let settled = false;
const monitor = setInterval(() => {
  let parentAlive = process.ppid === parentPid;
  if (parentAlive) {
    try { process.kill(parentPid, 0); } catch { parentAlive = false; }
  }
  if (parentAlive || settled) return;
  settled = true;
  clearInterval(monitor);
  if (process.platform === "win32") {
    childProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    process.exit(143);
  }
  try { process.kill(-process.pid, "SIGTERM"); } catch { process.exit(143); }
}, 1000);
child.once("error", (error) => {
  settled = true;
  clearInterval(monitor);
  process.stderr.write("Failed to start terminal command: " + error.message + "\n");
  process.exit(${SUPERVISOR_SPAWN_FAILURE_EXIT_CODE});
});
child.once("close", (code) => {
  settled = true;
  clearInterval(monitor);
  process.exit(code == null ? 1 : code);
});
`;

export interface TerminalCommandProcessResult {
  readonly exitCode: number | null;
  readonly failedToStart: boolean;
}

export interface TerminalCommandProcessHandle {
  readonly pid: number;
  readonly completed: Effect.Effect<TerminalCommandProcessResult>;
  /** Writes Ctrl-C, then kills the process tree after the configured grace. */
  readonly interrupt: Effect.Effect<void>;
  readonly kill: Effect.Effect<void>;
}

export interface TerminalCommandProcessStartInput {
  readonly threadId: ThreadId;
  readonly executionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly onOutput: (chunk: string) => void;
}

export interface TerminalCommandProcessShape {
  readonly start: (
    input: TerminalCommandProcessStartInput,
  ) => Effect.Effect<TerminalCommandProcessHandle, TerminalExecFailure>;
}

export class TerminalCommandProcess extends Context.Service<
  TerminalCommandProcess,
  TerminalCommandProcessShape
>()("t3/terminal/CommandProcess/TerminalCommandProcess") {}

function killProcessTree(processHandle: PtyAdapter.PtyProcess, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    try {
      // node-pty delegates this to its ConPTY agent, which closes the full job.
      processHandle.kill();
    } catch {
      // The process may exit between the caller's check and this signal.
    }
    return;
  } else {
    try {
      process.kill(-processHandle.pid, "SIGKILL");
      return;
    } catch {
      // Fall back if the PTY implementation did not use its pid as the group id.
    }
  }

  try {
    processHandle.kill("SIGKILL");
  } catch {
    // The process may exit between the caller's check and this signal.
  }
}

interface TerminalCommandProcessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
}

export const make = Effect.fn("TerminalCommandProcess.make")(function* (
  options: TerminalCommandProcessOptions = {},
) {
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const hostPlatform = yield* HostProcessPlatform;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const start: TerminalCommandProcessShape["start"] = Effect.fn("TerminalCommandProcess.start")(
    function* (input) {
      const platform = options.platform ?? hostPlatform;
      const sourceEnv = options.env ?? process.env;
      const baseEnv = createTerminalSpawnEnv(sourceEnv, { COLORTERM: "truecolor" });
      delete baseEnv.NO_COLOR;
      const shellCandidate =
        platform === "win32"
          ? { shell: baseEnv.ComSpec ?? "cmd.exe", args: [] }
          : (resolveShellCandidates(
              () => defaultShellResolver(platform, baseEnv),
              platform,
              baseEnv,
            )[0] ?? { shell: "/bin/sh", args: [] });
      const supervisorEnv = {
        ...baseEnv,
        ...(sourceEnv.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : null),
        T3CODE_BANG_PARENT_PID: String(process.pid),
        T3CODE_BANG_COMMAND: input.command,
        T3CODE_BANG_SHELL: shellCandidate.shell,
        T3CODE_BANG_SHELL_ARGS: (shellCandidate.args ?? []).join("\u001f"),
      };
      const processHandle = yield* ptyAdapter
        .spawn({
          shell: options.execPath ?? process.execPath,
          args: ["-e", COMMAND_SUPERVISOR_SOURCE],
          cwd: input.cwd,
          cols: COMMAND_COLS,
          rows: COMMAND_ROWS,
          env: supervisorEnv,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalExecFailure({
                threadId: input.threadId,
                executionId: input.executionId,
                operation: "start",
                detail: `Failed to start terminal command: ${cause.message}`,
              }),
          ),
        );

      const exit = yield* Deferred.make<TerminalCommandProcessResult>();
      let didExit = false;
      const removeDataListener = processHandle.onData(input.onOutput);
      let removeExitListener = () => {};
      removeExitListener = processHandle.onExit((event) => {
        didExit = true;
        removeDataListener();
        removeExitListener();
        const failedToStart = event.exitCode === SUPERVISOR_SPAWN_FAILURE_EXIT_CODE;
        runFork(
          Deferred.succeed(exit, {
            exitCode: failedToStart ? null : event.exitCode,
            failedToStart,
          }),
        );
      });

      const hardKill = Effect.sync(() => {
        if (!didExit) killProcessTree(processHandle, platform);
      });

      return {
        pid: processHandle.pid,
        completed: Deferred.await(exit),
        interrupt: Effect.gen(function* () {
          if (didExit) return;
          yield* Effect.sync(() => {
            try {
              processHandle.write("\x03");
            } catch {
              // The process may exit between the check and the PTY write.
            }
          });
          yield* Effect.sleep(INTERRUPT_GRACE).pipe(Effect.andThen(hardKill), Effect.forkDetach);
        }),
        kill: hardKill,
      };
    },
  );

  return TerminalCommandProcess.of({ start });
});

export const layer = Layer.effect(TerminalCommandProcess, make());
