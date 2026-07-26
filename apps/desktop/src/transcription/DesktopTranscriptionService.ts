// @effect-diagnostics globalTimers:off - Request/idle timers belong to the imperative Electron utility-process boundary and are dependency-injected in tests.
import type {
  DesktopTranscriptionSendAudioInput,
  DesktopTranscriptionStartSessionInput,
  DesktopTranscriptionStopSessionInput,
  LocalTranscriptionCapabilities,
  TranscriptionUpdate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopModelManager from "./DesktopModelManager.ts";
import type {
  DesktopTranscriptionHostCommand,
  DesktopTranscriptionHostResponse,
} from "./desktopTranscriptionProtocol.ts";

/* oxlint-disable unicorn/require-post-message-target-origin -- Electron UtilityProcess.postMessage does not have a targetOrigin parameter. */

export interface UtilityProcessLike {
  postMessage(message: DesktopTranscriptionHostCommand): void;
  kill(): boolean;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
}

export interface DesktopTranscriptionSessionOwner {
  readonly id: number;
  isDestroyed(): boolean;
  once(
    event: "destroyed" | "render-process-gone",
    listener: (...args: readonly unknown[]) => void,
  ): this;
  off(
    event: "destroyed" | "render-process-gone",
    listener: (...args: readonly unknown[]) => void,
  ): this;
}

interface TimerHandle {
  readonly cancel: () => void;
}

export interface DesktopTranscriptionServiceDependencies {
  readonly forkUtilityProcess: () => UtilityProcessLike;
  readonly resolveModel: () => Promise<{ readonly path: string }>;
  readonly idleTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly sessionInactivityTimeoutMs?: number;
  readonly schedule?: (delayMs: number, callback: () => void) => TimerHandle;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: TimerHandle;
}

interface ActiveSession {
  readonly id: string;
  readonly owner: DesktopTranscriptionSessionOwner;
  readonly onOwnerGone: () => void;
}

type HostCommandInput = DesktopTranscriptionHostCommand extends infer Command
  ? Command extends DesktopTranscriptionHostCommand
    ? Omit<Command, "id">
    : never
  : never;

const defaultSchedule = (delayMs: number, callback: () => void): TimerHandle => {
  const timeout = setTimeout(callback, delayMs);
  timeout.unref?.();
  return { cancel: () => clearTimeout(timeout) };
};

/**
 * Main-process relay only. It never imports transcribe-cpp; native inference is
 * isolated behind the Electron UtilityProcess boundary.
 */
export class DesktopTranscriptionServiceImpl {
  readonly #dependencies: Required<
    Pick<
      DesktopTranscriptionServiceDependencies,
      "idleTimeoutMs" | "requestTimeoutMs" | "schedule" | "sessionInactivityTimeoutMs"
    >
  > &
    Omit<
      DesktopTranscriptionServiceDependencies,
      "idleTimeoutMs" | "requestTimeoutMs" | "schedule" | "sessionInactivityTimeoutMs"
    >;
  readonly #listeners = new Set<(update: TranscriptionUpdate) => void>();
  readonly #errorListeners = new Set<
    (event: { readonly sessionId: string; readonly message: string }) => void
  >();
  readonly #pending = new Map<number, PendingRequest>();
  #process: UtilityProcessLike | undefined;
  #activeSession: ActiveSession | undefined;
  #nextRequestId = 1;
  #idleTimer: TimerHandle | undefined;
  #sessionInactivityTimer: TimerHandle | undefined;
  #intentionalTermination = false;

  constructor(dependencies: DesktopTranscriptionServiceDependencies) {
    this.#dependencies = {
      ...dependencies,
      idleTimeoutMs: dependencies.idleTimeoutMs ?? 5 * 60_000,
      requestTimeoutMs: dependencies.requestTimeoutMs ?? 120_000,
      sessionInactivityTimeoutMs: dependencies.sessionInactivityTimeoutMs ?? 30_000,
      schedule: dependencies.schedule ?? defaultSchedule,
    };
  }

  subscribe(listener: (update: TranscriptionUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeErrors(
    listener: (event: { readonly sessionId: string; readonly message: string }) => void,
  ): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  async getCapabilities(): Promise<LocalTranscriptionCapabilities> {
    const model = await this.#dependencies.resolveModel();
    try {
      return (await this.#request({
        kind: "get-capabilities",
        modelPath: model.path,
      })) as LocalTranscriptionCapabilities;
    } finally {
      if (this.#activeSession === undefined) this.#scheduleIdleTermination();
    }
  }

  async startSession(
    input: DesktopTranscriptionStartSessionInput,
    owner: DesktopTranscriptionSessionOwner,
  ): Promise<void> {
    if (this.#activeSession !== undefined) {
      throw new Error(
        `A desktop transcription session is already active: ${this.#activeSession.id}`,
      );
    }
    if (owner.isDestroyed()) throw new Error("The transcription renderer is no longer available.");
    this.#clearIdleTimer();
    const onOwnerGone = () => {
      this.#abandonActiveSession(
        input.sessionId,
        "The transcription renderer exited before the session completed.",
      );
    };
    owner.once("destroyed", onOwnerGone);
    owner.once("render-process-gone", onOwnerGone);
    const reservation: ActiveSession = { id: input.sessionId, owner, onOwnerGone };
    // Reserve synchronously before model resolution so concurrent starts cannot
    // both pass the active-session check.
    this.#activeSession = reservation;
    this.#armSessionInactivityWatchdog(input.sessionId);
    try {
      const model = await this.#dependencies.resolveModel();
      if (this.#activeSession !== reservation || owner.isDestroyed()) {
        throw new Error("The transcription renderer is no longer available.");
      }
      await this.#request({
        kind: "start-session",
        modelPath: model.path,
        input,
      });
    } catch (error) {
      if (this.#activeSession === reservation) {
        this.#clearActiveSession(input.sessionId);
      }
      this.#scheduleIdleTermination();
      throw error;
    }
  }

  async sendAudio(
    input: DesktopTranscriptionSendAudioInput,
    owner: DesktopTranscriptionSessionOwner,
  ): Promise<void> {
    this.#assertOwnedActiveSession(input.sessionId, owner);
    this.#armSessionInactivityWatchdog(input.sessionId);
    await this.#request({
      kind: "send-audio",
      sessionId: input.sessionId,
      audio: input.audio,
    });
  }

  async stopSession(
    input: DesktopTranscriptionStopSessionInput,
    owner: DesktopTranscriptionSessionOwner,
  ): Promise<void> {
    this.#assertOwnedActiveSession(input.sessionId, owner);
    this.#clearSessionInactivityTimer();
    try {
      await this.#request({ kind: "stop-session", sessionId: input.sessionId });
    } finally {
      this.#clearActiveSession(input.sessionId);
      this.#scheduleIdleTermination();
    }
  }

  async cancelSession(
    input: DesktopTranscriptionStopSessionInput,
    owner: DesktopTranscriptionSessionOwner,
  ): Promise<void> {
    this.#assertOwnedActiveSession(input.sessionId, owner);
    this.#clearSessionInactivityTimer();
    try {
      await this.#request({ kind: "cancel-session", sessionId: input.sessionId });
    } finally {
      this.#clearActiveSession(input.sessionId);
      this.#scheduleIdleTermination();
    }
  }

  dispose(): void {
    this.#clearIdleTimer();
    this.#clearActiveSession();
    this.#terminateProcess();
  }

  async #request(command: HostCommandInput): Promise<unknown> {
    const child = this.#ensureProcess();
    const id = this.#nextRequestId++;
    return await new Promise((resolve, reject) => {
      const timeout = this.#dependencies.schedule(this.#dependencies.requestTimeoutMs, () => {
        this.#pending.delete(id);
        reject(new Error(`Desktop transcription utility request timed out: ${command.kind}`));
      });
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        child.postMessage({ ...command, id } as DesktopTranscriptionHostCommand);
      } catch (error) {
        this.#pending.delete(id);
        timeout.cancel();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #ensureProcess(): UtilityProcessLike {
    if (this.#process !== undefined) return this.#process;
    this.#intentionalTermination = false;
    const child = this.#dependencies.forkUtilityProcess();
    child.on("message", (message) => this.#handleMessage(message));
    child.on("exit", (code) => this.#handleExit(child, code));
    this.#process = child;
    return child;
  }

  #handleMessage(message: unknown): void {
    const response = message as DesktopTranscriptionHostResponse;
    if (response.kind === "response") {
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      pending.timeout.cancel();
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error));
      return;
    }
    if (response.kind === "update") {
      if (
        response.update.kind === "ended" &&
        this.#activeSession?.id === response.update.sessionId
      ) {
        this.#clearActiveSession(response.update.sessionId);
        this.#scheduleIdleTermination();
      }
      this.#emit(response.update);
      return;
    }
    if (response.kind === "session-error") {
      if (this.#activeSession?.id === response.sessionId) {
        this.#emitError({ sessionId: response.sessionId, message: response.error });
      }
    }
  }

  #handleExit(child: UtilityProcessLike, code: number): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    const error = new Error(
      this.#intentionalTermination
        ? "Desktop transcription utility terminated while idle."
        : `Desktop transcription utility crashed with exit code ${code}.`,
    );
    for (const pending of this.#pending.values()) {
      pending.timeout.cancel();
      pending.reject(error);
    }
    this.#pending.clear();
    if (!this.#intentionalTermination && this.#activeSession !== undefined) {
      const sessionId = this.#activeSession.id;
      this.#emitError({ sessionId, message: error.message });
      this.#emit({ sessionId, kind: "ended" });
    }
    this.#clearActiveSession();
    this.#intentionalTermination = false;
  }

  #emit(update: TranscriptionUpdate): void {
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        // A renderer listener cannot destabilize the main-process relay.
      }
    }
  }

  #emitError(event: { readonly sessionId: string; readonly message: string }): void {
    for (const listener of this.#errorListeners) {
      try {
        listener(event);
      } catch {
        // A renderer listener cannot destabilize the main-process relay.
      }
    }
  }

  #assertOwnedActiveSession(sessionId: string, owner: DesktopTranscriptionSessionOwner): void {
    const active = this.#activeSession;
    if (active?.id !== sessionId) {
      throw new Error(`Unknown desktop transcription session: ${sessionId}`);
    }
    if (active.owner.id !== owner.id) {
      throw new Error("The desktop transcription session belongs to another renderer.");
    }
    if (owner.isDestroyed()) {
      this.#abandonActiveSession(
        sessionId,
        "The transcription renderer exited before the session completed.",
      );
      throw new Error("The transcription renderer is no longer available.");
    }
  }

  #abandonActiveSession(sessionId: string, message: string): void {
    if (this.#activeSession?.id !== sessionId) return;
    this.#clearActiveSession(sessionId);
    this.#emitError({ sessionId, message });
    this.#emit({ sessionId, kind: "ended" });
    if (this.#process === undefined) {
      this.#scheduleIdleTermination();
      return;
    }
    const child = this.#process;
    void this.#request({ kind: "cancel-session", sessionId })
      .catch(() => {
        if (this.#process === child) this.#terminateProcess();
      })
      .finally(() => this.#scheduleIdleTermination());
  }

  #armSessionInactivityWatchdog(sessionId: string): void {
    this.#clearSessionInactivityTimer();
    this.#sessionInactivityTimer = this.#dependencies.schedule(
      this.#dependencies.sessionInactivityTimeoutMs,
      () => {
        this.#sessionInactivityTimer = undefined;
        this.#abandonActiveSession(
          sessionId,
          "Desktop transcription stopped because the renderer sent no audio for too long.",
        );
      },
    );
  }

  #clearActiveSession(sessionId?: string): void {
    const active = this.#activeSession;
    if (active === undefined || (sessionId !== undefined && active.id !== sessionId)) return;
    active.owner.off("destroyed", active.onOwnerGone);
    active.owner.off("render-process-gone", active.onOwnerGone);
    this.#activeSession = undefined;
    this.#clearSessionInactivityTimer();
  }

  #clearSessionInactivityTimer(): void {
    this.#sessionInactivityTimer?.cancel();
    this.#sessionInactivityTimer = undefined;
  }

  #scheduleIdleTermination(): void {
    this.#clearIdleTimer();
    this.#idleTimer = this.#dependencies.schedule(this.#dependencies.idleTimeoutMs, () => {
      this.#idleTimer = undefined;
      if (this.#activeSession === undefined) this.#terminateProcess();
    });
  }

  #clearIdleTimer(): void {
    this.#idleTimer?.cancel();
    this.#idleTimer = undefined;
  }

  #terminateProcess(): void {
    if (this.#process === undefined) return;
    this.#intentionalTermination = true;
    this.#process.kill();
  }
}

export class DesktopTranscriptionService extends Context.Service<
  DesktopTranscriptionService,
  DesktopTranscriptionServiceImpl
>()("@t3tools/desktop/transcription/DesktopTranscriptionService") {}

export const layer = (forkUtilityProcess: (hostEntryPath: string) => UtilityProcessLike) =>
  Layer.effect(
    DesktopTranscriptionService,
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const settings = yield* DesktopClientSettings.DesktopClientSettings;
      const modelManager = yield* DesktopModelManager.DesktopModelManager;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const service = new DesktopTranscriptionServiceImpl({
        forkUtilityProcess: () =>
          forkUtilityProcess(
            environment.path.join(environment.dirname, "desktopTranscriptionHost.cjs"),
          ),
        resolveModel: async () => {
          const current = Option.getOrUndefined(await runPromise(settings.get));
          return modelManager.resolvePreferredModel(
            current === undefined
              ? {}
              : {
                  ...(current.voiceModelId ? { modelId: current.voiceModelId } : {}),
                  ...(current.voiceModelQuant ? { quantizationId: current.voiceModelQuant } : {}),
                },
          );
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => service.dispose()));
      return service;
    }),
  );

export const layerTest = (service: DesktopTranscriptionServiceImpl) =>
  Layer.succeed(DesktopTranscriptionService, service);
