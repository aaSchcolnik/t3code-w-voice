import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  buildAntigravityArgs,
  isAntigravityPermissionDenial,
  makeAntigravityAdapter,
} from "./AntigravityAdapter.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it("keeps every flag before the final -p prompt pair", () => {
  assert.deepEqual(
    buildAntigravityArgs({
      prompt: "Inspect this",
      model: "gemini-3.7-flash-high",
      dangerouslySkipPermissions: true,
    }),
    [
      "--model",
      "gemini-3.7-flash-high",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "5m",
      "--dangerously-skip-permissions",
      "-p",
      "Inspect this",
    ],
  );
});

it("recognizes headless permission denials reported on stderr", () => {
  assert.equal(
    isAntigravityPermissionDenial(
      "PERMISSION_DENIED: run_command requires approval; add a permissions.allow rule",
    ),
    true,
  );
  assert.equal(
    isAntigravityPermissionDenial(
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
    ),
    true,
  );
  assert.equal(isAntigravityPermissionDenial("Using cached credentials"), false);
});

it.layer(NodeServices.layer)("Antigravity adapter", (it) => {
  it.effect("streams a successful one-shot run and records the exact argv", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-adapter-" });
      const binaryPath = path.join(tempDir, "agy");
      const argvPath = path.join(tempDir, "argv.txt");
      yield* fileSystem.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$@" > ${encodeJson(argvPath)}`,
          `printf '%s\\n' '${encodeJson({ event: "init", init: {} })}'`,
          `printf '%s\\n' '${encodeJson({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } } } })}'`,
          `printf '%s\\n' '${encodeJson({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "pwd" }, output: "/workspace" } } })}'`,
          `printf '%s\\n' '${encodeJson({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Hello from agy" } })}'`,
          `printf '%s\\n' '${encodeJson({ event: "result", result: { conversation_id: "agy-test", status: "SUCCESS", response: "Hello from agy", duration_seconds: 1.25, usage: { input_tokens: 10, output_tokens: 3, thinking_tokens: 2, cache_read_tokens: 4, total_tokens: 13 } } })}'`,
          "",
        ].join("\n"),
      );
      yield* fileSystem.chmod(binaryPath, 0o755);
      const instanceId = ProviderInstanceId.make("antigravity-test");
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true, binaryPath }), {
        instanceId,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(10),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("agy-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        providerInstanceId: instanceId,
        cwd: tempDir,
        runtimeMode: "auto-accept-edits",
        modelSelection: { instanceId, model: "gemini-3.7-flash-high" },
      });
      yield* adapter.sendTurn({ threadId, input: "Inspect this" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "turn.started",
          "item.started",
          "item.started",
          "item.completed",
          "content.delta",
          "item.completed",
          "thread.token-usage.updated",
          "turn.completed",
        ],
      );
      const completed = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(completed?.payload.detail, "Hello from agy");
      const command = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.equal(command?.payload.title, "run_command");
      const argv = (yield* fileSystem.readFileString(argvPath)).trim().split("\n");
      assert.deepEqual(argv.slice(-2), ["-p", "Inspect this"]);
      assert.equal(argv.includes("--dangerously-skip-permissions"), false);
    }).pipe(Effect.scoped),
  );

  it.effect("classifies an empty successful process as a failed turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-empty-" });
      const binaryPath = path.join(tempDir, "agy");
      yield* fileSystem.writeFileString(binaryPath, "#!/bin/sh\nexit 0\n");
      yield* fileSystem.chmod(binaryPath, 0o755);
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true, binaryPath }));
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(7),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("agy-empty-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        cwd: tempDir,
        runtimeMode: "auto-accept-edits",
      });
      yield* adapter.sendTurn({ threadId, input: "Inspect this" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const failure = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(failure?.payload.state, "failed");
      assert.match(failure?.payload.errorMessage ?? "", /authentication, permissions, and quota/);
    }).pipe(Effect.scoped),
  );

  it.effect("includes stderr when the process exits non-zero", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-error-" });
      const binaryPath = path.join(tempDir, "agy");
      yield* fileSystem.writeFileString(
        binaryPath,
        "#!/bin/sh\necho 'authentication required' >&2\nexit 7\n",
      );
      yield* fileSystem.chmod(binaryPath, 0o755);
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true, binaryPath }));
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(7),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("agy-error-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        cwd: tempDir,
        runtimeMode: "auto-accept-edits",
      });
      yield* adapter.sendTurn({ threadId, input: "Inspect this" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const failure = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(failure?.payload.state, "failed");
      assert.match(failure?.payload.errorMessage ?? "", /authentication required/);
    }).pipe(Effect.scoped),
  );

  it.effect("classifies agy soft-denials that exit zero with an empty success result", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-denied-" });
      const binaryPath = path.join(tempDir, "agy");
      yield* fileSystem.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          `printf '%s\\n' '${encodeJson({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } } } })}'`,
          `printf '%s\\n' '${encodeJson({ event: "step_update", step_update: { step_index: 1, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "pwd" }, error: { type: "TOOL_ERROR", message: "user denied permission" } } } })}'`,
          `printf '%s\\n' '${encodeJson({ event: "result", result: { status: "SUCCESS", response: "" } })}'`,
          `printf '%s\\n' 'jetski: no output produced; a tool required permission that headless mode cannot prompt for, so it was auto-denied.' >&2`,
          "exit 0",
          "",
        ].join("\n"),
      );
      yield* fileSystem.chmod(binaryPath, 0o755);
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true, binaryPath }));
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(9),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const threadId = ThreadId.make("agy-denied-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        cwd: tempDir,
        runtimeMode: "auto-accept-edits",
      });
      yield* adapter.sendTurn({ threadId, input: "Run pwd" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const failedTool = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      const failedTurn = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(failedTool?.payload.status, "failed");
      assert.equal(failedTurn?.payload.state, "failed");
      assert.match(failedTurn?.payload.errorMessage ?? "", /auto-denied/);
    }).pipe(Effect.scoped),
  );

  it.effect("kills a stalled process when the hard timeout expires", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-timeout-" });
      const binaryPath = path.join(tempDir, "agy");
      yield* fileSystem.writeFileString(binaryPath, "#!/bin/sh\nwhile :; do sleep 1; done\n");
      yield* fileSystem.chmod(binaryPath, 0o755);
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true, binaryPath }), {
        hardTimeoutMs: 50,
      });
      const threadId = ThreadId.make("agy-timeout-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        cwd: tempDir,
        runtimeMode: "auto-accept-edits",
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const startedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "Wait forever" })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(startedFiber);
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(sendFiber);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const failure = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(failure?.payload.state, "failed");
      assert.match(failure?.payload.errorMessage ?? "", /hard timeout/);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts the active process and completes the turn as cancelled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-cancel-" });
      const binaryPath = path.join(tempDir, "agy");
      yield* fileSystem.writeFileString(binaryPath, "#!/bin/sh\nwhile :; do sleep 1; done\n");
      yield* fileSystem.chmod(binaryPath, 0o755);
      const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true, binaryPath }));
      const threadId = ThreadId.make("agy-cancel-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        cwd: tempDir,
        runtimeMode: "auto-accept-edits",
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const startedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "Wait forever" })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(startedFiber);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(sendFiber);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completion = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(completion?.payload.state, "cancelled");
      assert.equal(completion?.payload.stopReason, "cancelled");
    }).pipe(Effect.scoped),
  );
});
