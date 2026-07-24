import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  DesktopBridge,
  DesktopNotificationActivation,
  DesktopNotificationIntent,
  DesktopNotificationPreferences,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef } from "react";

import {
  RootNotificationTracker,
  SUBAGENT_NOTIFICATION_BATCH_WINDOW_MS,
  SubagentNotificationTracker,
  appendSubagentBatch,
  isBatchableSubagentEvent,
  projectNamesByRootThread,
  rootNotificationDetail,
  rootNotificationProvider,
  shouldSuppressDesktopNotification,
  subagentBatchKey,
  subagentNotificationDetail,
  toDesktopNotificationProvider,
  type RootNotificationCandidate,
  type SubagentNotificationCandidate,
} from "../../desktopNotifications.logic";
import { setPendingSubagentNotificationActivation } from "../../desktopNotificationActivation";
import { useClientSettings } from "../../hooks/useSettings";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironments } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSubagentRunList } from "../../state/subagents";
import { environmentThreadDetails } from "../../state/threads";

const ROOT_INTERRUPTION_SETTLE_MS = 300;
const ROOT_NOTIFICATION_DETAIL_TIMEOUT_MS = 1_200;

interface VisibleThread {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}

export function hasDesktopNotificationBridge(
  bridge: DesktopBridge | undefined,
): bridge is DesktopBridge {
  return bridge !== undefined;
}

export function visibleThreadFromPathname(pathname: string): VisibleThread {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] === "settings") {
    return { environmentId: null, threadId: null };
  }
  try {
    return {
      environmentId: decodeURIComponent(segments[0] ?? "") as EnvironmentId,
      threadId: decodeURIComponent(segments[1] ?? "") as ThreadId,
    };
  } catch {
    return { environmentId: null, threadId: null };
  }
}

export async function handleDesktopNotificationActivation(
  activation: DesktopNotificationActivation,
  actions: {
    readonly navigate: (environmentId: EnvironmentId, threadId: ThreadId) => Promise<unknown>;
    readonly openSubagents: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  },
): Promise<void> {
  if (activation.type === "subagent") {
    setPendingSubagentNotificationActivation(activation);
  }
  await actions.navigate(activation.environmentId, activation.threadId);
  if (activation.type === "subagent") {
    actions.openSubagents(activation.environmentId, activation.threadId);
  }
}

function boundedProjectName(projectName: string): string {
  const normalized = projectName.replace(/\s+/gu, " ").trim();
  return (normalized || "Unknown project").slice(0, 160).trim();
}

function preferenceAllows(
  preferences: DesktopNotificationPreferences,
  candidate: RootNotificationCandidate | SubagentNotificationCandidate,
): boolean {
  if (!preferences.enabled) return false;
  switch (candidate.event) {
    case "approval":
    case "input":
      return preferences.attention;
    case "plan-completed":
    case "completed":
      return candidate.type === "root"
        ? preferences.agentCompletion
        : preferences.subagentCompletion;
    case "failed":
      return preferences.failures;
    case "stopped":
    case "cancelled":
    case "paused":
      return preferences.stopped;
  }
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

async function loadRootNotificationDetail(
  candidate: RootNotificationCandidate,
): Promise<string | undefined> {
  if (
    candidate.turnId === null ||
    (candidate.event !== "completed" && candidate.event !== "plan-completed")
  ) {
    return undefined;
  }
  const atom = environmentThreadDetails.detailAtom(
    scopeThreadRef(candidate.environmentId, candidate.threadId),
  );
  const read = () => rootNotificationDetail(appAtomRegistry.get(atom), candidate.turnId);
  const current = read();
  if (current) return current;

  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let unsubscribe = () => {};
    const finish = (detail: string | undefined) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      unsubscribe();
      resolve(detail);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, () => {
      const detail = read();
      if (detail) finish(detail);
    });
    if (settled) {
      unsubscribe();
      return;
    }
    const afterSubscribe = read();
    if (afterSubscribe) {
      finish(afterSubscribe);
      return;
    }
    timeoutId = globalThis.setTimeout(() => finish(undefined), ROOT_NOTIFICATION_DETAIL_TIMEOUT_MS);
  });
}

function EnvironmentNotificationObserver({
  bridge,
  environmentId,
  preferences,
  visibleThread,
}: {
  bridge: DesktopBridge;
  environmentId: EnvironmentId;
  preferences: DesktopNotificationPreferences;
  visibleThread: VisibleThread;
}) {
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const subagents = useEnvironmentSubagentRunList(environmentId);
  const rootTrackerRef = useRef(new RootNotificationTracker());
  const subagentTrackerRef = useRef(new SubagentNotificationTracker());
  const preferencesRef = useLatest(preferences);
  const visibleThreadRef = useLatest(visibleThread);
  const pendingRootStopsRef = useRef<Map<string, number>>(new Map());
  const pendingSubagentBatchesRef = useRef<
    Map<
      string,
      {
        readonly candidates: SubagentNotificationCandidate[];
        readonly timer: number;
      }
    >
  >(new Map());

  const providerByInstanceId = useMemo(
    () =>
      new Map(
        (serverConfig?.providers ?? []).map((provider) => [
          String(provider.instanceId),
          provider.driver,
        ]),
      ),
    [serverConfig?.providers],
  );

  const shouldShow = (candidate: RootNotificationCandidate | SubagentNotificationCandidate) =>
    preferenceAllows(preferencesRef.current, candidate) &&
    !shouldSuppressDesktopNotification({
      desktopFocused: document.hasFocus(),
      visibleEnvironmentId: visibleThreadRef.current.environmentId,
      visibleThreadId: visibleThreadRef.current.threadId,
      eventEnvironmentId: candidate.environmentId,
      eventThreadId: candidate.threadId,
      notifyWhileViewingThread: preferencesRef.current.notifyWhileViewingThread,
    });

  const showRoot = async (candidate: RootNotificationCandidate) => {
    if (!shouldShow(candidate)) return;
    const detail = await loadRootNotificationDetail(candidate);
    const intent: DesktopNotificationIntent = {
      type: "root",
      event: candidate.event,
      provider: rootNotificationProvider(candidate, providerByInstanceId),
      projectName: boundedProjectName(candidate.projectName),
      environmentId: candidate.environmentId,
      threadId: candidate.threadId,
      ...(detail ? { detail } : {}),
      sound: preferencesRef.current.sound,
    };
    await bridge.showNotification(intent).catch(() => undefined);
  };

  const showSubagentBatch = (candidates: ReadonlyArray<SubagentNotificationCandidate>) => {
    const candidate = candidates.at(-1);
    if (!candidate || !shouldShow(candidate)) return;
    const detail = subagentNotificationDetail(candidate);
    const intent: DesktopNotificationIntent = {
      type: "subagent",
      event: candidate.event,
      provider: toDesktopNotificationProvider(candidate.provider),
      projectName: boundedProjectName(candidate.projectName),
      environmentId: candidate.environmentId,
      threadId: candidate.threadId,
      runId: candidate.run.id,
      count: Math.min(99, candidates.length),
      ...(detail ? { detail } : {}),
      sound: preferencesRef.current.sound,
    };
    void bridge.showNotification(intent).catch(() => undefined);
  };

  useEffect(() => {
    if (shellState.status !== "live" || Option.isNone(shellState.snapshot)) return;
    const candidates = rootTrackerRef.current.process(environmentId, shellState.snapshot.value);
    for (const candidate of candidates) {
      if (candidate.turnId) {
        const stopKey = `${candidate.threadId}:${candidate.turnId}`;
        if (candidate.event !== "stopped") {
          const pendingStop = pendingRootStopsRef.current.get(stopKey);
          if (pendingStop !== undefined) {
            window.clearTimeout(pendingStop);
            pendingRootStopsRef.current.delete(stopKey);
          }
        }
        if (candidate.event === "stopped") {
          const timer = window.setTimeout(() => {
            pendingRootStopsRef.current.delete(stopKey);
            void showRoot(candidate);
          }, ROOT_INTERRUPTION_SETTLE_MS);
          pendingRootStopsRef.current.set(stopKey, timer);
          continue;
        }
      }
      void showRoot(candidate);
    }
  }, [environmentId, providerByInstanceId, shellState]);

  useEffect(() => {
    if (!subagents.authoritative) return;
    const shellSnapshot = Option.getOrNull(shellState.snapshot);
    const candidates = subagentTrackerRef.current.process(
      environmentId,
      subagents.state,
      projectNamesByRootThread(shellSnapshot),
    );
    for (const candidate of candidates) {
      if (!isBatchableSubagentEvent(candidate.event)) {
        showSubagentBatch([candidate]);
        continue;
      }
      const key = subagentBatchKey(candidate);
      const existing = pendingSubagentBatchesRef.current.get(key);
      if (existing) {
        existing.candidates.splice(
          0,
          existing.candidates.length,
          ...appendSubagentBatch(existing.candidates, candidate),
        );
        continue;
      }
      const batch = [candidate];
      const timer = window.setTimeout(() => {
        pendingSubagentBatchesRef.current.delete(key);
        showSubagentBatch(batch);
      }, SUBAGENT_NOTIFICATION_BATCH_WINDOW_MS);
      pendingSubagentBatchesRef.current.set(key, { candidates: batch, timer });
    }
  }, [environmentId, shellState.snapshot, subagents.authoritative, subagents.state]);

  useEffect(
    () => () => {
      for (const timer of pendingRootStopsRef.current.values()) {
        window.clearTimeout(timer);
      }
      for (const batch of pendingSubagentBatchesRef.current.values()) {
        window.clearTimeout(batch.timer);
      }
      pendingRootStopsRef.current.clear();
      pendingSubagentBatchesRef.current.clear();
    },
    [],
  );

  return null;
}

function ConnectedDesktopNotificationCoordinator({ bridge }: { bridge: DesktopBridge }) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const preferences = useClientSettings((settings) => settings.desktopNotifications);
  const { environments } = useEnvironments();
  const visibleThread = useMemo(() => visibleThreadFromPathname(pathname), [pathname]);

  useEffect(() => {
    return bridge.onNotificationActivation((activation) => {
      void handleDesktopNotificationActivation(activation, {
        navigate: (environmentId, threadId) =>
          navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId },
          }),
        openSubagents: (environmentId, threadId) => {
          useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "subagents");
        },
      }).catch(() => undefined);
    });
  }, [bridge, navigate]);

  return (
    <>
      {environments.map((environment) => (
        <EnvironmentNotificationObserver
          key={environment.environmentId}
          bridge={bridge}
          environmentId={environment.environmentId}
          preferences={preferences}
          visibleThread={visibleThread}
        />
      ))}
    </>
  );
}

export function DesktopNotificationCoordinator() {
  const bridge = window.desktopBridge;
  return hasDesktopNotificationBridge(bridge) ? (
    <ConnectedDesktopNotificationCoordinator bridge={bridge} />
  ) : null;
}
