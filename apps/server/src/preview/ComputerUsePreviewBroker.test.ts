import { makeComputerUseViewerSubject } from "./computerUseViewerBinding.ts";
import { expect, it } from "@effect/vitest";
import { Effect, Stream, Queue, Fiber } from "effect";
import { AuthSessionId } from "@t3tools/contracts";
import { make } from "./ComputerUsePreviewBroker.ts";
import { RemotePreviewTurnCredentialsIssuer } from "./RemotePreviewSessionBroker.ts";
import { computerUsePreviewRegistry as registry } from "./computerUsePreviewRegistry.ts";
const caller = (id: string) => ({ connectionId: id, authSessionId: AuthSessionId.make(id) });
const drain = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkScoped,
    );
    return { queue, fiber };
  });
it.effect(
  "keeps session discovery alive when the host subscription restarts on the same connection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previous = process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN = "restart-owner";
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN;
              else process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN = previous;
            }),
        );
        const broker = yield* make.pipe(
          Effect.provideService(RemotePreviewTurnCredentialsIssuer, {
            mint: () => Effect.succeed([]),
          }),
        );
        const owner = caller("same-connection");
        const watcher = yield* drain(yield* broker.watch(owner, { threadId: "host-restart" }));
        expect((yield* Queue.take(watcher.queue)).sessions).toEqual([]);
        const host = yield* drain(
          yield* broker.connectHost(owner, { ownerToken: "restart-owner" }),
        );
        expect((yield* Queue.take(host.queue)).type).toBe("connected");
        yield* Fiber.interrupt(host.fiber);
        registry.observe({
          bindingId: "restart",
          threadId: "host-restart",
          nativeThreadId: "native",
          providerInstanceId: "codex",
          operationId: "op",
          phase: "intent",
          target: { kind: "desktop" },
        });
        expect((yield* Queue.take(watcher.queue)).sessions[0]?.state).toBe("waiting-approval");
        registry.endBinding("restart");
      }),
    ),
);
it.effect("validates host ownership and refreshes peers when approved sources change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const previous = process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN = "test-owner";
        }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN;
            else process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN = previous;
          }),
      );
      const broker = yield* make.pipe(
        Effect.provideService(RemotePreviewTurnCredentialsIssuer, {
          mint: () => Effect.succeed([]),
        }),
      );
      const refused = yield* (yield* broker.connectHost(caller("intruder"), {
        ownerToken: "wrong",
      })).pipe(Stream.runDrain, Effect.result);
      expect(refused._tag).toBe("Failure");
      const host = yield* drain(
        yield* broker.connectHost(caller("host"), { ownerToken: "test-owner" }),
      );
      expect((yield* Queue.take(host.queue)).type).toBe("connected");
      const intent = {
        bindingId: "test-broker",
        threadId: "thread",
        providerInstanceId: "codex",
        operationId: "op",
        phase: "intent" as const,
        target: { kind: "app" as const, appId: "app" },
      };
      registry.observe(intent);
      registry.observe({ ...intent, phase: "completed" });
      const session = registry
        .snapshot("thread")
        .find((s) => s.target?.kind === "app" && s.target.appId === "app")!;
      const bounded = {
        ...caller("bounded"),
        subject: makeComputerUseViewerSubject({
          sessionId: session.sessionId,
          threadId: session.threadId,
          parentAuthSessionId: "parent",
        }),
      };
      const wrongSource = yield* (yield* broker.open(bounded, { sessionId: "other" })).pipe(
        Stream.runDrain,
        Effect.result,
      );
      expect(wrongSource._tag).toBe("Failure");
      const wrongThread = yield* (yield* broker.watch(bounded, { threadId: "other" })).pipe(
        Stream.runDrain,
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const boundedWatch = yield* drain(
        yield* broker.watch(bounded, { threadId: session.threadId }),
      );
      expect((yield* Queue.take(boundedWatch.queue)).sessions.map((s) => s.sessionId)).toEqual([
        session.sessionId,
      ]);
      yield* broker.revokeClientSession(AuthSessionId.make("parent"));
      expect((yield* Fiber.await(boundedWatch.fiber))._tag).toBe("Success");
      const revokedReopen = yield* (yield* broker.open(
        { ...bounded, connectionId: "reconnected" },
        { sessionId: session.sessionId },
      )).pipe(Stream.runDrain, Effect.result);
      expect(revokedReopen._tag).toBe("Failure");
      const viewer = yield* drain(
        yield* broker.open(caller("viewer"), { sessionId: session.sessionId }),
      );
      const opened = yield* Queue.take(viewer.queue);
      expect(opened.type).toBe("opened");
      const start = yield* Queue.take(host.queue);
      expect(start.type).toBe("start");
      registry.observe({ ...intent, operationId: "new", target: { kind: "app", appId: "other" } });
      expect((yield* Queue.take(host.queue)).type).toBe("stop");
      const changed = yield* Queue.take(viewer.queue);
      expect(changed.generation).toBeGreaterThan(opened.generation);
      registry.observe({
        ...intent,
        operationId: "new",
        phase: "completed",
        target: { kind: "app", appId: "other" },
      });
      expect((yield* Queue.take(host.queue)).type).toBe("stop");
      expect((yield* Queue.take(host.queue)).type).toBe("start");
      expect((yield* Queue.take(viewer.queue)).type).toBe("status");
      const reopened = yield* Queue.take(viewer.queue);
      const staleOffer = {
        type: "offer" as const,
        sessionId: opened.sessionId,
        viewerId: opened.viewerId,
        generation: opened.generation,
        sdp: "stale",
      };
      yield* broker.hostSignal(caller("host"), { event: staleOffer });
      yield* broker.hostSignal(caller("host"), {
        event: { ...staleOffer, generation: reopened.generation, sdp: "current" },
      });
      const currentOffer = yield* Queue.take(viewer.queue);
      expect(currentOffer.type === "offer" && currentOffer.sdp).toBe("current");
      yield* Fiber.interrupt(host.fiber);
      expect((yield* Queue.take(viewer.queue)).type).toBe("status");
      const nextHost = yield* drain(
        yield* broker.connectHost(caller("host-new"), { ownerToken: "test-owner" }),
      );
      expect((yield* Queue.take(nextHost.queue)).type).toBe("connected");
      expect((yield* Queue.take(nextHost.queue)).type).toBe("start");
      expect((yield* Queue.take(viewer.queue)).generation).toBeGreaterThan(reopened.generation);
      const staleOwner = yield* broker
        .hostSignal(caller("host"), { event: staleOffer })
        .pipe(Effect.result);
      expect(staleOwner._tag).toBe("Failure");
      yield* Fiber.interrupt(viewer.fiber);
      expect((yield* Queue.take(nextHost.queue)).type).toBe("stop");
      expect(registry.get(session.sessionId)?.state).toBe("ready");
      registry.endBinding("test-broker");
    }),
  ),
);
