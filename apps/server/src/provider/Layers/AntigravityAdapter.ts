import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
  type AntigravitySettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { collectStreamAsString } from "../providerSnapshot.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const DEFAULT_HARD_TIMEOUT_MS = 6 * 60 * 1_000;
const MAX_PROMPT_CHARS = 24_000;
const MAX_STDERR_BYTES = 64 * 1_024;

const AgyUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  thinking_tokens: Schema.optional(Schema.Number),
  cache_read_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
});

const AgyToolInfo = Schema.Struct({
  name: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});

const AgyStreamRecord = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      event: Schema.Literal("init"),
      init: Schema.Unknown,
    }),
    Schema.Struct({
      event: Schema.Literal("step_update"),
      step_update: Schema.Struct({
        step_index: Schema.optional(Schema.Number),
        state: Schema.optional(Schema.String),
        step_type: Schema.optional(Schema.String),
        tool_name: Schema.optional(Schema.String),
        tool_info: Schema.optional(AgyToolInfo),
        text_delta: Schema.optional(Schema.String),
        usage: Schema.optional(AgyUsage),
      }),
    }),
    Schema.Struct({
      event: Schema.Literal("result"),
      result: Schema.Struct({
        conversation_id: Schema.optional(Schema.String),
        status: Schema.String,
        response: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
        duration_seconds: Schema.optional(Schema.Number),
        usage: Schema.optional(AgyUsage),
      }),
    }),
  ]),
);
type AgyStreamRecord = typeof AgyStreamRecord.Type;
type AgyResult = Extract<AgyStreamRecord, { readonly event: "result" }>["result"];
const decodeAgyStreamRecord = Schema.decodeUnknownOption(AgyStreamRecord);

interface ActiveAntigravityProcess {
  readonly turnId: TurnId;
  readonly itemId: RuntimeItemId;
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  cancelled: boolean;
}

interface AntigravitySessionContext {
  session: ProviderSession;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  active: ActiveAntigravityProcess | undefined;
  stopped: boolean;
}

export interface AntigravityAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly hardTimeoutMs?: number;
}

const positiveInteger = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const stderrTail = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length <= 4_000 ? trimmed : trimmed.slice(-4_000);
};

export const isAntigravityPermissionDenial = (stderr: string): boolean => {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("permission_denied") ||
    normalized.includes("permission denied") ||
    normalized.includes("auto-denied") ||
    normalized.includes("user denied permission") ||
    normalized.includes("requires approval") ||
    normalized.includes("soft-denied") ||
    normalized.includes("not allowed") ||
    (normalized.includes("required") &&
      normalized.includes("permission") &&
      normalized.includes("cannot prompt"))
  );
};

const toolItemType = (toolName: string) => {
  if (toolName === "run_command") return "command_execution" as const;
  if (/(?:write|replace|edit|delete|move)_file/iu.test(toolName)) return "file_change" as const;
  if (/(?:search|fetch|read)_url|web/iu.test(toolName)) return "web_search" as const;
  return "dynamic_tool_call" as const;
};

export function buildAntigravityArgs(input: {
  readonly prompt: string;
  readonly model?: string;
  readonly dangerouslySkipPermissions: boolean;
}): ReadonlyArray<string> {
  return [
    ...(input.model ? ["--model", input.model] : []),
    "--output-format",
    "stream-json",
    "--print-timeout",
    "5m",
    ...(input.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
    "-p",
    input.prompt,
  ];
}

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options: AntigravityAdapterOptions = {},
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const instanceId = options.instanceId ?? ProviderInstanceId.make("antigravity");
    const environment = options.environment ?? process.env;
    const hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(runtimeEvents));

    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate an Antigravity runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = () =>
      Effect.all({
        eventId: Effect.map(randomId, EventId.make),
        createdAt: Effect.map(DateTime.now, DateTime.formatIso),
      });
    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravitySessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const emitRuntimeError = Effect.fn("AntigravityAdapter.emitRuntimeError")(function* (
      threadId: ThreadId,
      turnId: TurnId,
      message: string,
    ) {
      yield* emit({
        type: "runtime.error",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId,
        turnId,
        payload: { message, class: "provider_error" },
      });
    });

    const emitUsage = Effect.fn("AntigravityAdapter.emitUsage")(function* (
      threadId: ThreadId,
      turnId: TurnId,
      result: AgyResult,
    ) {
      const usage = result.usage;
      const total = positiveInteger(usage?.total_tokens);
      if (total === undefined) return;
      const inputTokens = positiveInteger(usage?.input_tokens);
      const outputTokens = positiveInteger(usage?.output_tokens);
      const reasoningOutputTokens = positiveInteger(usage?.thinking_tokens);
      const cachedInputTokens = positiveInteger(usage?.cache_read_tokens);
      const durationMs =
        result.duration_seconds === undefined
          ? undefined
          : positiveInteger(result.duration_seconds * 1_000);
      yield* emit({
        type: "thread.token-usage.updated",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId,
        turnId,
        payload: {
          usage: {
            usedTokens: total,
            totalProcessedTokens: total,
            ...(inputTokens === undefined ? {} : { inputTokens, lastInputTokens: inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens, lastOutputTokens: outputTokens }),
            ...(reasoningOutputTokens === undefined
              ? {}
              : { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }),
            ...(cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }),
            ...(durationMs === undefined ? {} : { durationMs }),
            lastUsedTokens: total,
          },
        },
      });
    });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        if (input.resumeCursor !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Antigravity delegated sessions cannot be resumed.",
          });
        }
        if (sessions.has(input.threadId)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Thread '${input.threadId}' already has an Antigravity session.`,
          });
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd.trim(),
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(input.threadId, {
          session,
          turns: [],
          active: undefined,
          stopped: false,
        });
        yield* emit({
          type: "session.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          payload: {},
        });
        yield* emit({
          type: "thread.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          payload: {},
        });
        return session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.active) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Antigravity delegated sessions accept one turn at a time.",
          });
        }
        if (input.attachments && input.attachments.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Antigravity delegated runs do not support attachments.",
          });
        }
        const prompt = input.input?.trim();
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A non-empty prompt is required.",
          });
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `The Antigravity prompt exceeds the ${MAX_PROMPT_CHARS}-character command-line limit.`,
          });
        }

        const turnId = TurnId.make(yield* randomId);
        const itemId = RuntimeItemId.make(yield* randomId);
        const model = input.modelSelection?.model ?? context.session.model;
        const args = buildAntigravityArgs({
          prompt,
          ...(model ? { model } : {}),
          dangerouslySkipPermissions: settings.dangerouslySkipPermissions,
        });
        const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, args, {
          env: environment,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "agy/spawn",
                detail: "Failed to resolve the Antigravity CLI command.",
                cause,
              }),
          ),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd: context.session.cwd,
              env: environment,
              shell: spawnCommand.shell,
              stdin: "ignore",
              killSignal: "SIGTERM",
              forceKillAfter: "3 seconds",
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "agy/spawn",
                  detail: "Failed to start the Antigravity CLI.",
                  cause,
                }),
            ),
          );
        context.active = { turnId, itemId, handle: child, cancelled: false };
        if (context.stopped) {
          yield* child
            .kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" })
            .pipe(Effect.ignore);
        }
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
          ...(model ? { model } : {}),
        };
        yield* emit({
          type: "turn.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          turnId,
          payload: model ? { model } : {},
        });
        yield* emit({
          type: "item.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });

        let result: AgyResult | undefined;
        let streamedText = "";
        let malformedLines = 0;
        const toolItems = new Map<
          number,
          {
            readonly itemId: RuntimeItemId;
            readonly name: string;
            readonly itemType: ReturnType<typeof toolItemType>;
            readonly data: typeof AgyToolInfo.Type | undefined;
          }
        >();
        const consumeStdout = child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              if (!line.trim()) return;
              const decoded = decodeAgyStreamRecord(line);
              if (Option.isNone(decoded)) {
                malformedLines += 1;
                return;
              }
              if (decoded.value.event === "result") {
                result = decoded.value.result;
                return;
              }
              if (
                decoded.value.event === "step_update" &&
                decoded.value.step_update.step_type === "tool"
              ) {
                const step = decoded.value.step_update;
                const stepIndex = step.step_index;
                if (stepIndex === undefined || !Number.isInteger(stepIndex) || stepIndex < 0) {
                  malformedLines += 1;
                  return;
                }
                const toolName = step.tool_name?.trim() || step.tool_info?.name?.trim() || "tool";
                let toolItem = toolItems.get(stepIndex);
                if (!toolItem) {
                  toolItem = {
                    itemId: RuntimeItemId.make(yield* randomId),
                    name: toolName,
                    itemType: toolItemType(toolName),
                    data: step.tool_info,
                  };
                  toolItems.set(stepIndex, toolItem);
                  yield* emit({
                    type: "item.started",
                    ...(yield* stamp()),
                    provider: PROVIDER,
                    providerInstanceId: instanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId: toolItem.itemId,
                    payload: {
                      itemType: toolItem.itemType,
                      status: "inProgress",
                      title: toolName,
                      ...(step.tool_info ? { data: step.tool_info } : {}),
                    },
                  });
                }
                if (step.state === "DONE" || step.state === "ERROR") {
                  yield* emit({
                    type: "item.completed",
                    ...(yield* stamp()),
                    provider: PROVIDER,
                    providerInstanceId: instanceId,
                    threadId: input.threadId,
                    turnId,
                    itemId: toolItem.itemId,
                    payload: {
                      itemType: toolItemType(toolName),
                      status:
                        step.state === "ERROR" || step.tool_info?.error !== undefined
                          ? "failed"
                          : "completed",
                      title: toolName,
                      ...(step.tool_info ? { data: step.tool_info } : {}),
                    },
                  });
                  toolItems.delete(stepIndex);
                }
                return;
              }
              if (
                decoded.value.event === "step_update" &&
                decoded.value.step_update.step_type === "agent_response" &&
                decoded.value.step_update.text_delta
              ) {
                const delta = decoded.value.step_update.text_delta;
                streamedText += delta;
                yield* emit({
                  type: "content.delta",
                  ...(yield* stamp()),
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: input.threadId,
                  turnId,
                  itemId,
                  payload: { streamKind: "assistant_text", delta },
                });
              }
            }),
          ),
        );
        const completion = Effect.all(
          {
            stdout: consumeStdout,
            stderr: collectStreamAsString(child.stderr, { maxBytes: MAX_STDERR_BYTES }),
            exitCode: child.exitCode.pipe(
              Effect.map(Number),
              Effect.orElseSucceed(() => -1),
            ),
          },
          { concurrency: "unbounded" },
        );
        const completed = yield* completion.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "agy/stream",
                detail: "Failed while reading Antigravity CLI output.",
                cause,
              }),
          ),
          Effect.timeoutOption(hardTimeoutMs),
        );
        if (Option.isNone(completed)) {
          yield* child
            .kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" })
            .pipe(Effect.ignore);
        }
        const wasCancelled = context.active?.cancelled === true || context.stopped;
        context.active = undefined;
        const settledAt = DateTime.formatIso(yield* DateTime.now);
        const { activeTurnId: _activeTurnId, ...sessionWithoutTurn } = context.session;
        context.session = {
          ...sessionWithoutTurn,
          status: context.stopped ? "closed" : "ready",
          updatedAt: settledAt,
        };

        const terminalResult = result;
        const finalText = terminalResult?.response?.trim() || streamedText.trim();
        if (terminalResult && !streamedText && finalText) {
          yield* emit({
            type: "content.delta",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            itemId,
            payload: { streamKind: "assistant_text", delta: terminalResult.response ?? finalText },
          });
        }
        if (malformedLines > 0) {
          yield* emit({
            type: "runtime.warning",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            payload: {
              message: `Antigravity emitted ${malformedLines} unrecognized stream record${malformedLines === 1 ? "" : "s"}.`,
            },
          });
        }

        const exitCode = Option.isSome(completed) ? completed.value.exitCode : -1;
        const permissionDenial =
          Option.isSome(completed) && isAntigravityPermissionDenial(completed.value.stderr);
        const providerCancelled = terminalResult?.status === "CANCELED";
        const providerInterrupted = terminalResult?.status === "INTERRUPTED";
        const errorMessage = wasCancelled
          ? undefined
          : Option.isNone(completed)
            ? "Antigravity exceeded the hard timeout."
            : providerCancelled || providerInterrupted
              ? undefined
              : terminalResult === undefined
                ? exitCode === 0
                  ? "Antigravity returned no response. Check agy authentication, permissions, and quota."
                  : stderrTail(completed.value.stderr) ||
                    `Antigravity exited with code ${exitCode}.`
                : terminalResult.status !== "SUCCESS"
                  ? terminalResult?.error?.trim() ||
                    stderrTail(completed.value.stderr) ||
                    `Antigravity ended with status ${terminalResult.status}.`
                  : permissionDenial
                    ? stderrTail(completed.value.stderr)
                    : exitCode !== 0
                      ? stderrTail(completed.value.stderr) ||
                        `Antigravity exited with code ${exitCode}.`
                      : !finalText
                        ? "Antigravity returned no response. Check agy authentication, permissions, and quota."
                        : undefined;
        const turnState =
          wasCancelled || providerCancelled
            ? "cancelled"
            : errorMessage
              ? "failed"
              : providerInterrupted
                ? "interrupted"
                : "completed";

        for (const toolItem of toolItems.values()) {
          yield* emit({
            type: "item.completed",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            itemId: toolItem.itemId,
            payload: {
              itemType: toolItem.itemType,
              status:
                wasCancelled || providerCancelled
                  ? "declined"
                  : errorMessage
                    ? "failed"
                    : "completed",
              title: toolItem.name,
              ...(toolItem.data ? { data: toolItem.data } : {}),
            },
          });
        }

        if (finalText) {
          yield* emit({
            type: "item.completed",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            itemId,
            payload: {
              itemType: "assistant_message",
              status: errorMessage ? "failed" : "completed",
              detail: finalText,
            },
          });
          context.turns.push({
            id: turnId,
            items: [{ type: "assistant_message", text: finalText }],
          });
        } else {
          yield* emit({
            type: "item.completed",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            itemId,
            payload: {
              itemType: "assistant_message",
              status: errorMessage ? "failed" : "completed",
            },
          });
          context.turns.push({ id: turnId, items: [] });
        }
        if (terminalResult) yield* emitUsage(input.threadId, turnId, terminalResult);
        if (errorMessage) yield* emitRuntimeError(input.threadId, turnId, errorMessage);
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          turnId,
          payload: {
            state: turnState,
            stopReason: wasCancelled || providerCancelled ? "cancelled" : null,
            ...(terminalResult?.usage ? { usage: terminalResult.usage } : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
        });
        return { threadId: input.threadId, turnId };
      }).pipe(Effect.scoped);

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!context.active || (turnId !== undefined && context.active.turnId !== turnId)) return;
        context.active.cancelled = true;
        yield* context.active.handle
          .kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" })
          .pipe(Effect.ignore);
      });

    const stopSessionInternal = Effect.fn("AntigravityAdapter.stopSessionInternal")(function* (
      context: AntigravitySessionContext,
    ) {
      if (context.stopped) return;
      context.stopped = true;
      if (context.active) {
        context.active.cancelled = true;
        yield* context.active.handle
          .kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" })
          .pipe(Effect.ignore);
      }
      sessions.delete(context.session.threadId);
      yield* emit({
        type: "session.exited",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: context.session.threadId,
        payload: { exitKind: "graceful" },
      });
    });

    const unsupported = (threadId: ThreadId, method: string) =>
      requireSession(threadId).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "Antigravity delegated sessions do not support this operation.",
            }),
          ),
        ),
      );

    const stopAll = () =>
      Effect.forEach([...sessions.values()], stopSessionInternal, { discard: true });
    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignoreCause({ log: true })));

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId) => unsupported(threadId, "respondToRequest"),
      respondToUserInput: (threadId) => unsupported(threadId, "respondToUserInput"),
      stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal)),
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => ({ ...context.session }))),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        requireSession(threadId).pipe(
          Effect.map((context) => ({ threadId, turns: [...context.turns] })),
        ),
      rollbackThread: (threadId) => unsupported(threadId, "rollbackThread"),
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
