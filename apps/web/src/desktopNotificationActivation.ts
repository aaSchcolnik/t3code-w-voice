import type { EnvironmentId, SubagentRunId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export interface PendingSubagentNotificationActivation {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: SubagentRunId;
  readonly nonce: number;
}

let pendingActivation: PendingSubagentNotificationActivation | null = null;
let nextNonce = 1;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function setPendingSubagentNotificationActivation(
  activation: Omit<PendingSubagentNotificationActivation, "nonce">,
): void {
  pendingActivation = { ...activation, nonce: nextNonce++ };
  emitChange();
}

export function consumePendingSubagentNotificationActivation(
  nonce: number,
): PendingSubagentNotificationActivation | null {
  if (pendingActivation?.nonce !== nonce) return null;
  const consumed = pendingActivation;
  pendingActivation = null;
  emitChange();
  return consumed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PendingSubagentNotificationActivation | null {
  return pendingActivation;
}

export function usePendingSubagentNotificationActivation(): PendingSubagentNotificationActivation | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function __resetDesktopNotificationActivationForTests(): void {
  pendingActivation = null;
  nextNonce = 1;
  listeners.clear();
}
