import * as NodeCrypto from "node:crypto";
import type { ComputerUseSession, ComputerUseTarget } from "@t3tools/contracts";

export interface ComputerUseObservation {
  bindingId: string;
  threadId: string;
  providerInstanceId: string;
  nativeThreadId?: string;
  turnId?: string;
  operationId: string;
  phase: "intent" | "completed" | "failed";
  target?: ComputerUseTarget;
  message?: string;
}
/** Provider observations own target authorization; viewer lifetime never changes it. */
export class ComputerUsePreviewRegistry {
  private records = new Map<
    string,
    {
      bindingId: string;
      session: ComputerUseSession;
      operationId: string;
      pendingTarget?: ComputerUseTarget;
      retiredTurns: Set<string>;
    }
  >();
  private retiredByNativeThread = new Map<string, Set<string>>();
  private endedBindings = new Set<string>();
  private listeners = new Set<() => void>();
  snapshot(threadId?: string): ComputerUseSession[] {
    return [...this.records.values()]
      .map((record) => record.session)
      .filter((session) => !threadId || session.threadId === threadId);
  }
  get(sessionId: string) {
    return this.records.get(sessionId)?.session;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    const ended = [...this.records.values()].filter((record) => record.session.state === "ended");
    for (const record of ended.slice(0, Math.max(0, ended.length - 64)))
      this.records.delete(record.session.sessionId);
    for (const listener of this.listeners) listener();
  }
  observe(event: ComputerUseObservation) {
    if (this.endedBindings.has(event.bindingId)) return;
    let record = [...this.records.values()].findLast(
      (item) =>
        item.bindingId === event.bindingId && item.session.nativeThreadId === event.nativeThreadId,
    );
    if (
      record &&
      (record.session.providerInstanceId !== event.providerInstanceId ||
        (event.turnId && record.retiredTurns.has(event.turnId)))
    )
      return;
    if (record && record.session.turnId === event.turnId && record.session.state === "ended")
      return;
    const nativeKey = JSON.stringify([event.bindingId, event.nativeThreadId]);
    const retiredTurns = this.retiredByNativeThread.get(nativeKey) ?? new Set<string>();
    if (event.turnId && retiredTurns.has(event.turnId)) return;
    this.retiredByNativeThread.set(nativeKey, retiredTurns);
    if (record && record.session.turnId !== event.turnId) {
      if (event.phase !== "intent") return;
      if (record.session.turnId) retiredTurns.add(record.session.turnId);
      const { target: _target, ...session } = record.session;
      record.session = {
        ...session,
        state: "ended",
        sourceGeneration: session.sourceGeneration + 1,
      };
      record = undefined;
    }
    if (!record) {
      if (event.phase !== "intent") return;
      record = {
        bindingId: event.bindingId,
        operationId: event.operationId,
        retiredTurns,
        session: {
          sessionId: NodeCrypto.randomUUID(),
          threadId: event.threadId,
          providerInstanceId: event.providerInstanceId,
          ...(event.nativeThreadId ? { nativeThreadId: event.nativeThreadId } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
          sourceGeneration: 0,
          state: "target-pending",
        },
      };
      this.records.set(record.session.sessionId, record);
    }
    if (
      record.session.providerInstanceId !== event.providerInstanceId ||
      (event.turnId && record.retiredTurns.has(event.turnId))
    )
      return;
    if (event.phase !== "intent" && record.operationId !== event.operationId) return;
    if (record.session.turnId !== event.turnId && record.session.turnId)
      record.retiredTurns.add(record.session.turnId);
    const previous = record.session;
    record.operationId = event.operationId;
    const { target: _target, message: _message, ...base } = previous;
    if (event.phase === "intent") {
      const pendingTarget = event.target ?? previous.target;
      if (pendingTarget) record.pendingTarget = pendingTarget;
      else delete record.pendingTarget;
    }
    const sameTarget = (
      left: ComputerUseTarget | undefined,
      right: ComputerUseTarget | undefined,
    ) =>
      left?.kind === right?.kind &&
      (left?.kind !== "app" || (right?.kind === "app" && left.appId === right.appId));
    const target =
      event.phase === "completed"
        ? (event.target ?? record.pendingTarget)
        : event.phase === "intent" && sameTarget(previous.target, record.pendingTarget)
          ? previous.target
          : undefined;
    record.session = {
      ...base,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      sourceGeneration: previous.sourceGeneration + (!sameTarget(previous.target, target) ? 1 : 0),
      state:
        event.phase === "failed"
          ? "unavailable"
          : target
            ? "ready"
            : event.phase === "intent"
              ? "waiting-approval"
              : "target-pending",
      ...(target ? { target } : {}),
      ...(event.message ? { message: event.message } : {}),
    };
    this.emit();
  }
  endTurn(bindingId: string, nativeThreadId: string | undefined, turnId: string) {
    const nativeKey = JSON.stringify([bindingId, nativeThreadId]);
    const retired = this.retiredByNativeThread.get(nativeKey) ?? new Set<string>();
    retired.add(turnId);
    this.retiredByNativeThread.set(nativeKey, retired);
    for (const record of this.records.values())
      if (
        record.bindingId === bindingId &&
        record.session.nativeThreadId === nativeThreadId &&
        record.session.turnId === turnId
      ) {
        record.retiredTurns.add(turnId);
        const { target: _target, ...session } = record.session;
        record.session = {
          ...session,
          sourceGeneration: session.sourceGeneration + 1,
          state: "ended",
        };
      }
    this.emit();
  }
  endBinding(bindingId: string) {
    this.endedBindings.add(bindingId);
    for (const record of this.records.values())
      if (record.bindingId === bindingId) {
        const { target: _target, ...session } = record.session;
        record.session = {
          ...session,
          sourceGeneration: session.sourceGeneration + 1,
          state: "ended",
        };
      }
    this.emit();
  }
}
export const computerUsePreviewRegistry = new ComputerUsePreviewRegistry();
