import * as NodeEvents from "node:events";

import { assert, describe, expect, it } from "@effect/vitest";

import type {
  DesktopTranscriptionHostCommand,
  DesktopTranscriptionHostResponse,
} from "./desktopTranscriptionProtocol.ts";
import {
  type DesktopTranscriptionSessionOwner,
  DesktopTranscriptionServiceImpl,
} from "./DesktopTranscriptionService.ts";

class FakeUtilityProcess extends NodeEvents.EventEmitter {
  readonly commands: DesktopTranscriptionHostCommand[] = [];
  killed = false;

  postMessage(message: DesktopTranscriptionHostCommand): void {
    this.commands.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  respond(response: DesktopTranscriptionHostResponse): void {
    this.emit("message", response);
  }

  exit(code: number): void {
    this.emit("exit", code);
  }
}

class FakeSessionOwner extends NodeEvents.EventEmitter implements DesktopTranscriptionSessionOwner {
  readonly id: number;
  destroyed = false;

  constructor(id: number) {
    super();
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }

  crash(): void {
    this.destroyed = true;
    this.emit("render-process-gone", {}, { reason: "crashed" });
  }
}

function makeService() {
  const processes: FakeUtilityProcess[] = [];
  const timers: Array<{ cancelled: boolean; delay: number; callback: () => void }> = [];
  const service = new DesktopTranscriptionServiceImpl({
    forkUtilityProcess: () => {
      const child = new FakeUtilityProcess();
      processes.push(child);
      return child;
    },
    resolveModel: async () => ({ path: "/models/voice.gguf" }),
    idleTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    sessionInactivityTimeoutMs: 30_000,
    schedule: (delay, callback) => {
      const timer = { cancelled: false, delay, callback };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  });
  return { service, processes, timers };
}

async function acknowledgeLast(child: FakeUtilityProcess): Promise<void> {
  const command = child.commands.at(-1)!;
  child.respond({ kind: "response", id: command.id, ok: true });
  await Promise.resolve();
}

describe("DesktopTranscriptionService", () => {
  it("reserves a session before asynchronous model resolution", async () => {
    const processes: FakeUtilityProcess[] = [];
    let resolveModel: ((value: { readonly path: string }) => void) | undefined;
    const service = new DesktopTranscriptionServiceImpl({
      forkUtilityProcess: () => {
        const child = new FakeUtilityProcess();
        processes.push(child);
        return child;
      },
      resolveModel: () =>
        new Promise((resolve) => {
          resolveModel = resolve;
        }),
    });
    const owner = new FakeSessionOwner(1);

    const first = service.startSession({ sessionId: "one", sampleRate: 16_000 }, owner);
    await expect(
      service.startSession({ sessionId: "two", sampleRate: 16_000 }, owner),
    ).rejects.toThrow(/already active/u);

    resolveModel?.({ path: "/models/voice.gguf" });
    await Promise.resolve();
    await acknowledgeLast(processes[0]!);
    await first;
  });

  it("enforces one active session and relays utility updates", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(1);
    const updates: unknown[] = [];
    fixture.service.subscribe((update) => updates.push(update));

    const start = fixture.service.startSession({ sessionId: "one", sampleRate: 16_000 }, owner);
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await start;

    await expect(
      fixture.service.startSession({ sessionId: "two", sampleRate: 16_000 }, owner),
    ).rejects.toThrow(/already active/u);
    fixture.processes[0]!.respond({
      kind: "update",
      update: { sessionId: "one", kind: "partial", segmentId: 0, text: "hello" },
    });
    assert.deepEqual(updates, [{ sessionId: "one", kind: "partial", segmentId: 0, text: "hello" }]);
  });

  it("isolates a crash, ends the active session, and restarts on the next start", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(1);
    const updates: unknown[] = [];
    fixture.service.subscribe((update) => updates.push(update));

    const first = fixture.service.startSession({ sessionId: "one", sampleRate: 16_000 }, owner);
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await first;
    fixture.processes[0]!.exit(9);

    assert.deepEqual(updates, [{ sessionId: "one", kind: "ended" }]);
    const second = fixture.service.startSession({ sessionId: "two", sampleRate: 16_000 }, owner);
    await Promise.resolve();
    assert.lengthOf(fixture.processes, 2);
    await acknowledgeLast(fixture.processes[1]!);
    await second;
  });

  it("relays inference failures before ending the affected session", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(1);
    const events: unknown[] = [];
    fixture.service.subscribeErrors((event) => events.push(event));
    fixture.service.subscribe((update) => events.push(update));

    const start = fixture.service.startSession({ sessionId: "one", sampleRate: 16_000 }, owner);
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await start;
    fixture.processes[0]!.respond({
      kind: "session-error",
      sessionId: "one",
      error: "native inference failed",
    });
    fixture.processes[0]!.respond({
      kind: "update",
      update: { sessionId: "one", kind: "ended" },
    });

    assert.deepEqual(events, [
      { sessionId: "one", message: "native inference failed" },
      { sessionId: "one", kind: "ended" },
    ]);
  });

  it("terminates the utility process after a completed session becomes idle", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(1);
    const start = fixture.service.startSession({ sessionId: "one", sampleRate: 16_000 }, owner);
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await start;
    const stop = fixture.service.stopSession({ sessionId: "one" }, owner);
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await stop;

    const idleTimer = fixture.timers.at(-1)!;
    idleTimer.callback();
    assert.equal(fixture.processes[0]!.killed, true);
  });

  it("cancels a session when its renderer is destroyed and emits one terminal failure", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(7);
    const events: unknown[] = [];
    fixture.service.subscribeErrors((event) => events.push(event));
    fixture.service.subscribe((update) => events.push(update));

    const start = fixture.service.startSession(
      { sessionId: "orphaned", sampleRate: 16_000 },
      owner,
    );
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await start;

    owner.destroy();
    assert.deepEqual(fixture.processes[0]!.commands.at(-1), {
      id: 2,
      kind: "cancel-session",
      sessionId: "orphaned",
    });
    assert.deepEqual(events, [
      {
        sessionId: "orphaned",
        message: "The transcription renderer exited before the session completed.",
      },
      { sessionId: "orphaned", kind: "ended" },
    ]);

    owner.destroy();
    assert.lengthOf(fixture.processes[0]!.commands, 2);
  });

  it("cancels a session when its renderer process crashes", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(8);
    const start = fixture.service.startSession({ sessionId: "crashed", sampleRate: 16_000 }, owner);
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await start;

    owner.crash();

    assert.deepInclude(fixture.processes[0]!.commands.at(-1), {
      kind: "cancel-session",
      sessionId: "crashed",
    });
  });

  it("rejects audio from a renderer that does not own the active session", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(1);
    const other = new FakeSessionOwner(2);
    const start = fixture.service.startSession({ sessionId: "owned", sampleRate: 16_000 }, owner);
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await start;

    await expect(
      fixture.service.sendAudio(
        { sessionId: "owned", audio: new Uint8Array(Float32Array.BYTES_PER_ELEMENT) },
        other,
      ),
    ).rejects.toThrow(/another renderer/u);
    assert.lengthOf(fixture.processes[0]!.commands, 1);
  });

  it("cancels a session after renderer audio inactivity", async () => {
    const fixture = makeService();
    const owner = new FakeSessionOwner(3);
    const errors: unknown[] = [];
    fixture.service.subscribeErrors((event) => errors.push(event));
    const start = fixture.service.startSession(
      { sessionId: "inactive", sampleRate: 16_000 },
      owner,
    );
    await Promise.resolve();
    await acknowledgeLast(fixture.processes[0]!);
    await start;

    const watchdog = fixture.timers.find((timer) => timer.delay === 30_000 && !timer.cancelled)!;
    watchdog.callback();

    assert.deepInclude(fixture.processes[0]!.commands.at(-1), {
      kind: "cancel-session",
      sessionId: "inactive",
    });
    assert.deepEqual(errors, [
      {
        sessionId: "inactive",
        message: "Desktop transcription stopped because the renderer sent no audio for too long.",
      },
    ]);
  });
});
