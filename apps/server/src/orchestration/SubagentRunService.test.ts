import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  DelegationBatchId,
  DelegationWorkflowId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  type ProviderRuntimeEvent,
  type SubagentRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as SubagentRunService from "./SubagentRunService.ts";

const rootThreadId = ThreadId.make("root-thread");
const otherThreadId = ThreadId.make("other-thread");
const runId = SubagentRunId.make("run-1");
const now = "2026-07-14T00:00:00.000Z";

const makeRun = (overrides: Partial<SubagentRun> = {}): SubagentRun => ({
  id: runId,
  source: "native",
  provider: ProviderDriverKind.make("cursor"),
  providerInstanceId: ProviderInstanceId.make("cursor"),
  rootThreadId,
  depth: 0,
  title: "Research dependency graph",
  taskPreview: "Research dependency graph",
  modelResolution: "unknown",
  status: "running",
  lastSummary: null,
  finalMessage: null,
  error: null,
  capabilities: {
    canCancel: false,
    canSteer: false,
    canRespond: false,
    canResume: false,
    transcriptQuality: "live",
  },
  createdAt: now,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  sequence: 0,
  ...overrides,
});

const withTestServices = <A, E, R>(
  prefix: string,
  effect: Effect.Effect<A, E, R | ServerConfig | FileSystem.FileSystem>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest("/workspace", { prefix }).pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );

it.live("projects lifecycle evidence monotonically and deduplicates event IDs", () =>
  withTestServices(
    "subagent-run-lifecycle-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;

      const started = yield* service.upsert({
        eventId: "event-started",
        run: makeRun(),
        providerRefs: { providerTaskId: "task-1" },
      });
      expect(started.status).toBe("running");
      expect(started.sequence).toBe(0);

      const completed = yield* service.upsert({
        eventId: "event-completed",
        run: makeRun({
          status: "completed",
          finalMessage: "Dependency graph verified.",
          completedAt: now,
          sequence: 1,
        }),
      });
      expect(completed.status).toBe("completed");
      expect(completed.sequence).toBe(1);

      const staleProgress = yield* service.upsert({
        eventId: "event-stale-progress",
        run: makeRun({ status: "running", sequence: 2 }),
      });
      expect(staleProgress.status).toBe("completed");
      expect(staleProgress.sequence).toBe(2);

      const duplicate = yield* service.upsert({
        eventId: "event-stale-progress",
        run: makeRun({ status: "failed", sequence: 99 }),
      });
      expect(duplicate.status).toBe("completed");
      expect(duplicate.sequence).toBe(2);

      const resolved = yield* service.resolveProviderRef("providerTaskId", "task-1");
      expect(resolved?.id).toBe(runId);
      expect((yield* service.getOwned(rootThreadId, runId)).status).toBe("completed");
      expect((yield* service.getOwned(otherThreadId, runId).pipe(Effect.flip)).reason).toBe(
        "forbidden",
      );
      expect(
        (yield* service.getOwned(rootThreadId, SubagentRunId.make("missing")).pipe(Effect.flip))
          .reason,
      ).toBe("not_found");
    }),
  ),
);

it.live("subscribes before snapshotting and emits gap-free monotonic updates", () =>
  withTestServices(
    "subagent-run-subscription-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;
      yield* service.upsert({ eventId: "event-before-subscribe", run: makeRun() });

      const stream = yield* service.subscribe({ rootThreadId });
      const collector = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)));
      yield* Effect.yieldNow;
      yield* service.upsert({
        eventId: "event-after-subscribe",
        run: makeRun({ status: "waiting_for_input", sequence: 1 }),
      });

      const events = [...(yield* Fiber.join(collector))];
      expect(events[0]?.type).toBe("snapshot");
      expect(events[1]?.type).toBe("run.upserted");
      if (events[0]?.type === "snapshot" && events[1]?.type === "run.upserted") {
        expect(events[0].runs).toHaveLength(1);
        expect(events[1].run.status).toBe("waiting_for_input");
        expect(events[1].snapshotSequence).toBeGreaterThan(events[0].snapshotSequence);
      }
    }),
  ),
);

it.live("subscribes to all runs when rootThreadId is omitted", () =>
  withTestServices(
    "subagent-run-environment-subscribe-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;
      yield* service.upsert({ eventId: "event-root-a", run: makeRun() });
      yield* service.upsert({
        eventId: "event-root-b",
        run: makeRun({
          id: SubagentRunId.make("run-other"),
          rootThreadId: otherThreadId,
          title: "Other",
          taskPreview: "Other",
        }),
      });

      const stream = yield* service.subscribe({});
      const events = [...(yield* Stream.runCollect(Stream.take(stream, 1)))];
      expect(events[0]?.type).toBe("snapshot");
      if (events[0]?.type === "snapshot") {
        expect(events[0].rootThreadId).toBeUndefined();
        expect(events[0].runs.map((run) => run.id).toSorted()).toEqual(
          [runId, SubagentRunId.make("run-other")].toSorted(),
        );
      }
    }),
  ),
);

it.live("creates provisional native runs from execution scope and refines lifecycle data", () =>
  withTestServices(
    "subagent-run-ingestion-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;
      const scopedEvent = {
        eventId: EventId.make("runtime-progress-first"),
        type: "content.delta",
        provider: ProviderDriverKind.make("cursor"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId: rootThreadId,
        createdAt: now,
        executionScope: { kind: "subagent", subagentRunId: runId, depth: 1 },
        providerRefs: { providerTaskId: "task-early" },
        payload: { streamKind: "assistant_text", delta: "Investigating" },
      } as ProviderRuntimeEvent;
      yield* service.ingest(scopedEvent);
      const provisional = yield* service.getOwned(rootThreadId, runId);
      expect(provisional.status).toBe("unknown");
      expect(provisional.depth).toBe(1);

      yield* service.ingest({
        eventId: EventId.make("runtime-started-late"),
        type: "subagent.started",
        provider: ProviderDriverKind.make("cursor"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId: rootThreadId,
        createdAt: now,
        executionScope: { kind: "subagent", subagentRunId: runId, depth: 1 },
        providerRefs: { providerTaskId: "task-early" },
        payload: {
          source: "native",
          status: "running",
          title: "Explore architecture",
          taskPreview: "Explore architecture",
          modelResolution: "reported",
          resolvedModel: "gpt-5.4-medium",
          requestedOptions: [{ id: "serviceTier", value: "fast" }],
          resolvedOptions: [{ id: "serviceTier", value: "priority" }],
          resolvedOptionDetails: [
            {
              id: "serviceTier",
              label: "Service Tier",
              value: "priority",
              valueLabel: "Fast",
            },
          ],
          capabilities: makeRun().capabilities,
        },
      } as ProviderRuntimeEvent);

      const refined = yield* service.getOwned(rootThreadId, runId);
      expect(refined.status).toBe("running");
      expect(refined.title).toBe("Explore architecture");
      expect(refined.resolvedModel).toBe("gpt-5.4-medium");
      expect(refined.resolvedOptionDetails?.[0]?.valueLabel).toBe("Fast");
      expect(refined.sequence).toBe(1);

      yield* service.ingest({
        eventId: EventId.make("runtime-status-only"),
        type: "subagent.updated",
        provider: ProviderDriverKind.make("cursor"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId: rootThreadId,
        createdAt: now,
        executionScope: { kind: "subagent", subagentRunId: runId, depth: 1 },
        payload: { source: "native", status: "waiting_for_input" },
      } as ProviderRuntimeEvent);
      const statusOnly = yield* service.getOwned(rootThreadId, runId);
      expect(statusOnly.resolvedOptions).toEqual([{ id: "serviceTier", value: "priority" }]);
      expect(statusOnly.resolvedOptionDetails?.[0]?.valueLabel).toBe("Fast");
    }),
  ),
);

it.live("replays terminal runs, marks interrupted runs unknown, and ignores malformed tails", () =>
  withTestServices(
    "subagent-run-replay-test-",
    Effect.gen(function* () {
      const first = yield* SubagentRunService.__testing.make;
      yield* first.upsert({ eventId: "terminal", run: makeRun({ status: "completed" }) });
      yield* first.upsert({
        eventId: "active",
        run: makeRun({ id: SubagentRunId.make("run-active"), status: "running" }),
      });

      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${config.stateDir}/subagent-runs-v1.ndjson`, "{malformed-tail\n", {
        flag: "a",
      });

      const restarted = yield* SubagentRunService.__testing.make;
      expect((yield* restarted.getOwned(rootThreadId, runId)).status).toBe("completed");
      expect(
        (yield* restarted.getOwned(rootThreadId, SubagentRunId.make("run-active"))).status,
      ).toBe("unknown");

      const compacted = yield* fs.readFileString(`${config.stateDir}/subagent-runs-v1.ndjson`);
      expect(compacted).toContain('"kind":"snapshot"');
      expect(compacted).not.toContain("malformed-tail");

      const replayedAgain = yield* SubagentRunService.__testing.make;
      const duplicate = yield* replayedAgain.upsert({
        eventId: "terminal",
        run: makeRun({ status: "failed", sequence: 999 }),
      });
      expect(duplicate.status).toBe("completed");
      expect(duplicate.sequence).toBe(0);
    }),
  ),
);

it.live("rehydrates a large run set and reconnects with one complete snapshot", () =>
  withTestServices(
    "subagent-run-load-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;
      const totalRuns = 500;
      yield* Effect.forEach(
        Array.from({ length: totalRuns }, (_, index) => index),
        (index) =>
          service.upsert({
            eventId: `load-event-${index}`,
            run: makeRun({
              id: SubagentRunId.make(`load-run-${index}`),
              status: "completed",
              completedAt: now,
            }),
          }),
        { concurrency: 32, discard: true },
      );

      const restarted = yield* SubagentRunService.__testing.make;
      const reconnectStream = yield* restarted.subscribe({ rootThreadId });
      const [snapshot] = [...(yield* Stream.runCollect(Stream.take(reconnectStream, 1)))];
      expect(snapshot?.type).toBe("snapshot");
      if (snapshot?.type === "snapshot") {
        expect(snapshot.runs).toHaveLength(totalRuns);
        expect(new Set(snapshot.runs.map((run) => run.id)).size).toBe(totalRuns);
        expect(snapshot.runs.every((run) => run.status === "completed")).toBe(true);
      }
    }),
  ),
);

it("keeps terminal evidence sticky while allowing completion to outrank cancellation", () => {
  expect(SubagentRunService.reduceSubagentStatus("completed", "running")).toBe("completed");
  expect(SubagentRunService.reduceSubagentStatus("cancelled", "completed")).toBe("completed");
  expect(SubagentRunService.reduceSubagentStatus("failed", "cancelled")).toBe("failed");
});

it.live("allows only newer workflow-agent attempts to reset terminal status", () =>
  withTestServices(
    "subagent-run-workflow-retry-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;
      const attempt1StartedAt = "2026-07-14T00:00:00.000Z";
      const attempt2StartedAt = "2026-07-14T00:05:00.000Z";
      const workflowAgent = makeRun({
        id: SubagentRunId.make("claude-wf:wf_example:1"),
        runKind: "agent",
        workflow: { runId: "wf_example", attempt: 1 },
        status: "failed",
        lastSummary: "Attempt 1 summary",
        finalMessage: "Attempt 1 result",
        error: "First attempt failed",
        startedAt: attempt1StartedAt,
        completedAt: now,
      });
      yield* service.upsert({ eventId: "attempt-1-failed", run: workflowAgent });

      const sameAttempt = yield* service.upsert({
        eventId: "attempt-1-stale-progress",
        run: { ...workflowAgent, status: "running", completedAt: null },
      });
      expect(sameAttempt.status).toBe("failed");
      expect(sameAttempt.completedAt).toBe(now);
      expect(sameAttempt.lastSummary).toBe("Attempt 1 summary");
      expect(sameAttempt.finalMessage).toBe("Attempt 1 result");
      expect(sameAttempt.error).toBe("First attempt failed");
      expect(sameAttempt.startedAt).toBe(attempt1StartedAt);

      const retry = yield* service.upsert({
        eventId: "attempt-2-running",
        run: {
          ...workflowAgent,
          workflow: { runId: "wf_example", attempt: 2 },
          status: "running",
          lastSummary: null,
          finalMessage: "stale final from naive spread",
          error: "stale error from naive spread",
          startedAt: attempt2StartedAt,
          completedAt: null,
        },
      });
      expect(retry.status).toBe("running");
      expect(retry.completedAt).toBeNull();
      expect(retry.lastSummary).toBeNull();
      expect(retry.finalMessage).toBeNull();
      expect(retry.error).toBeNull();
      expect(retry.startedAt).toBe(attempt2StartedAt);

      const unrelatedAgent = makeRun({
        id: SubagentRunId.make("plain-agent"),
        status: "failed",
        completedAt: now,
      });
      yield* service.upsert({ eventId: "plain-failed", run: unrelatedAgent });
      const plainProgress = yield* service.upsert({
        eventId: "plain-progress",
        run: { ...unrelatedAgent, status: "running", completedAt: null },
      });
      expect(plainProgress.status).toBe("failed");
    }),
  ),
);

it.live("projects workflow lifecycle metadata through runtime ingestion", () =>
  withTestServices(
    "subagent-run-workflow-ingestion-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;
      const workflowRunId = SubagentRunId.make("claude-wf:wf_example");
      yield* service.ingest({
        eventId: EventId.make("workflow-started"),
        type: "subagent.started",
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        threadId: rootThreadId,
        createdAt: now,
        executionScope: { kind: "subagent", subagentRunId: workflowRunId, depth: 0 },
        payload: {
          source: "native",
          status: "starting",
          runKind: "workflow",
          workflow: { runId: "wf_example", name: "Verify plan" },
          stats: { agentCount: 2, totalTokens: 300, totalToolCalls: 5 },
          title: "Verify plan",
          taskPreview: "Verify the implementation plan",
          capabilities: {
            canCancel: true,
            canSteer: false,
            canRespond: false,
            canResume: false,
            transcriptQuality: "summary",
          },
        },
      } as ProviderRuntimeEvent);

      const projected = yield* service.getOwned(rootThreadId, workflowRunId);
      expect(projected.runKind).toBe("workflow");
      expect(projected.workflow?.name).toBe("Verify plan");
      expect(projected.stats).toEqual({
        agentCount: 2,
        totalTokens: 300,
        totalToolCalls: 5,
      });
    }),
  ),
);

it.live("aggregates routed children into their workflow root", () =>
  withTestServices(
    "subagent-run-routed-workflow-test-",
    Effect.gen(function* () {
      const service = yield* SubagentRunService.__testing.make;
      const workflowId = DelegationWorkflowId.make("workflow-routed");
      const batchId = DelegationBatchId.make("batch-routed");
      const rootId = SubagentRunId.make(workflowId);
      yield* service.upsert({
        eventId: "workflow-root",
        run: makeRun({
          id: rootId,
          runKind: "workflow",
          workflowId,
          batchId,
          status: "queued",
          startedAt: null,
        }),
      });
      yield* service.upsert({
        eventId: "workflow-child-one",
        run: makeRun({
          id: SubagentRunId.make("child-one"),
          runKind: "agent",
          workflowId,
          batchId,
          status: "completed",
          completedAt: now,
        }),
      });
      yield* service.upsert({
        eventId: "workflow-child-two",
        run: makeRun({
          id: SubagentRunId.make("child-two"),
          runKind: "agent",
          workflowId,
          batchId,
          status: "failed",
          error: "startup failed",
          completedAt: now,
        }),
      });

      const workflow = yield* service.getOwned(rootThreadId, rootId);
      expect(workflow.status).toBe("failed");
      expect(workflow.lastSummary).toBe("2/2 delegated tasks settled");
      expect(workflow.error).toBe("1 delegated task(s) failed");
    }),
  ),
);
