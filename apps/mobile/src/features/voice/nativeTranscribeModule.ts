import type {
  LocalTranscriptionCapabilities,
  ModelDownloadProgressEvent,
  ModelDownloadState,
  TranscriptionUpdate,
} from "@t3tools/contracts";
import { requireOptionalNativeModule } from "expo";

export interface NativeDeviceCapability {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly availableMemoryMb: number;
  readonly physicalMemoryMb: number;
  readonly supportsApple7: boolean;
  readonly nativeEngineAvailable: boolean;
}

export interface NativeAudioLevelEvent {
  readonly level: number;
}

export interface NativeAudioChunkEvent {
  readonly audio: string;
}

export interface NativeTranscriptionErrorEvent {
  readonly sessionId: string;
  readonly message: string;
}

interface NativeEventSubscription {
  remove(): void;
}

interface T3TranscribeNativeModule {
  readonly nativeVersion?: number;
  readonly transcribeCppVersion?: string;
  getDownloadStates(): ReadonlyArray<ModelDownloadState>;
  getCapability(minRamMb: number, requiresGpuFamily?: string): NativeDeviceCapability;
  downloadModel(
    modelId: string,
    quantizationId: string,
    sourceURL: string,
    sha256: string,
    totalBytes: number,
  ): Promise<void>;
  pauseDownload(modelId: string, quantizationId: string): void;
  cancelDownload(modelId: string, quantizationId: string): void;
  removeModel(modelId: string, quantizationId: string): void;
  startCapture(
    sessionId: string,
    captureMode: "local" | "captureOnly",
    modelId: string | null,
    quantizationId: string | null,
    minRamMb: number,
    requiresGpuFamily: string | null,
    language: string | null,
    promptHint: string | null,
  ): Promise<LocalTranscriptionCapabilities | null>;
  stopCapture(commit: boolean): string | null;
  cancelCapture(): void;
  addListener(
    eventName: "onTranscriptionUpdate",
    listener: (event: TranscriptionUpdate) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: "onTranscriptionError",
    listener: (event: NativeTranscriptionErrorEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: "onAudioLevel",
    listener: (event: NativeAudioLevelEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: "onAudioChunk",
    listener: (event: NativeAudioChunkEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: "onDownloadProgress",
    listener: (event: ModelDownloadProgressEvent | NativeDownloadRemovedEvent) => void,
  ): NativeEventSubscription;
}

export interface NativeDownloadRemovedEvent {
  readonly kind: "removed";
  readonly modelId: string;
  readonly quantizationId: string;
}

let cachedModule: T3TranscribeNativeModule | null | undefined;

export function nativeTranscribeModule(): T3TranscribeNativeModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    cachedModule = requireOptionalNativeModule<T3TranscribeNativeModule>("T3Transcribe");
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function hasNativeTranscribeModule(): boolean {
  return nativeTranscribeModule() !== null;
}
