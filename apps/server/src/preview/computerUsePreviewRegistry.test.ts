import { describe, expect, it } from "@effect/vitest";
import {
  ComputerUsePreviewRegistry,
  type ComputerUseObservation,
} from "./computerUsePreviewRegistry.ts";
const intent: ComputerUseObservation = {
  bindingId: "binding",
  threadId: "thread",
  nativeThreadId: "native",
  providerInstanceId: "codex",
  turnId: "turn",
  operationId: "op",
  phase: "intent",
  target: { kind: "app", appId: "com.apple.TextEdit" },
};
describe("computer-use session authorization", () => {
  it("authorizes targets only after completion, preserves identity and stops on failure", () => {
    const registry = new ComputerUsePreviewRegistry();
    registry.observe(intent);
    const waiting = registry.snapshot()[0]!;
    expect(waiting.state).toBe("waiting-approval");
    expect(waiting.target).toBeUndefined();
    const { target: _target, ...withoutTarget } = intent;
    registry.observe({ ...withoutTarget, phase: "completed" });
    const ready = registry.snapshot()[0]!;
    expect(ready.target).toEqual(intent.target);
    expect(ready.sessionId).toBe(waiting.sessionId);
    registry.observe({
      ...intent,
      operationId: "op2",
      phase: "intent",
      target: { kind: "app", appId: "other" },
    });
    expect(registry.snapshot()[0]!.target).toBeUndefined();
    registry.observe({ ...intent, phase: "completed" });
    expect(registry.snapshot()[0]!.target).toBeUndefined();
    registry.observe({ ...intent, operationId: "op2", phase: "failed" });
    expect(registry.snapshot()[0]!.state).toBe("unavailable");
  });
  it("ignores late turns and ended bindings while allowing a new turn", () => {
    const registry = new ComputerUsePreviewRegistry();
    registry.observe(intent);
    registry.endTurn("binding", "native", "turn");
    registry.observe({ ...intent, phase: "completed" });
    expect(registry.snapshot()[0]!.state).toBe("ended");
    registry.observe({ ...intent, turnId: "next", operationId: "next" });
    registry.observe({ ...intent, turnId: "next", operationId: "next", phase: "completed" });
    expect(registry.snapshot()[1]!.state).toBe("ready");
    expect(registry.snapshot()[1]!.sessionId).not.toBe(registry.snapshot()[0]!.sessionId);
    registry.observe(intent);
    expect(registry.snapshot()).toHaveLength(2);
    expect(registry.snapshot()[1]!.turnId).toBe("next");
    registry.endBinding("binding");
    registry.observe({ ...intent, turnId: "third" });
    expect(registry.snapshot()[0]!.state).toBe("ended");
  });
  it("keeps capture uninterrupted for repeated operations on the authorized app", () => {
    const registry = new ComputerUsePreviewRegistry();
    registry.observe(intent);
    registry.observe({ ...intent, phase: "completed" });
    const ready = registry.snapshot()[0]!;
    registry.observe({
      ...intent,
      operationId: "click",
      target: { kind: "app", appId: "com.apple.TextEdit", appName: "TextEdit" },
    });
    expect(registry.snapshot()[0]).toEqual(ready);
    registry.observe({ ...intent, operationId: "click", phase: "completed" });
    expect(registry.snapshot()[0]!.sourceGeneration).toBe(ready.sourceGeneration);
    const { target: _target, ...withoutTarget } = intent;
    registry.observe({ ...withoutTarget, operationId: "screenshot" });
    expect(registry.snapshot()[0]!.state).toBe("ready");
    expect(registry.snapshot()[0]!.sourceGeneration).toBe(ready.sourceGeneration);
  });
  it("bounds ended metadata while preserving active sessions and late-turn rejection", () => {
    const registry = new ComputerUsePreviewRegistry();
    for (let index = 0; index < 100; index++) {
      registry.observe({ ...intent, turnId: `turn-${index}` });
      registry.endTurn("binding", "native", `turn-${index}`);
    }
    expect(registry.snapshot()).toHaveLength(64);
    registry.observe({ ...intent, turnId: "turn-0" });
    expect(registry.snapshot()).toHaveLength(64);
    registry.observe({ ...intent, turnId: "new" });
    expect(registry.snapshot().filter((session) => session.state !== "ended")).toHaveLength(1);
  });
  it("keeps independent native threads isolated and snapshots atomic", () => {
    const registry = new ComputerUsePreviewRegistry();
    const updates: number[] = [];
    const off = registry.subscribe(() => updates.push(registry.snapshot().length));
    registry.observe(intent);
    registry.observe({ ...intent, nativeThreadId: "child" });
    off();
    registry.endBinding("binding");
    expect(updates).toEqual([1, 2]);
    expect(new Set(registry.snapshot().map((s) => s.sessionId)).size).toBe(2);
  });
});
