import type { ModelCatalogEntry, ModelDownloadState } from "@t3tools/contracts";
import { MODEL_CATALOG } from "@t3tools/voice-core";
import { useSyncExternalStore } from "react";

import {
  type NativeDeviceCapability,
  type NativeDownloadRemovedEvent,
  nativeTranscribeModule,
} from "./nativeTranscribeModule";

import { downloadKey, type VoiceModelSelection } from "./voiceModelSelection";

export {
  downloadKey,
  resolveVoiceModelSelection,
  type VoiceModelSelection,
} from "./voiceModelSelection";

export interface VoiceModelManagerSnapshot {
  readonly catalog: ReadonlyArray<ModelCatalogEntry>;
  readonly downloads: ReadonlyArray<ModelDownloadState>;
  readonly nativeAvailable: boolean;
  readonly initialized: boolean;
}

type Listener = () => void;

const SERVER_SNAPSHOT: VoiceModelManagerSnapshot = {
  catalog: MODEL_CATALOG,
  downloads: [],
  nativeAvailable: false,
  initialized: false,
};

class VoiceModelManager {
  private readonly listeners = new Set<Listener>();
  private readonly downloads = new Map<string, ModelDownloadState>();
  private initialized = false;
  private nativeSubscription: { remove(): void } | null = null;
  private snapshot: VoiceModelManagerSnapshot = {
    catalog: MODEL_CATALOG,
    downloads: [],
    nativeAvailable: nativeTranscribeModule() !== null,
    initialized: false,
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.initialize();
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): VoiceModelManagerSnapshot => this.snapshot;

  getServerSnapshot = (): VoiceModelManagerSnapshot => SERVER_SNAPSHOT;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const native = nativeTranscribeModule();
    if (!native) {
      this.publish();
      return;
    }
    for (const state of native.getDownloadStates()) {
      this.downloads.set(downloadKey(state.modelId, state.quantizationId), state);
    }
    this.nativeSubscription = native.addListener("onDownloadProgress", (event) => {
      if (event.kind === "removed") {
        const removed = event as NativeDownloadRemovedEvent;
        this.downloads.delete(downloadKey(removed.modelId, removed.quantizationId));
      } else {
        this.downloads.set(
          downloadKey(event.state.modelId, event.state.quantizationId),
          event.state,
        );
      }
      this.publish();
    });
    this.publish();
  }

  capability(selection: VoiceModelSelection): NativeDeviceCapability {
    const native = nativeTranscribeModule();
    if (!native) {
      return {
        allowed: false,
        reason: "On-device transcription needs an iOS development build.",
        availableMemoryMb: 0,
        physicalMemoryMb: 0,
        supportsApple7: false,
        nativeEngineAvailable: false,
      };
    }
    return native.getCapability(
      selection.quantization.minRamMb,
      selection.quantization.requiresGpuFamily,
    );
  }

  stateFor(selection: VoiceModelSelection): ModelDownloadState | undefined {
    this.initialize();
    return this.downloads.get(downloadKey(selection.model.id, selection.quantization.id));
  }

  async download(selection: VoiceModelSelection): Promise<void> {
    const native = nativeTranscribeModule();
    if (!native) throw new Error("On-device transcription is unavailable in this build.");
    await native.downloadModel(
      selection.model.id,
      selection.quantization.id,
      selection.quantization.downloadUrl,
      selection.quantization.sha256,
      selection.quantization.sizeBytes,
    );
  }

  pause(selection: VoiceModelSelection): void {
    nativeTranscribeModule()?.pauseDownload(selection.model.id, selection.quantization.id);
  }

  cancel(selection: VoiceModelSelection): void {
    nativeTranscribeModule()?.cancelDownload(selection.model.id, selection.quantization.id);
  }

  remove(selection: VoiceModelSelection): void {
    nativeTranscribeModule()?.removeModel(selection.model.id, selection.quantization.id);
  }

  private publish(): void {
    this.snapshot = {
      catalog: MODEL_CATALOG,
      downloads: [...this.downloads.values()].sort((left, right) =>
        downloadKey(left.modelId, left.quantizationId).localeCompare(
          downloadKey(right.modelId, right.quantizationId),
        ),
      ),
      nativeAvailable: nativeTranscribeModule() !== null,
      initialized: true,
    };
    for (const listener of this.listeners) listener();
  }
}

export const voiceModelManager = new VoiceModelManager();

export function useVoiceModelManager(): VoiceModelManagerSnapshot {
  return useSyncExternalStore(
    voiceModelManager.subscribe,
    voiceModelManager.getSnapshot,
    voiceModelManager.getServerSnapshot,
  );
}
