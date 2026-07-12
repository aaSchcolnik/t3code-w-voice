/**
 * SubagentTranscriptService — complete, append-only child-run transcripts.
 *
 * Two kinds of children feed the same transcript model:
 *
 *   1. **Delegated runs** — cross-provider sessions started through the
 *      built-in MCP. Their provider sessions run on synthetic
 *      `delegated-<runId>` thread ids, so every canonical runtime event on
 *      such a thread belongs to exactly one transcript.
 *   2. **Native subagents** — provider-run children (e.g. Claude's Agent
 *      tool). Adapters tag child-scoped canonical events with
 *      `payload.data.parentToolUseId`; those events are diverted here (and
 *      kept out of the parent timeline by `ProviderRuntimeIngestion`).
 *
 * Transcripts reuse `OrchestrationMessage` / `OrchestrationThreadActivity`
 * so the client renders them with the established timeline components.
 * Finalized messages and activities are persisted as NDJSON lines as they
 * arrive, so partial transcripts survive cancellation and process restarts.
 *
 * @module orchestration/SubagentTranscriptService
 */
import {
  EventId,
  MessageId,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProviderOptionSelections,
  SubagentTranscriptError,
  ThreadId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type SubagentTranscript,
  type SubagentTranscriptStreamEvent,
  type SubagentTranscriptSubscribeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ServerConfig } from "../config.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const DELEGATED_THREAD_PREFIX = "delegated-";
const MAX_TRANSCRIPT_ACTIVITIES = 2_000;

// Persisted NDJSON line: meta first, then message/activity upserts in
// sequence order. Messages are persisted when they finalize (streaming
// deltas stay in memory until then).
const TranscriptMeta = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["native", "delegated"]),
  parentThreadId: Schema.String,
  providerInstanceId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  requestedOptions: Schema.optional(ProviderOptionSelections),
  resolvedOptions: Schema.optional(ProviderOptionSelections),
});
type TranscriptMeta = typeof TranscriptMeta.Type;

const TranscriptLine = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("meta"), meta: TranscriptMeta }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    sequence: Schema.Number,
    message: OrchestrationMessage,
  }),
  Schema.Struct({
    kind: Schema.Literal("activity"),
    sequence: Schema.Number,
    activity: OrchestrationThreadActivity,
  }),
]);
type TranscriptLine = typeof TranscriptLine.Type;
const TranscriptLineJson = Schema.fromJsonString(TranscriptLine);
const decodeTranscriptLine = Schema.decodeUnknownEffect(TranscriptLineJson);
const encodeTranscriptLine = Schema.encodeEffect(TranscriptLineJson);

export interface RegisterTranscriptInput {
  readonly id: string;
  readonly source: "native" | "delegated";
  readonly parentThreadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly model?: string;
  readonly requestedOptions?: ProviderOptionSelections;
  readonly resolvedOptions?: ProviderOptionSelections;
  /** Initial user message (the delegated task) when known. */
  readonly task?: string;
  readonly createdAt: string;
}

export interface SubagentTranscriptServiceShape {
  readonly register: (input: RegisterTranscriptInput) => Effect.Effect<void>;
  readonly get: (
    input: SubagentTranscriptSubscribeInput,
  ) => Effect.Effect<SubagentTranscript, SubagentTranscriptError>;
  readonly subscribe: (
    input: SubagentTranscriptSubscribeInput,
  ) => Effect.Effect<Stream.Stream<SubagentTranscriptStreamEvent>, SubagentTranscriptError>;
  readonly appendStatusActivity: (input: {
    readonly transcriptId: string;
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly tone?: "info" | "error";
  }) => Effect.Effect<void>;
}

export class SubagentTranscriptService extends Context.Service<
  SubagentTranscriptService,
  SubagentTranscriptServiceShape
>()("t3/orchestration/SubagentTranscriptService") {}

/**
 * Child correlation marker on canonical item events. Adapters set
 * `payload.data.parentToolUseId` on child-scoped events; ingestion uses this
 * to keep them out of the parent timeline, and this service uses it to route
 * them into the child transcript.
 */
export const childScopedParentToolUseId = (event: ProviderRuntimeEvent): string | undefined => {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return undefined;
  }
  const data = event.payload.data;
  if (!data || typeof data !== "object" || globalThis.Array.isArray(data)) return undefined;
  const id = (data as { readonly parentToolUseId?: unknown }).parentToolUseId;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
};

interface TranscriptState {
  readonly meta: TranscriptMeta;
  messages: OrchestrationMessage[];
  activities: OrchestrationThreadActivity[];
  latestSequence: number;
  /** Message id of the currently streaming assistant message, if any. */
  streamingMessageId: string | null;
}

const toSnapshot = (state: TranscriptState): SubagentTranscript => ({
  id: state.meta.id,
  source: state.meta.source,
  parentThreadId: ThreadId.make(state.meta.parentThreadId),
  ...(state.meta.providerInstanceId
    ? { providerInstanceId: state.meta.providerInstanceId as ProviderInstanceId }
    : {}),
  ...(state.meta.model ? { model: state.meta.model } : {}),
  ...(state.meta.requestedOptions ? { requestedOptions: state.meta.requestedOptions } : {}),
  ...(state.meta.resolvedOptions ? { resolvedOptions: state.meta.resolvedOptions } : {}),
  messages: [...state.messages],
  activities: [...state.activities],
  latestSequence: state.latestSequence,
});

const sanitizeFileName = (value: string): string => value.replace(/[^A-Za-z0-9._-]/gu, "_");

const isToolItemType = (itemType: string): boolean =>
  itemType === "command_execution" ||
  itemType === "file_change" ||
  itemType === "mcp_tool_call" ||
  itemType === "dynamic_tool_call" ||
  itemType === "collab_agent_tool_call" ||
  itemType === "web_search" ||
  itemType === "image_view";

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transcriptsDir = path.join(serverConfig.stateDir, "subagent-transcripts");
  const stateRef = yield* SynchronizedRef.make(new Map<string, TranscriptState>());
  const updates = yield* PubSub.unbounded<{
    readonly transcriptId: string;
    readonly event: SubagentTranscriptStreamEvent;
  }>();
  const writeLock = yield* Semaphore.make(1);

  yield* fs
    .makeDirectory(transcriptsDir, { recursive: true })
    .pipe(Effect.catchCause(() => Effect.void));

  const transcriptFilePath = (transcriptId: string) =>
    path.join(transcriptsDir, `${sanitizeFileName(transcriptId)}.ndjson`);

  const appendLine = (transcriptId: string, line: TranscriptLine) =>
    writeLock.withPermits(1)(
      encodeTranscriptLine(line).pipe(
        Effect.flatMap((encoded) =>
          fs.writeFileString(transcriptFilePath(transcriptId), `${encoded}\n`, {
            flag: "a",
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist subagent transcript line", {
            transcriptId,
            cause: String(cause),
          }),
        ),
      ),
    );

  const loadFromDisk = (transcriptId: string): Effect.Effect<TranscriptState | undefined> =>
    Effect.gen(function* () {
      const raw = yield* fs
        .readFileString(transcriptFilePath(transcriptId))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (raw === undefined) return undefined;
      let meta: TranscriptMeta | undefined;
      const messagesById = new Map<string, OrchestrationMessage>();
      const messageOrder: string[] = [];
      const activities: OrchestrationThreadActivity[] = [];
      let latestSequence = 0;
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const decoded = yield* decodeTranscriptLine(line).pipe(Effect.option);
        if (decoded._tag === "None") continue;
        const record = decoded.value;
        if (record.kind !== "meta" && record.sequence > latestSequence) {
          latestSequence = record.sequence;
        }
        if (record.kind === "meta") {
          meta = record.meta;
        } else if (record.kind === "message") {
          if (!messagesById.has(record.message.id)) messageOrder.push(record.message.id);
          messagesById.set(record.message.id, record.message);
        } else {
          activities.push(record.activity);
        }
      }
      if (!meta) return undefined;
      return {
        meta,
        messages: messageOrder
          .map((id) => messagesById.get(id))
          .filter((message): message is OrchestrationMessage => message !== undefined),
        activities,
        latestSequence,
        streamingMessageId: null,
      } satisfies TranscriptState;
    });

  const ensureLoaded = (transcriptId: string): Effect.Effect<TranscriptState | undefined> =>
    SynchronizedRef.modifyEffect(stateRef, (states) =>
      Effect.gen(function* () {
        const existing = states.get(transcriptId);
        if (existing) return [existing, states] as const;
        const loaded = yield* loadFromDisk(transcriptId);
        if (!loaded) return [undefined, states] as const;
        const next = new Map(states);
        next.set(transcriptId, loaded);
        return [loaded, next] as const;
      }),
    );

  const mutate = (
    transcriptId: string,
    update: (state: TranscriptState) => {
      readonly state: TranscriptState;
      readonly events: ReadonlyArray<SubagentTranscriptStreamEvent>;
      readonly persist: ReadonlyArray<TranscriptLine>;
    },
  ): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(stateRef, (states) =>
      Effect.gen(function* () {
        const current = states.get(transcriptId) ?? (yield* loadFromDisk(transcriptId));
        if (!current) return [undefined, states] as const;
        const result = update(current);
        const next = new Map(states);
        next.set(transcriptId, result.state);
        return [result, next] as const;
      }),
    ).pipe(
      Effect.flatMap((result) => {
        if (!result) return Effect.void;
        return Effect.forEach(result.persist, (line) => appendLine(transcriptId, line), {
          discard: true,
        }).pipe(
          Effect.andThen(
            Effect.forEach(
              result.events,
              (event) => PubSub.publish(updates, { transcriptId, event }),
              { discard: true },
            ),
          ),
        );
      }),
    );

  const createTranscript = (input: RegisterTranscriptInput): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(stateRef, (states) =>
      Effect.gen(function* () {
        if (states.get(input.id)) return [undefined, states] as const;
        const loaded = yield* loadFromDisk(input.id);
        if (loaded) {
          const next = new Map(states);
          next.set(input.id, loaded);
          return [undefined, next] as const;
        }
        const meta: TranscriptMeta = {
          id: input.id,
          source: input.source,
          parentThreadId: input.parentThreadId,
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.requestedOptions ? { requestedOptions: input.requestedOptions } : {}),
          ...(input.resolvedOptions ? { resolvedOptions: input.resolvedOptions } : {}),
        };
        const messages: OrchestrationMessage[] = [];
        const persist: TranscriptLine[] = [{ kind: "meta", meta }];
        let latestSequence = 0;
        if (input.task) {
          latestSequence += 1;
          const taskMessage: OrchestrationMessage = {
            id: MessageId.make(`subagent:${input.id}:task`),
            role: "user",
            text: input.task,
            turnId: null,
            streaming: false,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          };
          messages.push(taskMessage);
          persist.push({ kind: "message", sequence: latestSequence, message: taskMessage });
        }
        const created: TranscriptState = {
          meta,
          messages,
          activities: [],
          latestSequence,
          streamingMessageId: null,
        };
        const next = new Map(states);
        next.set(input.id, created);
        return [persist, next] as const;
      }),
    ).pipe(
      Effect.flatMap((persist) =>
        persist
          ? Effect.forEach(persist, (line) => appendLine(input.id, line), { discard: true })
          : Effect.void,
      ),
    );

  const appendActivityUpdate = (
    transcriptId: string,
    activity: OrchestrationThreadActivity,
  ): Effect.Effect<void> =>
    mutate(transcriptId, (state) => {
      const sequence = state.latestSequence + 1;
      const stamped = { ...activity, sequence };
      const activities = [...state.activities, stamped];
      const trimmed =
        activities.length > MAX_TRANSCRIPT_ACTIVITIES
          ? activities.slice(activities.length - MAX_TRANSCRIPT_ACTIVITIES)
          : activities;
      return {
        state: { ...state, activities: trimmed, latestSequence: sequence },
        events: [{ type: "activity.upserted", sequence, activity: stamped }],
        persist: [{ kind: "activity", sequence, activity: stamped }],
      };
    });

  const upsertMessage = (
    transcriptId: string,
    message: OrchestrationMessage,
    options: { readonly persist: boolean },
  ): Effect.Effect<void> =>
    mutate(transcriptId, (state) => {
      const sequence = state.latestSequence + 1;
      const index = state.messages.findIndex((existing) => existing.id === message.id);
      const messages =
        index >= 0
          ? state.messages.map((existing, position) => (position === index ? message : existing))
          : [...state.messages, message];
      return {
        state: {
          ...state,
          messages,
          latestSequence: sequence,
          streamingMessageId: message.streaming ? message.id : null,
        },
        events: [{ type: "message.upserted", sequence, message }],
        persist: options.persist ? [{ kind: "message", sequence, message }] : [],
      };
    });

  const streamingAssistantMessageId = (transcriptId: string, event: ProviderRuntimeEvent) =>
    MessageId.make(
      `subagent:${transcriptId}:assistant:${event.itemId ?? event.turnId ?? "stream"}`,
    );

  const handleTranscriptEvent = (
    transcriptId: string,
    source: "native" | "delegated",
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (source === "delegated") {
        if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
          const messageId = streamingAssistantMessageId(transcriptId, event);
          const states = yield* SynchronizedRef.get(stateRef);
          const state = states.get(transcriptId);
          const existing = state?.messages.find((message) => message.id === messageId);
          yield* upsertMessage(
            transcriptId,
            {
              id: messageId,
              role: "assistant",
              text: `${existing?.text ?? ""}${event.payload.delta}`,
              turnId: event.turnId ? TurnId.make(event.turnId) : null,
              streaming: true,
              createdAt: existing?.createdAt ?? event.createdAt,
              updatedAt: event.createdAt,
            },
            { persist: false },
          );
          return;
        }
        if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
          const messageId = streamingAssistantMessageId(transcriptId, event);
          const states = yield* SynchronizedRef.get(stateRef);
          const state = states.get(transcriptId);
          const existing = state?.messages.find((message) => message.id === messageId);
          const text = event.payload.detail ?? existing?.text ?? "";
          if (text.length === 0) return;
          yield* upsertMessage(
            transcriptId,
            {
              id: messageId,
              role: "assistant",
              text,
              turnId: event.turnId ? TurnId.make(event.turnId) : null,
              streaming: false,
              createdAt: existing?.createdAt ?? event.createdAt,
              updatedAt: event.createdAt,
            },
            { persist: true },
          );
          return;
        }
        if (event.type === "item.completed" && event.payload.itemType === "reasoning") {
          if (!event.payload.detail) return;
          yield* appendActivityUpdate(transcriptId, {
            id: EventId.make(`subagent:${transcriptId}:${event.eventId}`),
            createdAt: event.createdAt,
            tone: "info",
            kind: "reasoning.completed",
            summary: "Reasoning",
            payload: { detail: event.payload.detail },
            turnId: event.turnId ? TurnId.make(event.turnId) : null,
          });
          return;
        }
        if (event.type === "request.opened" || event.type === "user-input.requested") {
          yield* appendActivityUpdate(transcriptId, {
            id: EventId.make(`subagent:${transcriptId}:${event.eventId}`),
            createdAt: event.createdAt,
            tone: "approval",
            kind: "user-input.requested",
            summary: "Waiting for structured input",
            payload: event.payload,
            turnId: event.turnId ? TurnId.make(event.turnId) : null,
          });
          return;
        }
        if (event.type === "runtime.error") {
          yield* appendActivityUpdate(transcriptId, {
            id: EventId.make(`subagent:${transcriptId}:${event.eventId}`),
            createdAt: event.createdAt,
            tone: "error",
            kind: "runtime.error",
            summary: event.payload.message,
            payload: event.payload,
            turnId: event.turnId ? TurnId.make(event.turnId) : null,
          });
          return;
        }
        if (event.type === "turn.completed") {
          yield* finalizeStreamingMessage(transcriptId, event.createdAt);
          yield* appendActivityUpdate(transcriptId, {
            id: EventId.make(`subagent:${transcriptId}:${event.eventId}`),
            createdAt: event.createdAt,
            tone: event.payload.state === "completed" ? "info" : "error",
            kind: "turn.completed",
            summary:
              event.payload.state === "completed"
                ? "Turn completed"
                : `Turn ${event.payload.state}`,
            payload: event.payload,
            turnId: event.turnId ? TurnId.make(event.turnId) : null,
          });
          return;
        }
      }

      // Tool lifecycle events are shared between native and delegated
      // children — both arrive as canonical item.* events.
      if (
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        isToolItemType(event.payload.itemType)
      ) {
        const kind =
          event.type === "item.started"
            ? "tool.started"
            : event.type === "item.updated"
              ? "tool.updated"
              : "tool.completed";
        yield* appendActivityUpdate(transcriptId, {
          id: EventId.make(`subagent:${transcriptId}:${event.eventId}`),
          createdAt: event.createdAt,
          tone: "tool",
          kind,
          summary: event.payload.title ?? event.payload.detail ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
            ...(event.payload.data !== undefined
              ? { data: { toolCallId: event.itemId, ...(event.payload.data as object) } }
              : event.itemId
                ? { data: { toolCallId: event.itemId } }
                : {}),
          },
          turnId: event.turnId ? TurnId.make(event.turnId) : null,
        });
        return;
      }

      // Native child assistant messages arrive as completed items tagged with
      // the parent tool-use id.
      if (
        source === "native" &&
        event.type === "item.completed" &&
        event.payload.itemType === "assistant_message" &&
        event.payload.detail
      ) {
        yield* upsertMessage(
          transcriptId,
          {
            id: MessageId.make(`subagent:${transcriptId}:${event.itemId ?? event.eventId}`),
            role: "assistant",
            text: event.payload.detail,
            turnId: event.turnId ? TurnId.make(event.turnId) : null,
            streaming: false,
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
          },
          { persist: true },
        );
      }
    });

  const finalizeStreamingMessage = (
    transcriptId: string,
    completedAt: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const states = yield* SynchronizedRef.get(stateRef);
      const state = states.get(transcriptId);
      const streamingId = state?.streamingMessageId;
      if (!state || !streamingId) return;
      const message = state.messages.find((existing) => existing.id === streamingId);
      if (!message || !message.streaming) return;
      yield* upsertMessage(
        transcriptId,
        { ...message, streaming: false, updatedAt: completedAt },
        { persist: true },
      );
    });

  const ingest = Effect.fn("SubagentTranscriptService.ingest")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (String(event.threadId).startsWith(DELEGATED_THREAD_PREFIX)) {
      const transcriptId = String(event.threadId).slice(DELEGATED_THREAD_PREFIX.length);
      yield* handleTranscriptEvent(transcriptId, "delegated", event);
      return;
    }
    const parentToolUseId = childScopedParentToolUseId(event);
    if (parentToolUseId !== undefined) {
      yield* createTranscript({
        id: parentToolUseId,
        source: "native",
        parentThreadId: event.threadId,
        ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
        createdAt: event.createdAt,
      });
      yield* handleTranscriptEvent(parentToolUseId, "native", event);
    }
  });

  yield* providerService.streamEvents.pipe(
    Stream.runForEach((event) =>
      ingest(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("subagent transcript ingest failed", {
            eventId: event.eventId,
            eventType: event.type,
            cause: String(cause),
          }),
        ),
      ),
    ),
    Effect.forkDetach,
  );

  const requireOwnedTranscript = Effect.fn("SubagentTranscriptService.requireOwnedTranscript")(
    function* (input: SubagentTranscriptSubscribeInput) {
      const state = yield* ensureLoaded(input.transcriptId);
      if (!state) {
        return yield* new SubagentTranscriptError({
          reason: "not_found",
          message: "No transcript exists for this subagent.",
        });
      }
      if (state.meta.parentThreadId !== input.parentThreadId) {
        return yield* new SubagentTranscriptError({
          reason: "forbidden",
          message: "The transcript does not belong to this thread.",
        });
      }
      return state;
    },
  );

  return SubagentTranscriptService.of({
    register: (input) => createTranscript(input),
    get: Effect.fn("SubagentTranscriptService.get")(function* (input) {
      const state = yield* requireOwnedTranscript(input);
      return toSnapshot(state);
    }),
    subscribe: Effect.fn("SubagentTranscriptService.subscribe")(function* (input) {
      const state = yield* requireOwnedTranscript(input);
      const snapshot = toSnapshot(state);
      const live = Stream.fromPubSub(updates).pipe(
        Stream.filter((update) => update.transcriptId === input.transcriptId),
        Stream.map((update) => update.event),
        Stream.filter(
          (event) => event.type === "snapshot" || event.sequence > snapshot.latestSequence,
        ),
      );
      return Stream.concat(Stream.make({ type: "snapshot" as const, transcript: snapshot }), live);
    }),
    appendStatusActivity: (input) =>
      appendActivityUpdate(input.transcriptId, {
        id: EventId.make(`subagent:${input.transcriptId}:status:${input.kind}:${input.createdAt}`),
        createdAt: input.createdAt,
        tone: input.tone ?? "info",
        kind: input.kind,
        summary: input.summary,
        payload: {},
        turnId: null,
      }),
  });
});

let activeSubagentTranscriptService: SubagentTranscriptServiceShape | undefined;

export const layer = Layer.effect(
  SubagentTranscriptService,
  Effect.acquireRelease(
    make.pipe(
      Effect.tap((service) =>
        Effect.sync(() => {
          activeSubagentTranscriptService = service;
        }),
      ),
    ),
    (service) =>
      Effect.sync(() => {
        if (activeSubagentTranscriptService === service) {
          activeSubagentTranscriptService = undefined;
        }
      }),
  ),
);

export const registerActiveSubagentTranscript = (
  input: RegisterTranscriptInput,
): Effect.Effect<void> =>
  activeSubagentTranscriptService ? activeSubagentTranscriptService.register(input) : Effect.void;

export const appendActiveSubagentTranscriptStatus = (input: {
  readonly transcriptId: string;
  readonly kind: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly tone?: "info" | "error";
}): Effect.Effect<void> =>
  activeSubagentTranscriptService
    ? activeSubagentTranscriptService.appendStatusActivity(input)
    : Effect.void;

export const __testing = { make };
