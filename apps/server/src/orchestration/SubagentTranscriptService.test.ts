import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as SubagentTranscriptService from "./SubagentTranscriptService.ts";

// The ingest fiber interleaves real file IO between events, so tests (run
// with it.live and the real clock) wait for processing to settle.
const settle = Effect.sleep("25 millis");

const parentThreadId = ThreadId.make("parent-thread");
const otherThreadId = ThreadId.make("other-thread");
const runId = "run-1";
const delegatedThreadId = ThreadId.make(`delegated-${runId}`);
const now = "2026-07-11T00:00:00.000Z";

let eventCounter = 0;
const makeEvent = (
  partial: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "createdAt">,
): ProviderRuntimeEvent =>
  ({
    eventId: EventId.make(`event-${++eventCounter}`),
    provider: ProviderDriverKind.make("cursor"),
    createdAt: now,
    ...partial,
  }) as ProviderRuntimeEvent;

const makeProviderServiceStub = (events: Stream.Stream<ProviderRuntimeEvent>) =>
  ProviderService.of({
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    streamEvents: events,
  });

it.live("captures delegated events, isolates children, and enforces ownership", () => {
  const test = Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const serviceLayerInput = makeProviderServiceStub(Stream.fromPubSub(pubsub));
    const service = yield* SubagentTranscriptService.__testing.make.pipe(
      Effect.provideService(ProviderService, serviceLayerInput),
    );

    yield* service.register({
      id: runId,
      source: "delegated",
      parentThreadId,
      providerInstanceId: ProviderInstanceId.make("cursor"),
      model: "composer-2.5",
      requestedOptions: [{ id: "reasoning", value: "high" }],
      resolvedOptions: [{ id: "reasoning", value: "high" }],
      task: "Compare package managers",
      createdAt: now,
    });

    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(pubsub, event).pipe(Effect.andThen(settle));

    yield* publish(
      makeEvent({
        type: "content.delta",
        threadId: delegatedThreadId,
        turnId: TurnId.make("turn-1"),
        payload: { streamKind: "assistant_text", delta: "Working " },
      } as never),
    );
    yield* publish(
      makeEvent({
        type: "content.delta",
        threadId: delegatedThreadId,
        turnId: TurnId.make("turn-1"),
        payload: { streamKind: "assistant_text", delta: "on it." },
      } as never),
    );
    yield* publish(
      makeEvent({
        type: "item.started",
        threadId: delegatedThreadId,
        turnId: TurnId.make("turn-1"),
        itemId: "tool-1",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Command run",
          detail: "pnpm --version",
          data: { toolName: "bash", input: { command: "pnpm --version" } },
        },
      } as never),
    );
    yield* publish(
      makeEvent({
        type: "item.completed",
        threadId: delegatedThreadId,
        turnId: TurnId.make("turn-1"),
        itemId: "tool-1",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Command run",
          data: { result: "10.0.0" },
        },
      } as never),
    );
    yield* publish(
      makeEvent({
        type: "item.completed",
        threadId: delegatedThreadId,
        turnId: TurnId.make("turn-1"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Working on it. Done.",
        },
      } as never),
    );
    yield* publish(
      makeEvent({
        type: "turn.completed",
        threadId: delegatedThreadId,
        turnId: TurnId.make("turn-1"),
        payload: { state: "completed" },
      } as never),
    );

    // A native child on the parent thread, tagged with parentToolUseId.
    yield* publish(
      makeEvent({
        type: "item.completed",
        threadId: parentThreadId,
        itemId: "child-message-1",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Native child findings.",
          data: { parentToolUseId: "toolu_123" },
        },
      } as never),
    );

    const transcript = yield* service.get({ parentThreadId, transcriptId: runId });
    expect(transcript.source).toBe("delegated");
    expect(transcript.model).toBe("composer-2.5");
    expect(transcript.requestedOptions).toEqual([{ id: "reasoning", value: "high" }]);
    expect(transcript.resolvedOptions).toEqual([{ id: "reasoning", value: "high" }]);
    expect(transcript.messages[0]).toMatchObject({
      role: "user",
      text: "Compare package managers",
    });
    const assistant = transcript.messages.find((message) => message.role === "assistant");
    expect(assistant?.text).toBe("Working on it. Done.");
    expect(assistant?.streaming).toBe(false);
    const activityKinds = transcript.activities.map((activity) => activity.kind);
    expect(activityKinds).toEqual(["tool.started", "tool.completed", "turn.completed"]);
    // Sequences replay monotonically.
    const sequences = transcript.activities.map((activity) => activity.sequence ?? 0);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);

    // Native child transcript exists, isolated from the delegated one.
    const nativeTranscript = yield* service.get({
      parentThreadId,
      transcriptId: "toolu_123",
    });
    expect(nativeTranscript.source).toBe("native");
    expect(nativeTranscript.messages).toHaveLength(1);
    expect(nativeTranscript.messages[0]?.text).toBe("Native child findings.");

    // Ownership enforcement: wrong parent thread cannot read the transcript.
    const forbidden = yield* service
      .get({ parentThreadId: otherThreadId, transcriptId: runId })
      .pipe(Effect.flip);
    expect(forbidden.reason).toBe("forbidden");
    const missing = yield* service
      .get({ parentThreadId, transcriptId: "does-not-exist" })
      .pipe(Effect.flip);
    expect(missing.reason).toBe("not_found");

    // Restart: a fresh service instance over the same state dir recovers the
    // persisted transcript (completed messages + activities).
    const restarted = yield* SubagentTranscriptService.__testing.make.pipe(
      Effect.provideService(ProviderService, makeProviderServiceStub(Stream.empty)),
    );
    const recovered = yield* restarted.get({ parentThreadId, transcriptId: runId });
    expect(recovered.messages.map((message) => message.text)).toEqual([
      "Compare package managers",
      "Working on it. Done.",
    ]);
    expect(recovered.activities.map((activity) => activity.kind)).toEqual([
      "tool.started",
      "tool.completed",
      "turn.completed",
    ]);
  });

  return test.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest("/workspace", { prefix: "subagent-transcripts-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );
});

it.live("subscribe emits a snapshot followed by live updates", () => {
  const test = Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const service = yield* SubagentTranscriptService.__testing.make.pipe(
      Effect.provideService(ProviderService, makeProviderServiceStub(Stream.fromPubSub(pubsub))),
    );

    yield* service.register({
      id: runId,
      source: "delegated",
      parentThreadId,
      task: "Do a thing",
      createdAt: now,
    });

    const stream = yield* service.subscribe({ parentThreadId, transcriptId: runId });
    const collected = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)));
    yield* settle;
    yield* PubSub.publish(
      pubsub,
      makeEvent({
        type: "item.started",
        threadId: delegatedThreadId,
        turnId: TurnId.make("turn-9"),
        itemId: "tool-9",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Command run",
          data: {},
        },
      } as never),
    );
    const events = [...(yield* Fiber.join(collected))];
    expect(events[0]?.type).toBe("snapshot");
    expect(events[1]?.type).toBe("activity.upserted");
    if (events[0]?.type === "snapshot" && events[1]?.type === "activity.upserted") {
      expect(events[1].sequence).toBeGreaterThan(events[0].transcript.latestSequence);
    }
  });

  return test.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest("/workspace", { prefix: "subagent-transcripts-sub-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );
});
