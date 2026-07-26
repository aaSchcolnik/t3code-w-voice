import type {
  DesktopTranscriptionStartSessionInput,
  LocalTranscriptionCapabilities,
} from "@t3tools/contracts";
import { ChunkedTranscriptionEngine, type Recognizer } from "@t3tools/voice-core";

import type {
  DesktopTranscriptionHostCommand,
  DesktopTranscriptionHostPort,
} from "./desktopTranscriptionProtocol.ts";
import { TranscribeCppRecognizer } from "./TranscribeCppRecognizer.ts";

/* oxlint-disable unicorn/require-post-message-target-origin -- Electron MessagePorts do not have a targetOrigin parameter. */

interface ParentPort {
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}

export interface DesktopTranscriptionHostDependencies {
  readonly port: DesktopTranscriptionHostPort;
  readonly createRecognizer: (modelPath: string) => DesktopHostRecognizer;
}

export interface DesktopHostRecognizer extends Recognizer {
  readonly getCapabilities: () => Promise<LocalTranscriptionCapabilities>;
  readonly dispose: () => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const float32FromBytes = (audio: Uint8Array): Float32Array => {
  if (audio.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Float32 PCM byte length must be divisible by four.");
  }
  const copy = new Uint8Array(audio.byteLength);
  copy.set(audio);
  return new Float32Array(copy.buffer);
};

export class DesktopTranscriptionHost {
  readonly #port: DesktopTranscriptionHostPort;
  readonly #createRecognizer: (modelPath: string) => DesktopHostRecognizer;
  #recognizer: { readonly modelPath: string; readonly value: DesktopHostRecognizer } | undefined;
  #session:
    | {
        readonly id: string;
        readonly engine: ChunkedTranscriptionEngine;
      }
    | undefined;
  #commandTail: Promise<void> = Promise.resolve();

  constructor(dependencies: DesktopTranscriptionHostDependencies) {
    this.#port = dependencies.port;
    this.#createRecognizer = dependencies.createRecognizer;
  }

  handle(command: DesktopTranscriptionHostCommand): Promise<void> {
    const result = this.#commandTail.then(() => this.#handle(command));
    this.#commandTail = result;
    return result;
  }

  async #handle(command: DesktopTranscriptionHostCommand): Promise<void> {
    try {
      const value = await this.#dispatch(command);
      this.#port.postMessage({
        kind: "response",
        id: command.id,
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
    } catch (error) {
      this.#port.postMessage({
        kind: "response",
        id: command.id,
        ok: false,
        error: errorMessage(error),
      });
    }
  }

  dispose(): void {
    this.#session?.engine.cancel();
    this.#session = undefined;
    this.#recognizer?.value.dispose();
    this.#recognizer = undefined;
  }

  async #dispatch(
    command: DesktopTranscriptionHostCommand,
  ): Promise<LocalTranscriptionCapabilities | undefined> {
    switch (command.kind) {
      case "get-capabilities":
        return this.#getRecognizer(command.modelPath).getCapabilities();
      case "start-session":
        await this.#startSession(command.modelPath, command.input);
        return undefined;
      case "send-audio":
        this.#requireSession(command.sessionId).engine.pushAudio(float32FromBytes(command.audio));
        return undefined;
      case "stop-session": {
        const session = this.#requireSession(command.sessionId);
        await session.engine.stopAndCommit();
        if (this.#session === session) this.#session = undefined;
        return undefined;
      }
      case "cancel-session": {
        const session = this.#requireSession(command.sessionId);
        session.engine.cancel();
        if (this.#session === session) this.#session = undefined;
        return undefined;
      }
    }
  }

  async #startSession(
    modelPath: string,
    input: DesktopTranscriptionStartSessionInput,
  ): Promise<void> {
    if (this.#session !== undefined) {
      throw new Error(`A desktop transcription session is already active: ${this.#session.id}`);
    }
    const recognizer = this.#getRecognizer(modelPath);
    const engine = new ChunkedTranscriptionEngine({
      recognizer,
      onUpdate: (update) => this.#port.postMessage({ kind: "update", update }),
      onError: (error) => {
        if (this.#session?.engine === engine) {
          this.#port.postMessage({
            kind: "session-error",
            sessionId: input.sessionId,
            error: errorMessage(error),
          });
          engine.cancel();
          if (this.#session?.engine === engine) this.#session = undefined;
          return;
        }
      },
    });
    this.#session = { id: input.sessionId, engine };
    try {
      await engine.start({
        sessionId: input.sessionId,
        sampleRate: input.sampleRate,
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.promptHint === undefined ? {} : { promptHint: input.promptHint }),
      });
    } catch (error) {
      this.#session = undefined;
      throw error;
    }
  }

  #getRecognizer(modelPath: string): DesktopHostRecognizer {
    if (this.#recognizer?.modelPath === modelPath) return this.#recognizer.value;
    if (this.#session !== undefined) {
      throw new Error("Cannot change the transcription model during an active session.");
    }
    this.#recognizer?.value.dispose();
    const value = this.#createRecognizer(modelPath);
    this.#recognizer = { modelPath, value };
    return value;
  }

  #requireSession(sessionId: string) {
    const session = this.#session;
    if (session?.id !== sessionId) {
      throw new Error(`Unknown desktop transcription session: ${sessionId}`);
    }
    return session;
  }
}

const parentPort = (process as NodeJS.Process & { readonly parentPort?: ParentPort }).parentPort;

if (parentPort !== undefined) {
  const host = new DesktopTranscriptionHost({
    port: { postMessage: (message) => parentPort.postMessage(message) },
    createRecognizer: (modelPath) => new TranscribeCppRecognizer(modelPath),
  });
  parentPort.on("message", (event) => {
    void host.handle(event.data as DesktopTranscriptionHostCommand);
  });
  parentPort.start();
  process.once("exit", () => host.dispose());
}
