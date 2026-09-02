import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { layer, make, TerminalCommandProcess } from "./CommandProcess.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 2_147_483_647;
  readonly writes: string[] = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal: null });
    }
  }
}

class FakePtyAdapter {
  readonly process = new FakePtyProcess();
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];

  readonly service = PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.sync(() => {
        this.spawnInputs.push(input);
        return this.process;
      }),
  });
}

function fakeCommandLayer(adapter: FakePtyAdapter, env: NodeJS.ProcessEnv = {}) {
  return Layer.effect(
    TerminalCommandProcess,
    make({ env, platform: "darwin", execPath: "/usr/bin/node" }),
  ).pipe(Layer.provide(Layer.succeed(PtyAdapter.PtyAdapter, adapter.service)));
}

function fakeCommandLayerWithOptions(
  adapter: FakePtyAdapter,
  options: { readonly env: NodeJS.ProcessEnv; readonly execPath: string },
) {
  return Layer.effect(TerminalCommandProcess, make({ ...options, platform: "darwin" })).pipe(
    Layer.provide(Layer.succeed(PtyAdapter.PtyAdapter, adapter.service)),
  );
}

function startInput(onOutput: (chunk: string) => void = () => {}) {
  return {
    threadId: ThreadId.make("thread-1"),
    executionId: "exec-1",
    command: "printf hello",
    cwd: "/workspace",
    onOutput,
  };
}

it.effect("spawns the supervisor in a fixed 80 by 30 PTY with a scrubbed environment", () => {
  const adapter = new FakePtyAdapter();
  return Effect.gen(function* () {
    const processDriver = yield* TerminalCommandProcess;
    yield* processDriver.start(startInput());

    expect(adapter.spawnInputs).toHaveLength(1);
    expect(adapter.spawnInputs[0]).toEqual(
      expect.objectContaining({
        shell: "/usr/bin/node",
        cwd: "/workspace",
        cols: 80,
        rows: 30,
        env: expect.objectContaining({
          COLORTERM: "truecolor",
          T3CODE_BANG_COMMAND: "printf hello",
          T3CODE_BANG_SHELL: "/bin/zsh",
          T3CODE_BANG_SHELL_ARGS: "-o\u001fnopromptsp",
        }),
      }),
    );
    expect(adapter.spawnInputs[0]?.env.T3CODE_PRIVATE).toBeUndefined();
    expect(adapter.spawnInputs[0]?.env.VITE_PRIVATE).toBeUndefined();
    expect(adapter.spawnInputs[0]?.env.NO_COLOR).toBeUndefined();
  }).pipe(
    Effect.provide(
      fakeCommandLayer(adapter, {
        SHELL: "/bin/zsh",
        T3CODE_PRIVATE: "remove",
        VITE_PRIVATE: "remove",
        NO_COLOR: "1",
      }),
    ),
  );
});

it.effect("forwards PTY output and propagates the supervisor exit code", () => {
  const adapter = new FakePtyAdapter();
  return Effect.gen(function* () {
    const processDriver = yield* TerminalCommandProcess;
    let output = "";
    const handle = yield* processDriver.start(
      startInput((chunk) => {
        output += chunk;
      }),
    );

    adapter.process.emitData("\u001b[31mred\u001b[0m\r\n");
    adapter.process.emitExit(7);

    expect(yield* handle.completed).toEqual({ exitCode: 7, failedToStart: false });
    expect(output).toBe("\u001b[31mred\u001b[0m\r\n");
  }).pipe(Effect.provide(fakeCommandLayer(adapter)));
});

it.effect("runs an Electron supervisor as Node without leaking the flag to the shell", () => {
  const adapter = new FakePtyAdapter();
  return Effect.gen(function* () {
    const processDriver = yield* TerminalCommandProcess;
    yield* processDriver.start(startInput());

    expect(adapter.spawnInputs[0]).toEqual(
      expect.objectContaining({
        shell: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    );
    expect(adapter.spawnInputs[0]?.args?.join("\n")).toContain(
      "delete process.env.ELECTRON_RUN_AS_NODE",
    );
  }).pipe(
    Effect.provide(
      fakeCommandLayerWithOptions(adapter, {
        env: { SHELL: "/bin/zsh", ELECTRON_RUN_AS_NODE: "1" },
        execPath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      }),
    ),
  );
});

it.effect("distinguishes a supervisor spawn failure from a shell exit", () => {
  const adapter = new FakePtyAdapter();
  return Effect.gen(function* () {
    const processDriver = yield* TerminalCommandProcess;
    const handle = yield* processDriver.start(startInput());

    adapter.process.emitExit(254);

    expect(yield* handle.completed).toEqual({ exitCode: null, failedToStart: true });
  }).pipe(Effect.provide(fakeCommandLayer(adapter)));
});

it.effect("writes ETX on interrupt and escalates after three seconds", () => {
  const adapter = new FakePtyAdapter();
  return Effect.gen(function* () {
    const processDriver = yield* TerminalCommandProcess;
    const handle = yield* processDriver.start(startInput());

    yield* handle.interrupt;
    expect(adapter.process.writes).toEqual(["\x03"]);
    expect(adapter.process.killSignals).toEqual([]);

    yield* TestClock.adjust("3 seconds");
    yield* Effect.yieldNow;
    expect(adapter.process.killSignals).toEqual(["SIGKILL"]);
  }).pipe(Effect.provide(fakeCommandLayer(adapter)));
});

const realPtyLayer = NodePtyAdapter.layer.pipe(Layer.provide(NodeServices.layer));

const realCommandLayer = layer.pipe(Layer.provide(realPtyLayer));
const realTestLayer = Layer.mergeAll(realCommandLayer, realPtyLayer, NodeServices.layer);

it.layer(realTestLayer)("TerminalCommandProcess with node-pty", (it) => {
  it.effect("preserves CRLF output from the PTY", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const processDriver = yield* TerminalCommandProcess;
      let output = "";
      const handle = yield* processDriver.start({
        ...startInput((chunk) => {
          output += chunk;
        }),
        cwd: process.cwd(),
        command: "printf 'first\\nsecond\\n'",
      });

      expect((yield* handle.completed).exitCode).toBe(0);
      expect(output).toContain("first\r\nsecond\r\n");
    }),
  );

  it.effect("loads zsh login and interactive startup files", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      if (!(yield* fileSystem.exists("/bin/zsh"))) return;
      const path = yield* Path.Path;
      const zdotdir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bang-zdotdir-" });
      yield* fileSystem.writeFileString(
        path.join(zdotdir, ".zprofile"),
        "export T3_BANG_ZPROFILE_LOADED=yes\n",
      );
      yield* fileSystem.writeFileString(
        path.join(zdotdir, ".zshrc"),
        [
          "function t3_bang_rc_function() { printf '%s loaded-from-zshrc\\n' \"$T3_BANG_ZPROFILE_LOADED\" }",
          "alias t3_bang_rc_alias=\"printf 'alias-loaded\\\\n'\"",
          "",
        ].join("\n"),
      );
      const adapter = yield* PtyAdapter.PtyAdapter;
      const processDriver = yield* make({
        env: { ...process.env, SHELL: "/bin/zsh", ZDOTDIR: zdotdir },
      }).pipe(Effect.provideService(PtyAdapter.PtyAdapter, adapter));
      let output = "";
      const handle = yield* processDriver.start({
        ...startInput((chunk) => {
          output += chunk;
        }),
        cwd: process.cwd(),
        command: "t3_bang_rc_function; t3_bang_rc_alias",
      });

      expect((yield* handle.completed).exitCode).toBe(0);
      expect(output).toContain("yes loaded-from-zshrc\r\n");
      expect(output).toContain("alias-loaded\r\n");
    }),
  );
});
