import {
  CommandId,
  TERMINAL_EXEC_MAX_READ_CHARS,
  TERMINAL_EXEC_MAX_STREAM_CHARS,
  TerminalExecConflictError,
  TerminalExecFailure,
  TerminalExecNotFoundError,
  TerminalExecThreadBusyError,
  TerminalExecThreadNotFoundError,
  type TerminalCommandRecord,
  type TerminalExecAttachInput,
  type TerminalExecCancelInput,
  TerminalExecError as TerminalExecErrorSchema,
  type TerminalExecError,
  type TerminalExecReadOutputInput,
  type TerminalExecReadOutputResult,
  type TerminalExecStartInput,
  type TerminalExecStreamEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { TerminalCommandProcess, type TerminalCommandProcessHandle } from "./CommandProcess.ts";
import { TerminalReplaySanitizer } from "./outputSanitizer.ts";

const MAX_GLOBAL_EXECUTIONS = 4;
const RECONNECT_TAIL_BYTES = 512 * 1_024;
const LOG_HEAD_BYTES = 4 * 1_024 * 1_024;
const LOG_TAIL_BYTES = 60 * 1_024 * 1_024;
const LOG_MAX_BYTES = LOG_HEAD_BYTES + LOG_TAIL_BYTES;
const THREAD_LOG_BUDGET_BYTES = 256 * 1_024 * 1_024;
const EXCERPT_HEAD_CHARS = 8 * 1_024;
const EXCERPT_TAIL_CHARS = 56 * 1_024;

type Listener = (event: TerminalExecStreamEvent) => Effect.Effect<void>;

interface ExecutionState {
  readonly input: TerminalExecStartInput;
  readonly cwd: string;
  record: TerminalCommandRecord;
  sequence: number;
  first: string;
  tail: string;
  reconnectTail: string;
  logBytes: number;
  nextCrashRewriteBytes: number;
  readonly sanitizer: TerminalReplaySanitizer;
  readonly listeners: Set<Listener>;
  readonly finalized: Deferred.Deferred<TerminalCommandRecord>;
  readonly logSemaphore: Semaphore.Semaphore;
  handle: TerminalCommandProcessHandle | null;
  cancelReason: "cancelled" | "timed_out" | null;
}

export interface TerminalCommandManagerShape {
  readonly start: (
    input: TerminalExecStartInput,
  ) => Effect.Effect<TerminalCommandRecord, TerminalExecError>;
  readonly attachStream: (
    input: TerminalExecAttachInput,
    listener: Listener,
  ) => Effect.Effect<() => void, TerminalExecError>;
  readonly cancel: (
    input: TerminalExecCancelInput,
  ) => Effect.Effect<TerminalCommandRecord, TerminalExecError>;
  readonly readOutput: (
    input: TerminalExecReadOutputInput,
  ) => Effect.Effect<TerminalExecReadOutputResult, TerminalExecError>;
  readonly cleanupThread: (threadId: ThreadId) => Effect.Effect<void>;
}

export class TerminalCommandManager extends Context.Service<
  TerminalCommandManager,
  TerminalCommandManagerShape
>()("t3/terminal/CommandManager/TerminalCommandManager") {}

function terminalCommandIsActive(record: TerminalCommandRecord): boolean {
  return record.status === "queued" || record.status === "running";
}

function terminalCommandIsFinal(record: TerminalCommandRecord): boolean {
  return !terminalCommandIsActive(record);
}

function utf8Head(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] ?? 0) >= 0x80 && (buffer[start] ?? 0) < 0xc0) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function retainedOutput(state: ExecutionState): string {
  if (state.logBytes <= LOG_MAX_BYTES) return state.first + state.tail;
  const omitted = Math.max(
    0,
    state.logBytes - Buffer.byteLength(state.first) - Buffer.byteLength(state.tail),
  );
  return `${state.first}\n\n[... ${omitted.toLocaleString("en-US")} bytes omitted ...]\n\n${state.tail}`;
}

function timelineExcerpt(output: string): { excerpt: string; truncated: boolean } {
  const max = EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS;
  if (output.length <= max) return { excerpt: output, truncated: false };
  const omitted = output.length - max;
  return {
    excerpt: `${output.slice(0, EXCERPT_HEAD_CHARS)}\n\n[... ${omitted.toLocaleString("en-US")} characters omitted ...]\n\n${output.slice(-EXCERPT_TAIL_CHARS)}`,
    truncated: true,
  };
}

function safeLogPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const processDriver = yield* TerminalCommandProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestration = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const logsDir = path.join(config.terminalLogsDir, "commands");
  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);
  const workerScope = yield* Scope.make("sequential");
  const startSemaphore = yield* Semaphore.make(1);

  const executions = new Map<string, ExecutionState>();
  const queue: string[] = [];
  const activeThreads = new Set<string>();
  let runningCount = 0;
  let pumping = false;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:terminal-command:${tag}:${uuid}`)),
    );

  const fail = (
    state: Pick<ExecutionState, "input">,
    operation: TerminalExecFailure["operation"],
    detail: string,
  ) =>
    new TerminalExecFailure({
      threadId: state.input.threadId,
      executionId: state.input.executionId,
      operation,
      detail,
    });
  const normalizeError =
    (state: Pick<ExecutionState, "input">, operation: TerminalExecFailure["operation"]) =>
    (cause: unknown): TerminalExecError =>
      Schema.is(TerminalExecErrorSchema)(cause)
        ? cause
        : fail(
            state,
            operation,
            cause instanceof Error ? cause.message : "Terminal command operation failed.",
          );

  const persist = Effect.fn("TerminalCommandManager.persist")(function* (state: ExecutionState) {
    const createdAt = yield* nowIso;
    yield* orchestration
      .dispatch({
        type: "thread.terminal-command.upsert",
        commandId: yield* commandId(state.record.status),
        threadId: state.input.threadId,
        messageId: state.input.messageId,
        terminalCommand: state.record,
        createdAt,
      })
      .pipe(
        Effect.mapError((cause) =>
          fail(
            state,
            "persist",
            cause instanceof Error ? cause.message : "Failed to persist terminal command state.",
          ),
        ),
      );
  });

  const publish = Effect.fn("TerminalCommandManager.publish")(function* (
    state: ExecutionState,
    event: TerminalExecStreamEvent,
  ) {
    for (const listener of state.listeners) {
      yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const publishStatus = (state: ExecutionState) => {
    state.sequence += 1;
    return publish(state, {
      type: "status",
      threadId: state.input.threadId,
      executionId: state.input.executionId,
      sequence: state.sequence,
      record: state.record,
    });
  };

  const threadLogDir = (threadId: string) => path.join(logsDir, safeLogPart(threadId));
  const executionLogPath = (threadId: string, executionId: string) =>
    path.join(threadLogDir(threadId), `${safeLogPart(executionId)}.log`);
  const logPath = (state: ExecutionState) =>
    executionLogPath(state.input.threadId, state.input.executionId);

  const pruneThreadLogs = Effect.fn("TerminalCommandManager.pruneThreadLogs")(function* (
    threadId: string,
  ) {
    const directory = threadLogDir(threadId);
    const names = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const entries = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".log")),
      (name) =>
        fileSystem.stat(path.join(directory, name)).pipe(
          Effect.map((stat) => ({
            name,
            size: Number(stat.size),
            mtimeMs: Option.match(stat.mtime, {
              onNone: () => 0,
              onSome: (value) => value.getTime(),
            }),
          })),
          Effect.option,
        ),
    ).pipe(
      Effect.map((values) =>
        values
          .flatMap(Option.match({ onNone: () => [], onSome: (value) => [value] }))
          .toSorted((left, right) => right.mtimeMs - left.mtimeMs),
      ),
    );
    let retained = 0;
    for (const entry of entries) {
      retained += entry.size;
      if (retained <= THREAD_LOG_BUDGET_BYTES) continue;
      yield* fileSystem
        .remove(path.join(directory, entry.name), { force: true })
        .pipe(Effect.ignore);
    }
  });

  const writeFinalLog = (state: ExecutionState) =>
    state.logSemaphore
      .withPermit(fileSystem.writeFileString(logPath(state), retainedOutput(state)))
      .pipe(
        Effect.mapError((cause) =>
          fail(
            state,
            "persist",
            cause instanceof Error ? cause.message : "Failed to save command output.",
          ),
        ),
        Effect.tap(() => pruneThreadLogs(state.input.threadId)),
      );

  const appendCrashLog = (state: ExecutionState, chunk: string) => {
    if (state.logBytes <= LOG_MAX_BYTES) {
      runFork(
        state.logSemaphore
          .withPermit(fileSystem.writeFileString(logPath(state), chunk, { flag: "a" }))
          .pipe(Effect.ignore),
      );
      return;
    }
    if (state.logBytes < state.nextCrashRewriteBytes) return;
    state.nextCrashRewriteBytes += 1 * 1_024 * 1_024;
    runFork(
      state.logSemaphore
        .withPermit(fileSystem.writeFileString(logPath(state), retainedOutput(state)))
        .pipe(Effect.ignore),
    );
  };

  const appendOutput = (state: ExecutionState, rawChunk: string) => {
    const chunk = state.sanitizer.push(rawChunk);
    if (chunk.length === 0 || terminalCommandIsFinal(state.record)) return;
    state.logBytes += Buffer.byteLength(chunk);
    state.record = { ...state.record, logBytes: state.logBytes };
    const firstBytes = Buffer.byteLength(state.first);
    if (firstBytes < LOG_HEAD_BYTES) {
      const remaining = LOG_HEAD_BYTES - firstBytes;
      const head = utf8Head(chunk, remaining);
      state.first += head;
      state.tail += chunk.slice(head.length);
    } else {
      state.tail += chunk;
    }
    state.tail = utf8Tail(state.tail, LOG_TAIL_BYTES);
    state.reconnectTail = utf8Tail(state.reconnectTail + chunk, RECONNECT_TAIL_BYTES);
    appendCrashLog(state, chunk);

    for (let offset = 0; offset < chunk.length; offset += TERMINAL_EXEC_MAX_STREAM_CHARS) {
      const data = chunk.slice(offset, offset + TERMINAL_EXEC_MAX_STREAM_CHARS);
      state.sequence += 1;
      runFork(
        publish(state, {
          type: "output",
          threadId: state.input.threadId,
          executionId: state.input.executionId,
          sequence: state.sequence,
          data,
        }),
      );
    }
  };

  const finalize = Effect.fn("TerminalCommandManager.finalize")(function* (
    state: ExecutionState,
    status: TerminalCommandRecord["status"],
    exitCode: number | null,
  ) {
    if (terminalCommandIsFinal(state.record)) return state.record;
    const finalTail = state.sanitizer.push("", true);
    if (finalTail.length > 0) appendOutput(state, finalTail);
    const completedAt = yield* nowIso;
    const completedAtMs = yield* Clock.currentTimeMillis;
    const startedAtMs = state.record.startedAt ? Date.parse(state.record.startedAt) : completedAtMs;
    const excerpt = timelineExcerpt(retainedOutput(state));
    state.record = {
      ...state.record,
      status,
      exitCode,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      excerpt: excerpt.excerpt,
      truncated: excerpt.truncated || state.logBytes > LOG_MAX_BYTES,
      logBytes: state.logBytes,
      completedAt,
    };
    yield* writeFinalLog(state).pipe(Effect.catch(() => Effect.void));
    const persistExit = yield* Effect.exit(persist(state));
    yield* publishStatus(state);
    yield* Deferred.succeed(state.finalized, state.record);
    if (Exit.isFailure(persistExit)) {
      return yield* Effect.failCause(persistExit.cause);
    }
    return state.record;
  });

  const scheduleEscalation = (state: ExecutionState) =>
    Effect.gen(function* () {
      const handle = state.handle;
      if (!handle) return;
      yield* handle.interrupt;
    });

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    try {
      while (runningCount < MAX_GLOBAL_EXECUTIONS) {
        const index = queue.findIndex((executionId) => {
          const state = executions.get(executionId);
          return state !== undefined && !activeThreads.has(state.input.threadId);
        });
        if (index < 0) break;
        const executionId = queue.splice(index, 1)[0];
        const state = executionId ? executions.get(executionId) : undefined;
        if (!state || state.record.status !== "queued") continue;
        activeThreads.add(state.input.threadId);
        runningCount += 1;
        runFork(
          Effect.gen(function* () {
            const startedAt = yield* nowIso;
            state.record = { ...state.record, status: "running", startedAt };
            yield* persist(state);
            yield* publishStatus(state);
            const handle = yield* processDriver.start({
              threadId: state.input.threadId,
              executionId: state.input.executionId,
              command: state.input.command,
              cwd: state.cwd,
              onOutput: (chunk) => appendOutput(state, chunk),
            });
            state.handle = handle;
            if (state.input.timeoutMs !== undefined) {
              yield* Effect.gen(function* () {
                yield* Effect.sleep(Duration.millis(state.input.timeoutMs!));
                if (state.record.status !== "running") return;
                state.cancelReason = "timed_out";
                yield* scheduleEscalation(state);
              }).pipe(Effect.forkIn(workerScope));
            }
            const result = yield* handle.completed;
            const status = state.cancelReason ?? (result.exitCode === 0 ? "completed" : "failed");
            yield* finalize(state, status, result.exitCode);
          }).pipe(
            Effect.catch((cause) =>
              finalize(state, "failed", null).pipe(
                Effect.tap(() =>
                  Effect.logWarning("terminal command execution failed", {
                    executionId: state.input.executionId,
                    cause: cause instanceof Error ? cause.message : String(cause),
                  }),
                ),
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                activeThreads.delete(state.input.threadId);
                runningCount = Math.max(0, runningCount - 1);
                state.handle = null;
                pump();
              }),
            ),
          ),
        );
      }
    } finally {
      pumping = false;
    }
  };

  const findPersisted = Effect.fn("TerminalCommandManager.findPersisted")(function* (
    threadId: ThreadId,
    executionId: string,
  ) {
    const thread = yield* projection.getThreadDetailById(threadId).pipe(
      Effect.mapError(() => new TerminalExecThreadNotFoundError({ threadId })),
      Effect.map(Option.getOrUndefined),
    );
    return (
      thread?.messages.find((message) => message.terminalCommand?.executionId === executionId) ??
      null
    );
  });

  const startRaw = Effect.fn("TerminalCommandManager.start")(function* (
    input: TerminalExecStartInput,
  ) {
    const live = executions.get(input.executionId);
    if (live) {
      if (
        live.input.threadId !== input.threadId ||
        live.input.messageId !== input.messageId ||
        live.input.command !== input.command
      ) {
        return yield* new TerminalExecConflictError({
          threadId: input.threadId,
          executionId: input.executionId,
          detail: `Execution id '${input.executionId}' is already used by a different terminal command.`,
        });
      }
      return live.record;
    }

    const persisted = yield* findPersisted(input.threadId, input.executionId);
    if (persisted?.terminalCommand) {
      if (persisted.id !== input.messageId || persisted.terminalCommand.command !== input.command) {
        return yield* new TerminalExecConflictError({
          threadId: input.threadId,
          executionId: input.executionId,
          detail: `Execution id '${input.executionId}' is already used by a different terminal command.`,
        });
      }
      return persisted.terminalCommand;
    }

    const thread = yield* projection.getThreadDetailById(input.threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(() => new TerminalExecThreadNotFoundError({ threadId: input.threadId })),
    );
    if (!thread) return yield* new TerminalExecThreadNotFoundError({ threadId: input.threadId });
    const hasActiveTurn =
      thread.session?.activeTurnId != null ||
      thread.session?.status === "running" ||
      thread.latestTurn?.state === "running";
    if (hasActiveTurn) {
      return yield* new TerminalExecThreadBusyError({
        threadId: input.threadId,
        detail: "Interrupt the active agent turn before running a terminal command.",
      });
    }
    const project = yield* projection.getProjectShellById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(() => new TerminalExecThreadNotFoundError({ threadId: input.threadId })),
    );
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    if (!cwd) return yield* new TerminalExecThreadNotFoundError({ threadId: input.threadId });
    const finalized = yield* Deferred.make<TerminalCommandRecord>();
    const logSemaphore = yield* Semaphore.make(1);
    yield* fileSystem.makeDirectory(threadLogDir(input.threadId), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new TerminalExecFailure({
            threadId: input.threadId,
            executionId: input.executionId,
            operation: "start",
            detail: `Failed to create terminal command log directory: ${cause.message}`,
          }),
      ),
    );
    const state: ExecutionState = {
      input,
      cwd,
      record: {
        executionId: input.executionId,
        command: input.command,
        cwd,
        status: "queued",
        exitCode: null,
        durationMs: 0,
        excerpt: "",
        truncated: false,
        logBytes: 0,
        startedAt: null,
        completedAt: null,
        consumedAt: null,
        stale: false,
      },
      sequence: 0,
      first: "",
      tail: "",
      reconnectTail: "",
      logBytes: 0,
      nextCrashRewriteBytes: LOG_MAX_BYTES + 1 * 1_024 * 1_024,
      sanitizer: new TerminalReplaySanitizer(),
      listeners: new Set(),
      finalized,
      logSemaphore,
      handle: null,
      cancelReason: null,
    };
    // Persist before exposing the execution to the scheduler. The start RPC
    // therefore acknowledges only after the queued timeline row is durable.
    yield* persist(state);
    executions.set(input.executionId, state);
    queue.push(input.executionId);
    pump();
    return state.record;
  });
  const start: TerminalCommandManagerShape["start"] = (input) =>
    startSemaphore
      .withPermit(startRaw(input))
      .pipe(Effect.mapError(normalizeError({ input }, "start")));

  const attachStream: TerminalCommandManagerShape["attachStream"] = Effect.fn(
    "TerminalCommandManager.attachStream",
  )(function* (input, listener) {
    const state = executions.get(input.executionId);
    if (state && state.input.threadId === input.threadId) {
      state.listeners.add(listener);
      yield* listener({
        type: "snapshot",
        threadId: input.threadId,
        executionId: input.executionId,
        sequence: state.sequence,
        record: state.record,
        tail: state.reconnectTail,
      });
      return () => state.listeners.delete(listener);
    }
    const persisted = yield* findPersisted(input.threadId, input.executionId);
    if (!persisted?.terminalCommand) {
      return yield* new TerminalExecNotFoundError({
        threadId: input.threadId,
        executionId: input.executionId,
      });
    }
    yield* listener({
      type: "snapshot",
      threadId: input.threadId,
      executionId: input.executionId,
      sequence: input.afterSequence ?? 0,
      record: persisted.terminalCommand,
      tail: persisted.terminalCommand.excerpt,
    });
    return () => {};
  });

  const cancelRaw = Effect.fn("TerminalCommandManager.cancel")(function* (
    input: TerminalExecCancelInput,
  ) {
    const state = executions.get(input.executionId);
    if (!state || state.input.threadId !== input.threadId) {
      const persisted = yield* findPersisted(input.threadId, input.executionId);
      if (persisted?.terminalCommand) return persisted.terminalCommand;
      return yield* new TerminalExecNotFoundError({
        threadId: input.threadId,
        executionId: input.executionId,
      });
    }
    if (terminalCommandIsFinal(state.record)) return state.record;
    state.cancelReason = "cancelled";
    if (state.record.status === "queued") {
      const index = queue.indexOf(input.executionId);
      if (index >= 0) queue.splice(index, 1);
      return yield* finalize(state, "cancelled", null);
    }
    yield* scheduleEscalation(state);
    return yield* Deferred.await(state.finalized);
  });
  const cancel: TerminalCommandManagerShape["cancel"] = (input) =>
    cancelRaw(input).pipe(
      Effect.mapError(
        normalizeError(
          {
            input: {
              ...input,
              messageId: "" as TerminalExecStartInput["messageId"],
              command: "",
            },
          },
          "cancel",
        ),
      ),
    );

  const readOutput: TerminalCommandManagerShape["readOutput"] = Effect.fn(
    "TerminalCommandManager.readOutput",
  )(function* (input) {
    const state = executions.get(input.executionId);
    const persisted = state ? null : yield* findPersisted(input.threadId, input.executionId);
    if (!state && !persisted?.terminalCommand) {
      return yield* new TerminalExecNotFoundError({
        threadId: input.threadId,
        executionId: input.executionId,
      });
    }
    const record = state?.record ?? persisted!.terminalCommand!;
    const output = state
      ? retainedOutput(state)
      : yield* fileSystem
          .readFileString(executionLogPath(input.threadId, input.executionId))
          .pipe(Effect.orElseSucceed(() => record.excerpt));
    const data = output.slice(input.offset, input.offset + TERMINAL_EXEC_MAX_READ_CHARS);
    const nextOffset = input.offset + data.length;
    return {
      data,
      offset: input.offset,
      nextOffset,
      totalBytes: record.logBytes,
      eof: nextOffset >= output.length,
      truncated: record.truncated,
    };
  });

  const cleanupThread: TerminalCommandManagerShape["cleanupThread"] = Effect.fn(
    "TerminalCommandManager.cleanupThread",
  )(function* (threadId) {
    const matching = [...executions.values()].filter((state) => state.input.threadId === threadId);
    yield* Effect.forEach(
      matching,
      (state) => cancel({ threadId, executionId: state.input.executionId }).pipe(Effect.ignore),
      { discard: true },
    );
    for (const state of matching) executions.delete(state.input.executionId);
    yield* fileSystem
      .remove(threadLogDir(threadId), { recursive: true, force: true })
      .pipe(Effect.ignore);
  });

  // A process cannot be trusted across a server restart. Durable active rows
  // are finalized as interrupted; stored PIDs are intentionally never used.
  const activeTerminalCommands = yield* projectionThreadMessages
    .listActiveTerminalCommands()
    .pipe(Effect.orElseSucceed(() => []));
  for (const message of activeTerminalCommands) {
    const record = message.terminalCommand;
    if (!record || !terminalCommandIsActive(record)) continue;
    const createdAt = yield* nowIso;
    const partialOutput = yield* fileSystem
      .readFileString(executionLogPath(message.threadId, record.executionId))
      .pipe(Effect.orElseSucceed(() => record.excerpt));
    const partialExcerpt = timelineExcerpt(partialOutput);
    yield* orchestration
      .dispatch({
        type: "thread.terminal-command.upsert",
        commandId: yield* commandId("startup-interrupted"),
        threadId: message.threadId,
        messageId: message.messageId,
        terminalCommand: {
          ...record,
          status: "interrupted",
          excerpt: partialExcerpt.excerpt,
          truncated: record.truncated || partialExcerpt.truncated,
          logBytes: Math.max(record.logBytes, Buffer.byteLength(partialOutput)),
          completedAt: createdAt,
        },
        createdAt,
      })
      .pipe(Effect.ignore);
  }

  yield* Effect.addFinalizer(() =>
    Effect.all([
      Effect.forEach([...executions.values()], (state) => state.handle?.kill ?? Effect.void, {
        discard: true,
      }),
      Scope.close(workerScope, Exit.void),
    ]).pipe(Effect.asVoid),
  );

  yield* orchestration.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      event.type === "thread.deleted" ? cleanupThread(event.payload.threadId) : Effect.void,
    ),
    Effect.forkIn(workerScope),
  );

  return TerminalCommandManager.of({ start, attachStream, cancel, readOutput, cleanupThread });
});

export const layer = Layer.effect(TerminalCommandManager, make);
