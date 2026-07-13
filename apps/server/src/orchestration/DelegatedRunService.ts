import {
  ApprovalRequestId,
  CommandId,
  DelegatedRun as DelegatedRunSchema,
  DelegatedRunError,
  DelegatedRunId,
  EventId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type DelegatedRun,
  type DelegatedRunCapabilities,
  type DelegatedRunProvider,
  type DelegatedRunStartInput,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import {
  describeDelegatedProviderCapabilities,
  resolveDelegatedProvider,
} from "../provider/DelegatedProviderResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  appendActiveSubagentTranscriptStatus,
  registerActiveSubagentTranscript,
} from "./SubagentTranscriptService.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { registerDelegatedMcpProjectContext } from "../mcp/McpSessionRegistry.ts";

const MAX_CONCURRENT_RUNS_PER_PARENT = 4;
const MAX_SUMMARY_CHARS = 4_000;
const STREAM_ACTIVITY_DETAIL_CHARS = 500;
const STREAM_ACTIVITY_INTERVAL_MS = 500;
const DelegatedRunsJson = Schema.fromJsonString(Schema.Array(DelegatedRunSchema));
const decodeDelegatedRunsJson = Schema.decodeUnknownEffect(DelegatedRunsJson);
const encodeDelegatedRunsJson = Schema.encodeEffect(DelegatedRunsJson);

// Delegated runs are intentionally less privileged than their parent. These
// values are not user-configurable: allowing a profile or tool call to loosen
// either one would turn a supposedly tracked subagent into an escape hatch.
const DELEGATED_SANDBOX_MODE = "workspace-write" as const;
const DELEGATED_RUNTIME_MODE = "auto-accept-edits" as const;
const DELEGATED_APPROVAL_POLICY = "never" as const;

export const DELEGATED_SUBAGENT_SAFETY_INSTRUCTIONS = `
## Subagent execution boundary

You may read, create, edit, move, and delete files inside the current project workspace as required by the assigned task. Do not access, modify, delete, or create anything outside that workspace, including parent directories, home directories, temporary directories, credentials, or global configuration.

Git is strictly read-only. You may use inspection commands such as \`git status\`, \`git diff\`, \`git log\`, \`git show\`, and \`git branch --show-current\`. Do not run any Git command that changes local or remote state, including \`git add\`, \`git commit\`, \`git push\`, \`git pull\`, \`git fetch\`, \`git merge\`, \`git rebase\`, \`git reset\`, \`git restore\`, \`git checkout\`, \`git clean\`, \`git stash\`, \`git switch\`, \`git tag\`, or any equivalent alias.

Before running a destructive filesystem command, ensure every target resolves inside the project workspace. Never use a relative traversal, home-directory path, global path, or other target that could remove, overwrite, move, or alter anything outside the project. If completing the task would require an action outside this boundary, stop and report the limitation to the parent agent.
`.trim();

const delegatedTaskInput = (task: string) =>
  `${DELEGATED_SUBAGENT_SAFETY_INSTRUCTIONS}\n\n## Assigned task\n\n${task}`;

const isDelegatedExecutionConfiguration = (input: {
  readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" | undefined;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "full-access" | undefined;
}) =>
  (input.sandboxMode === undefined || input.sandboxMode === DELEGATED_SANDBOX_MODE) &&
  (input.runtimeMode === undefined || input.runtimeMode === DELEGATED_RUNTIME_MODE);

const isTerminal = (run: DelegatedRun) =>
  run.status === "completed" || run.status === "failed" || run.status === "cancelled";

interface EmissionState {
  readonly lastEmittedAt: number;
  readonly flushFiber: Fiber.Fiber<void> | undefined;
}

export interface StartDelegatedRunInput extends DelegatedRunStartInput {
  readonly provider: DelegatedRunProvider;
  readonly parentThreadId: ThreadId;
  readonly parentTurnId?: string;
  readonly parentToolCallId?: string;
}

export interface DelegatedRunServiceShape {
  readonly start: (input: StartDelegatedRunInput) => Effect.Effect<DelegatedRun, DelegatedRunError>;
  readonly capabilities: (
    provider: DelegatedRunProvider,
  ) => Effect.Effect<DelegatedRunCapabilities>;
  readonly get: (runId: DelegatedRunId) => Effect.Effect<DelegatedRun, DelegatedRunError>;
  readonly awaitResult: (runId: DelegatedRunId) => Effect.Effect<DelegatedRun, DelegatedRunError>;
  readonly cancel: (
    runId: DelegatedRunId,
    reason?: "stopped_by_main_thread",
  ) => Effect.Effect<boolean, DelegatedRunError>;
  readonly respond: (
    runId: DelegatedRunId,
    answers: Readonly<Record<string, string | ReadonlyArray<string>>>,
  ) => Effect.Effect<DelegatedRun, DelegatedRunError>;
}

export class DelegatedRunService extends Context.Service<
  DelegatedRunService,
  DelegatedRunServiceShape
>()("t3/orchestration/DelegatedRunService") {}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const persistenceServices = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(Path.Path, path),
  );
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const persistencePath = path.join(serverConfig.stateDir, "delegated-runs.json");
  const persistedRuns = yield* fs.readFileString(persistencePath).pipe(
    Effect.flatMap(decodeDelegatedRunsJson),
    Effect.orElseSucceed(() => []),
  );
  const runsRef = yield* Ref.make(
    new Map(
      persistedRuns
        .filter(isTerminal)
        .map((run): readonly [DelegatedRunId, DelegatedRun] => [run.id, run]),
    ),
  );
  const runByProviderThreadRef = yield* Ref.make(new Map<ThreadId, DelegatedRunId>());
  const emissionRef = yield* Ref.make(new Map<DelegatedRunId, EmissionState>());
  const resultWaitersRef = yield* Ref.make(
    new Map<DelegatedRunId, Set<Deferred.Deferred<DelegatedRun>>>(),
  );
  const emissionLock = yield* Semaphore.make(1);

  const isResultReady = (run: DelegatedRun) =>
    isTerminal(run) || run.status === "waiting_for_input";

  const removeResultWaiter = (runId: DelegatedRunId, deferred: Deferred.Deferred<DelegatedRun>) =>
    Ref.update(resultWaitersRef, (waitersByRun) => {
      const waiters = waitersByRun.get(runId);
      if (!waiters?.has(deferred)) return waitersByRun;
      const copy = new Map(waitersByRun);
      const remaining = new Set(waiters);
      remaining.delete(deferred);
      if (remaining.size === 0) copy.delete(runId);
      else copy.set(runId, remaining);
      return copy;
    });

  const completeResultWaiters = Effect.fn("DelegatedRunService.completeResultWaiters")(function* (
    run: DelegatedRun,
  ) {
    if (!isResultReady(run)) return;
    const waiters = yield* Ref.modify(resultWaitersRef, (waitersByRun) => {
      const current = waitersByRun.get(run.id);
      if (!current) return [undefined, waitersByRun] as const;
      const copy = new Map(waitersByRun);
      copy.delete(run.id);
      return [current, copy] as const;
    });
    if (!waiters) return;
    yield* Effect.forEach(waiters, (deferred) => Deferred.succeed(deferred, run), {
      discard: true,
    });
  });

  const persistTerminalRuns = Effect.fn("DelegatedRunService.persistTerminalRuns")(function* () {
    const runs = yield* Ref.get(runsRef);
    const terminalRuns = [...runs.values()].filter(isTerminal);
    const contents = yield* encodeDelegatedRunsJson(terminalRuns).pipe(Effect.orDie);
    yield* writeFileStringAtomically({
      filePath: persistencePath,
      contents,
    }).pipe(
      Effect.provide(persistenceServices),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to persist delegated runs", { cause: String(cause) }),
      ),
    );
  });

  const appendActivity = Effect.fn("DelegatedRunService.appendActivity")(function* (
    run: DelegatedRun,
  ) {
    const terminal = isTerminal(run);
    const kind = run.sequence === 0 ? "tool.started" : terminal ? "tool.completed" : "tool.updated";
    const activityId =
      run.sequence === 0
        ? `delegated-run:${run.id}:start`
        : terminal
          ? `delegated-run:${run.id}:final`
          : `delegated-run:${run.id}:stream`;
    const { lastSummary: _lastSummary, finalMessage: _finalMessage, ...streamRun } = run;
    const commandSuffix = yield* Random.nextInt;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`delegated-run:${run.id}:${run.sequence}:${commandSuffix}`),
        threadId: run.parentThreadId,
        activity: {
          id: EventId.make(activityId),
          createdAt: run.updatedAt,
          tone: "tool",
          kind,
          summary: run.title,
          payload: {
            itemType: "collab_agent_tool_call",
            status: terminal ? (run.status === "completed" ? "completed" : "failed") : "inProgress",
            ...(run.lastSummary
              ? {
                  detail: terminal
                    ? run.lastSummary
                    : run.lastSummary.slice(-STREAM_ACTIVITY_DETAIL_CHARS),
                }
              : {}),
            data: {
              toolCallId: `delegated:${run.id}`,
              providerInstanceId: run.providerInstanceId,
              delegatedRun: terminal ? run : streamRun,
              input: { description: run.title, prompt: run.taskPreview },
              ...(run.finalMessage ? { result: run.finalMessage } : {}),
              ...(run.stopReason ? { stopReason: run.stopReason } : {}),
            },
          },
          turnId: run.parentTurnId ? TurnId.make(run.parentTurnId) : null,
        },
        createdAt: run.updatedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to project delegated run activity", {
            runId: run.id,
            cause: String(cause),
          }),
        ),
        Effect.asVoid,
      );
  });

  const interruptFlush = Effect.fn("DelegatedRunService.interruptFlush")(function* (
    runId: DelegatedRunId,
  ) {
    const flushFiber = yield* Ref.modify(emissionRef, (states) => {
      const state = states.get(runId);
      if (!state?.flushFiber) return [undefined, states] as const;
      const copy = new Map(states);
      copy.set(runId, { ...state, flushFiber: undefined });
      return [state.flushFiber, copy] as const;
    });
    if (flushFiber) yield* Fiber.interrupt(flushFiber).pipe(Effect.ignore);
  });

  const recordEmission = (runId: DelegatedRunId, lastEmittedAt: number) =>
    Ref.update(emissionRef, (states) => {
      const copy = new Map(states);
      copy.set(runId, { lastEmittedAt, flushFiber: undefined });
      return copy;
    });

  const flushLatestRun = Effect.fn("DelegatedRunService.flushLatestRun")(function* (
    runId: DelegatedRunId,
  ) {
    yield* emissionLock.withPermit(
      Effect.gen(function* () {
        const run = (yield* Ref.get(runsRef)).get(runId);
        if (!run || isTerminal(run)) {
          yield* Ref.update(emissionRef, (states) => {
            const copy = new Map(states);
            copy.delete(runId);
            return copy;
          });
          return;
        }
        const emittedAt = yield* Clock.currentTimeMillis;
        yield* appendActivity(run);
        yield* recordEmission(runId, emittedAt);
      }),
    );
  });

  const scheduleFlush = Effect.fn("DelegatedRunService.scheduleFlush")(function* (
    runId: DelegatedRunId,
    remaining: number,
  ) {
    const fiber = yield* Effect.sleep(remaining).pipe(
      Effect.andThen(flushLatestRun(runId)),
      Effect.forkDetach,
    );
    yield* Ref.update(emissionRef, (states) => {
      const state = states.get(runId);
      const copy = new Map(states);
      copy.set(runId, {
        lastEmittedAt: state?.lastEmittedAt ?? 0,
        flushFiber: fiber,
      });
      return copy;
    });
  });

  const emitUpdatedRun = Effect.fn("DelegatedRunService.emitUpdatedRun")(function* (
    current: DelegatedRun,
    updated: DelegatedRun,
  ) {
    const emittedAt = yield* Clock.currentTimeMillis;
    const state = (yield* Ref.get(emissionRef)).get(updated.id);
    const immediate =
      current.status !== updated.status ||
      isTerminal(updated) ||
      current.finalMessage !== updated.finalMessage ||
      current.error !== updated.error ||
      current.stopReason !== updated.stopReason;

    if (immediate || !state || emittedAt - state.lastEmittedAt >= STREAM_ACTIVITY_INTERVAL_MS) {
      yield* interruptFlush(updated.id);
      yield* appendActivity(updated);
      if (isTerminal(updated)) {
        yield* Ref.update(emissionRef, (states) => {
          const copy = new Map(states);
          copy.delete(updated.id);
          return copy;
        });
      } else {
        yield* recordEmission(updated.id, emittedAt);
      }
      return;
    }

    if (!state.flushFiber) {
      yield* scheduleFlush(
        updated.id,
        Math.max(0, STREAM_ACTIVITY_INTERVAL_MS - (emittedAt - state.lastEmittedAt)),
      );
    }
  });

  const updateRun = Effect.fn("DelegatedRunService.updateRun")(function* (
    runId: DelegatedRunId,
    update: (run: DelegatedRun) => DelegatedRun,
  ) {
    return yield* emissionLock.withPermit(
      Effect.gen(function* () {
        const transition = yield* Ref.modify(runsRef, (runs) => {
          const current = runs.get(runId);
          if (!current || isTerminal(current)) return [undefined, runs] as const;
          const updated = update(current);
          // Timestamps come from provider events with mixed clock sources; keep
          // updatedAt monotonic so appended activities never sort before older ones.
          const monotonic =
            updated.updatedAt < current.updatedAt
              ? { ...updated, updatedAt: current.updatedAt }
              : updated;
          const copy = new Map(runs);
          copy.set(runId, monotonic);
          return [{ current, updated: monotonic }, copy] as const;
        });
        if (!transition) return undefined;
        yield* emitUpdatedRun(transition.current, transition.updated);
        if (isTerminal(transition.updated)) yield* persistTerminalRuns();
        yield* completeResultWaiters(transition.updated);
        return transition.updated;
      }),
    );
  });

  const cancelInternal = Effect.fn("DelegatedRunService.cancelInternal")(function* (
    runId: DelegatedRunId,
    reason?: "stopped_by_main_thread",
  ) {
    const current = (yield* Ref.get(runsRef)).get(runId);
    if (!current || isTerminal(current)) return false;
    const providerThreadId = current.providerThreadId
      ? ThreadId.make(current.providerThreadId)
      : undefined;
    if (providerThreadId) {
      yield* providerService
        .interruptTurn({
          threadId: providerThreadId,
          ...(current.providerTurnId ? { turnId: TurnId.make(current.providerTurnId) } : {}),
        })
        .pipe(Effect.ignoreCause({ log: false }));
      yield* providerService
        .stopSession({ threadId: providerThreadId })
        .pipe(Effect.ignoreCause({ log: false }));
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* updateRun(runId, (run) => ({
      ...run,
      status: "cancelled",
      ...(reason ? { stopReason: reason } : {}),
      completedAt: now,
      updatedAt: now,
      sequence: run.sequence + 1,
    }));
    yield* appendActiveSubagentTranscriptStatus({
      transcriptId: runId,
      kind: "run.cancelled",
      summary:
        reason === "stopped_by_main_thread"
          ? "Cancelled because the parent thread stopped"
          : "Cancelled by the user",
      createdAt: now,
    });
    return true;
  });

  const handleProviderEvent = Effect.fn("DelegatedRunService.handleProviderEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const runId = (yield* Ref.get(runByProviderThreadRef)).get(event.threadId);
    if (runId) {
      const now = event.createdAt;
      if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
        yield* updateRun(runId, (run) => ({
          ...run,
          status: "running",
          lastSummary: `${run.lastSummary ?? ""}${event.payload.delta}`.slice(-MAX_SUMMARY_CHARS),
          updatedAt: now,
          sequence: run.sequence + 1,
        }));
      } else if (
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        event.payload.detail
      ) {
        yield* updateRun(runId, (run) => ({
          ...run,
          lastSummary: event.payload.detail!.slice(-MAX_SUMMARY_CHARS),
          finalMessage: event.payload.detail!,
          updatedAt: now,
          sequence: run.sequence + 1,
        }));
      } else if (event.type === "request.opened") {
        if (!event.requestId) {
          yield* updateRun(runId, (run) => ({
            ...run,
            status: "failed",
            error: "The provider requested permission without a request identifier.",
            completedAt: now,
            updatedAt: now,
            sequence: run.sequence + 1,
          }));
          yield* providerService
            .stopSession({ threadId: event.threadId })
            .pipe(Effect.ignoreCause({ log: false }));
        } else {
          yield* providerService
            .respondToRequest({
              threadId: event.threadId,
              requestId: ApprovalRequestId.make(event.requestId),
              decision: "accept",
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  yield* updateRun(runId, (run) => ({
                    ...run,
                    status: "failed",
                    error: `Could not auto-approve delegated permission request: ${cause.message}`,
                    completedAt: now,
                    updatedAt: now,
                    sequence: run.sequence + 1,
                  }));
                  yield* providerService
                    .stopSession({ threadId: event.threadId })
                    .pipe(Effect.ignoreCause({ log: false }));
                }),
              ),
            );
        }
      } else if (event.type === "user-input.requested") {
        yield* updateRun(runId, (run) => ({
          ...run,
          status: "waiting_for_input",
          ...(event.requestId ? { providerRequestId: event.requestId } : {}),
          updatedAt: now,
          sequence: run.sequence + 1,
        }));
      } else if (event.type === "runtime.error") {
        yield* updateRun(runId, (run) => ({
          ...run,
          status: "failed",
          error: event.payload.message,
          completedAt: now,
          updatedAt: now,
          sequence: run.sequence + 1,
        }));
      } else if (event.type === "turn.completed") {
        yield* updateRun(runId, (run) => ({
          ...run,
          status: event.payload.state === "completed" ? "completed" : "failed",
          error:
            event.payload.state === "completed"
              ? null
              : (event.payload.errorMessage ?? `Child turn ${event.payload.state}`),
          finalMessage: run.finalMessage ?? run.lastSummary,
          completedAt: now,
          updatedAt: now,
          sequence: run.sequence + 1,
        }));
        yield* providerService
          .stopSession({ threadId: event.threadId })
          .pipe(Effect.ignoreCause({ log: false }));
        yield* Ref.update(runByProviderThreadRef, (mapping) => {
          const copy = new Map(mapping);
          copy.delete(event.threadId);
          return copy;
        });
      }
      return;
    }

    if (
      (event.type === "turn.completed" && event.payload.state !== "completed") ||
      event.type === "session.exited"
    ) {
      const runs = yield* Ref.get(runsRef);
      yield* Effect.forEach(
        [...runs.values()].filter(
          (run) => run.parentThreadId === event.threadId && !isTerminal(run),
        ),
        (run) => cancelInternal(run.id, "stopped_by_main_thread"),
        { discard: true },
      );
    }
  });

  const providerEventsFiber = yield* providerService.streamEvents.pipe(
    Stream.runForEach(handleProviderEvent),
    Effect.forkDetach,
  );

  const start: DelegatedRunServiceShape["start"] = Effect.fn("DelegatedRunService.start")(
    function* (input) {
      const parent = yield* projectionSnapshotQuery.getThreadDetailById(input.parentThreadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          () =>
            new DelegatedRunError({
              operation: "start",
              message: "Could not read the parent thread.",
            }),
        ),
      );
      if (!parent) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: "The parent thread no longer exists.",
        });
      }
      const runs = yield* Ref.get(runsRef);
      const activeForParent = [...runs.values()].filter(
        (run) => run.parentThreadId === input.parentThreadId && !isTerminal(run),
      ).length;
      if (activeForParent >= MAX_CONCURRENT_RUNS_PER_PARENT) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: `A parent thread may run at most ${MAX_CONCURRENT_RUNS_PER_PARENT} delegated agents concurrently.`,
        });
      }

      const project = yield* projectionSnapshotQuery.getProjectShellById(parent.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          () =>
            new DelegatedRunError({
              operation: "start",
              message: "Could not read the parent project.",
            }),
        ),
      );
      const workspaceRoot = input.workspaceRoot ?? parent.worktreePath ?? project?.workspaceRoot;
      if (!workspaceRoot) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: "The parent thread has no workspace root.",
        });
      }
      const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
      const allowedRoots = [parent.worktreePath, project?.workspaceRoot]
        .filter((root): root is string => Boolean(root))
        .map((root) => path.resolve(root));
      const isAllowedWorkspace = allowedRoots.some((root) => {
        const relative = path.relative(root, resolvedWorkspaceRoot);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });
      if (!isAllowedWorkspace) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: "Delegated runs must stay inside the parent project workspace.",
        });
      }
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          () =>
            new DelegatedRunError({
              operation: "start",
              message: "Could not read delegation profiles.",
            }),
        ),
      );
      const explicitConfiguration =
        input.providerInstanceId !== undefined ||
        input.model !== undefined ||
        input.options !== undefined ||
        input.interactionMode !== undefined ||
        input.approvalPolicy !== undefined ||
        input.sandboxMode !== undefined ||
        input.runtimeMode !== undefined ||
        input.attachments !== undefined;
      if (input.profile !== undefined && explicitConfiguration) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: "A delegation profile cannot be combined with explicit execution configuration.",
        });
      }
      const matchingProfiles = input.profile
        ? settings.delegationProfiles.filter((candidate) => candidate.id === input.profile)
        : [];
      if (matchingProfiles.length > 1) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: `Delegation profile '${input.profile}' is configured more than once.`,
        });
      }
      const profile = matchingProfiles[0];
      if (input.profile !== undefined && !profile) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: `Delegation profile '${input.profile}' is not configured.`,
        });
      }
      if (profile && profile.provider !== input.provider) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: `Delegation profile '${profile.id}' is for '${profile.provider}', not '${input.provider}'.`,
        });
      }
      if (
        !isDelegatedExecutionConfiguration(input) ||
        (profile && !isDelegatedExecutionConfiguration(profile))
      ) {
        return yield* new DelegatedRunError({
          operation: "start",
          message:
            "Delegated runs are fixed to the workspace-write sandbox and auto-accept-edits runtime. They may not use read-only, full-access, or danger-full-access execution settings.",
        });
      }
      const providerInstanceId = profile?.providerInstanceId ?? input.providerInstanceId;
      const requestedModel = profile?.model ?? input.model;
      const requestedOptions = profile?.options ?? input.options;
      const interactionMode = profile?.interactionMode ?? input.interactionMode ?? "default";
      const approvalPolicy = DELEGATED_APPROVAL_POLICY;
      const sandboxMode = DELEGATED_SANDBOX_MODE;
      const runtimeMode = DELEGATED_RUNTIME_MODE;
      const attachments = profile?.attachments ?? input.attachments ?? [];
      const task = delegatedTaskInput(input.task);
      if (task.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: "The delegated task is too large after mandatory safety instructions are added.",
        });
      }
      const providerSnapshots = yield* providerRegistry.getProviders;
      const resolution = resolveDelegatedProvider({
        providers: providerSnapshots,
        provider: input.provider,
        providerInstanceId,
        model: requestedModel,
        options: requestedOptions,
      });
      if (!resolution.ok) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: resolution.message,
        });
      }
      const resolvedProviderInstanceId = resolution.value.instance.instanceId;
      const resolvedModel = resolution.value.resolvedModel;
      const modelSelection = resolution.value.modelSelection;
      const runId = DelegatedRunId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            () =>
              new DelegatedRunError({
                operation: "start",
                message: "Could not allocate a delegated run identifier.",
              }),
          ),
        ),
      );
      const providerThreadId = ThreadId.make(`delegated-${runId}`);
      registerDelegatedMcpProjectContext(providerThreadId, input.parentThreadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const run: DelegatedRun = {
        id: runId,
        provider: input.provider,
        providerInstanceId: resolvedProviderInstanceId,
        parentThreadId: input.parentThreadId,
        ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
        ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
        providerThreadId,
        title: input.title ?? input.task.slice(0, 100),
        taskPreview: input.task.slice(0, 500),
        status: "queued",
        lastSummary: null,
        finalMessage: null,
        error: null,
        ...(resolvedModel ? { model: resolvedModel, resolvedModel } : {}),
        ...(requestedModel ? { requestedModel } : {}),
        ...(requestedOptions ? { requestedOptions } : {}),
        ...(modelSelection?.options ? { resolvedOptions: modelSelection.options } : {}),
        interactionMode,
        approvalPolicy,
        sandboxMode,
        runtimeMode,
        attachments,
        ...(profile ? { profile: profile.id } : {}),
        workspaceRoot: resolvedWorkspaceRoot,
        sequence: 0,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* Ref.update(runsRef, (current) => new Map(current).set(runId, run));
      yield* Ref.update(runByProviderThreadRef, (current) =>
        new Map(current).set(providerThreadId, runId),
      );
      yield* registerActiveSubagentTranscript({
        id: runId,
        source: "delegated",
        parentThreadId: input.parentThreadId,
        providerInstanceId: resolvedProviderInstanceId,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(requestedOptions ? { requestedOptions } : {}),
        ...(modelSelection?.options ? { resolvedOptions: modelSelection.options } : {}),
        task: input.task,
        createdAt: now,
      });
      yield* emissionLock.withPermit(
        Effect.gen(function* () {
          yield* appendActivity(run);
          yield* recordEmission(run.id, yield* Clock.currentTimeMillis);
        }),
      );

      yield* Effect.gen(function* () {
        const startingAt = DateTime.formatIso(yield* DateTime.now);
        yield* updateRun(runId, (current) => ({
          ...current,
          status: "starting",
          startedAt: startingAt,
          updatedAt: startingAt,
          sequence: current.sequence + 1,
        }));
        yield* providerService.startSession(providerThreadId, {
          threadId: providerThreadId,
          provider: ProviderDriverKind.make(input.provider),
          providerInstanceId: resolvedProviderInstanceId,
          cwd: resolvedWorkspaceRoot,
          ...(modelSelection ? { modelSelection } : {}),
          approvalPolicy,
          sandboxMode,
          runtimeMode,
        });
        const turn = yield* providerService.sendTurn({
          threadId: providerThreadId,
          input: task,
          attachments,
          interactionMode,
          ...(modelSelection ? { modelSelection } : {}),
        });
        const runningAt = DateTime.formatIso(yield* DateTime.now);
        yield* updateRun(runId, (current) => ({
          ...current,
          status: "running",
          providerTurnId: turn.turnId,
          updatedAt: runningAt,
          sequence: current.sequence + 1,
        }));
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const failedAt = DateTime.formatIso(yield* DateTime.now);
            yield* updateRun(runId, (current) => ({
              ...current,
              status: "failed",
              error: cause.message,
              completedAt: failedAt,
              updatedAt: failedAt,
              sequence: current.sequence + 1,
            }));
            yield* appendActiveSubagentTranscriptStatus({
              transcriptId: runId,
              kind: "run.failed",
              summary: cause.message,
              createdAt: failedAt,
              tone: "error",
            });
          }),
        ),
        Effect.forkDetach,
      );

      return run;
    },
  );

  const capabilities: DelegatedRunServiceShape["capabilities"] = Effect.fn(
    "DelegatedRunService.capabilities",
  )(function* (provider) {
    const providerSnapshots = yield* providerRegistry.getProviders;
    return describeDelegatedProviderCapabilities({
      providers: providerSnapshots,
      provider,
      supportsCancellation: true,
      supportsQuestions: provider === "cursor",
    });
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Fiber.interrupt(providerEventsFiber).pipe(Effect.ignore);
      const states = yield* Ref.getAndSet(emissionRef, new Map());
      yield* Effect.forEach(
        [...states.values()],
        (state) =>
          state.flushFiber ? Fiber.interrupt(state.flushFiber).pipe(Effect.ignore) : Effect.void,
        { discard: true },
      );
    }),
  );

  return DelegatedRunService.of({
    start,
    capabilities,
    get: Effect.fn("DelegatedRunService.get")(function* (runId) {
      const run = (yield* Ref.get(runsRef)).get(runId);
      if (run) return run;
      return yield* new DelegatedRunError({
        operation: "status",
        message: "Delegated run not found.",
        runId,
      });
    }),
    awaitResult: Effect.fn("DelegatedRunService.awaitResult")(function* (runId) {
      const registration = yield* emissionLock.withPermit(
        Effect.gen(function* () {
          const run = (yield* Ref.get(runsRef)).get(runId);
          if (!run) {
            return yield* new DelegatedRunError({
              operation: "result",
              message: "Delegated run not found.",
              runId,
            });
          }
          if (isResultReady(run)) return { _tag: "ready" as const, run };

          const deferred = yield* Deferred.make<DelegatedRun>();
          yield* Ref.update(resultWaitersRef, (waitersByRun) => {
            const copy = new Map(waitersByRun);
            const waiters = new Set(copy.get(runId) ?? []);
            waiters.add(deferred);
            copy.set(runId, waiters);
            return copy;
          });
          return { _tag: "waiting" as const, deferred };
        }),
      );
      if (registration._tag === "ready") return registration.run;
      return yield* Deferred.await(registration.deferred).pipe(
        Effect.ensuring(removeResultWaiter(runId, registration.deferred)),
      );
    }),
    cancel: Effect.fn("DelegatedRunService.cancel")(function* (runId, reason) {
      const run = (yield* Ref.get(runsRef)).get(runId);
      if (!run) {
        return yield* new DelegatedRunError({
          operation: "cancel",
          message: "Delegated run not found.",
          runId,
        });
      }
      return yield* cancelInternal(runId, reason);
    }),
    respond: Effect.fn("DelegatedRunService.respond")(function* (runId, answers) {
      const run = (yield* Ref.get(runsRef)).get(runId);
      if (
        !run ||
        run.status !== "waiting_for_input" ||
        !run.providerRequestId ||
        !run.providerThreadId
      ) {
        return yield* new DelegatedRunError({
          operation: "respond",
          message: "The delegated run is not waiting for structured input.",
          runId,
        });
      }
      yield* providerService
        .respondToUserInput({
          threadId: ThreadId.make(run.providerThreadId),
          requestId: run.providerRequestId as Parameters<
            typeof providerService.respondToUserInput
          >[0]["requestId"],
          answers,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DelegatedRunError({
                operation: "respond",
                message: cause.message,
                runId,
              }),
          ),
        );
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* updateRun(runId, (current) => {
        const { providerRequestId: _providerRequestId, ...rest } = current;
        return {
          ...rest,
          status: "running",
          updatedAt,
          sequence: current.sequence + 1,
        };
      });
      if (!updated) {
        return yield* new DelegatedRunError({
          operation: "respond",
          message: "The delegated run finished before the response was applied.",
          runId,
        });
      }
      return updated;
    }),
  });
});

let activeDelegatedRunService: DelegatedRunServiceShape | undefined;

export const layer = Layer.effect(
  DelegatedRunService,
  Effect.acquireRelease(
    make.pipe(
      Effect.tap((service) =>
        Effect.sync(() => {
          activeDelegatedRunService = service;
        }),
      ),
    ),
    (service) =>
      Effect.sync(() => {
        if (activeDelegatedRunService === service) activeDelegatedRunService = undefined;
      }),
  ),
);

const unavailable = (
  operation: "start" | "status" | "result" | "cancel" | "respond",
  runId?: DelegatedRunId,
) =>
  new DelegatedRunError({
    operation,
    message: "Delegated-run service is not available.",
    ...(runId ? { runId } : {}),
  });

export const startActiveDelegatedRun = (input: StartDelegatedRunInput) =>
  activeDelegatedRunService
    ? activeDelegatedRunService.start(input)
    : Effect.fail(unavailable("start"));

export const getActiveDelegatedCapabilities = (
  provider: DelegatedRunProvider,
): Effect.Effect<DelegatedRunCapabilities, DelegatedRunError> =>
  activeDelegatedRunService
    ? activeDelegatedRunService.capabilities(provider)
    : Effect.fail(unavailable("start"));

export const getActiveDelegatedRun = (runId: DelegatedRunId) =>
  activeDelegatedRunService
    ? activeDelegatedRunService.get(runId)
    : Effect.fail(unavailable("status", runId));

export const awaitActiveDelegatedRunResult = (runId: DelegatedRunId) =>
  activeDelegatedRunService
    ? activeDelegatedRunService.awaitResult(runId)
    : Effect.fail(unavailable("result", runId));

export const cancelActiveDelegatedRun = (runId: DelegatedRunId) =>
  activeDelegatedRunService
    ? activeDelegatedRunService.cancel(runId)
    : Effect.fail(unavailable("cancel", runId));

export const respondToActiveDelegatedRun = (
  runId: DelegatedRunId,
  answers: Readonly<Record<string, string | ReadonlyArray<string>>>,
) =>
  activeDelegatedRunService
    ? activeDelegatedRunService.respond(runId, answers)
    : Effect.fail(unavailable("respond", runId));

const withActiveService = <A, E, R>(
  service: DelegatedRunServiceShape,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = activeDelegatedRunService;
      activeDelegatedRunService = service;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        activeDelegatedRunService = previous;
      }),
  );

export const __testing = { make, withActiveService };
