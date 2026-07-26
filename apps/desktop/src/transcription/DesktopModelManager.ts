// @effect-diagnostics nodeBuiltinImport:off - This is the concrete Node adapter for the platform-neutral model downloader.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  DesktopVoiceModelTarget,
  ModelCatalogEntry,
  ModelDownloadProgressEvent,
  ModelDownloadState,
} from "@t3tools/contracts";
import {
  MODEL_CATALOG,
  ModelDownloader,
  getModel,
  getModelDownloadUrl,
  getModelQuant,
  type ModelDownloadState as CoreModelDownloadState,
} from "@t3tools/voice-core";
import { createNodeDownloaderDependencies } from "@t3tools/voice-core/node";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

const SIDELOAD_QUANTIZATION_ID = "sideload";
const GGUF_EXTENSION = ".gguf";

interface FileInfo {
  readonly size: number;
  readonly isFile: boolean;
  readonly identity?: string;
}

interface Downloader {
  download(
    request: { readonly url: string; readonly bytes: number; readonly sha256?: string },
    onState: (state: CoreModelDownloadState) => void,
  ): Promise<CoreModelDownloadState>;
  pause(): void;
  cancel(): Promise<void>;
}

export interface DesktopModelManagerDependencies {
  readonly modelsDirectory: () => string;
  readonly listDirectory: (path: string) => Promise<readonly string[]>;
  readonly stat: (path: string) => Promise<FileInfo | undefined>;
  readonly sha256: (path: string) => Promise<string>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly createDownloader: (finalPath: string) => Downloader;
}

export const makeNodeDependencies = (
  modelsDirectory: () => string,
): DesktopModelManagerDependencies => ({
  modelsDirectory,
  listDirectory: async (path) => {
    try {
      return await NodeFSP.readdir(path);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  },
  stat: async (path) => {
    try {
      const stat = await NodeFSP.stat(path);
      return {
        size: stat.size,
        isFile: stat.isFile(),
        identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  sha256: async (path) => {
    const file = await NodeFSP.open(path, "r");
    const hash = NodeCrypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(4 * 1_048_576);
    try {
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      return hash.digest("hex");
    } finally {
      await file.close();
    }
  },
  removeFile: async (path) => {
    await NodeFSP.rm(path, { force: true });
  },
  createDownloader: (finalPath) => new ModelDownloader(createNodeDownloaderDependencies(finalPath)),
});

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

const targetKey = (target: DesktopVoiceModelTarget): string =>
  `${target.modelId}\u0000${target.quantizationId}`;

const modelFileName = (target: DesktopVoiceModelTarget): string =>
  `${target.modelId}-${target.quantizationId}${GGUF_EXTENSION}`;

const toDownloadState = (
  target: DesktopVoiceModelTarget,
  state: CoreModelDownloadState,
): ModelDownloadState => ({
  modelId: target.modelId,
  quantizationId: target.quantizationId,
  status: state.status,
  downloadedBytes: state.downloadedBytes,
  totalBytes: state.totalBytes,
  ...(state.error === undefined
    ? {}
    : { error: state.message === undefined ? state.error : `${state.error}: ${state.message}` }),
});

const customCatalogEntry = (fileName: string, sizeBytes: number): ModelCatalogEntry => {
  const id = `custom:${fileName.slice(0, -GGUF_EXTENSION.length)}`;
  return {
    id,
    displayName: fileName.slice(0, -GGUF_EXTENSION.length),
    description: "Sideloaded GGUF model",
    featured: false,
    capabilities: {
      languages: [],
      supportsLanguageDetect: false,
      supportsInitialPrompt: false,
      supportsStreaming: false,
    },
    quantizations: [
      {
        id: SIDELOAD_QUANTIZATION_ID,
        label: "Sideloaded",
        downloadUrl: `sideload://${encodeURIComponent(fileName)}`,
        sha256: "sideload",
        sizeBytes: Math.max(1, sizeBytes),
        minRamMb: 1,
      },
    ],
  };
};

/**
 * Disk-backed desktop model registry. Downloads are intentionally launched in
 * the background: renderer IPC receives progress events instead of holding one
 * invoke call open for a multi-gigabyte transfer.
 */
export class DesktopModelManagerImpl {
  readonly #dependencies: DesktopModelManagerDependencies;
  readonly #liveStates = new Map<string, ModelDownloadState>();
  readonly #downloaders = new Map<string, Downloader>();
  readonly #downloads = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(event: ModelDownloadProgressEvent) => void>();
  readonly #sideloadPaths = new Map<string, string>();
  readonly #verifiedCatalogFiles = new Map<
    string,
    { readonly identity: string; readonly digest: string }
  >();

  constructor(dependencies: DesktopModelManagerDependencies) {
    this.#dependencies = dependencies;
  }

  subscribe(listener: (event: ModelDownloadProgressEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async getCatalog(): Promise<readonly ModelCatalogEntry[]> {
    const sideloaded = await this.#scanSideloaded();
    return [...MODEL_CATALOG, ...sideloaded.map(({ entry }) => entry)];
  }

  async getDownloadStates(): Promise<readonly ModelDownloadState[]> {
    const states = new Map(this.#liveStates);
    for (const model of MODEL_CATALOG) {
      for (const quantization of model.quantizations) {
        const target = { modelId: model.id, quantizationId: quantization.id };
        const key = targetKey(target);
        const live = states.get(key);
        if (
          live !== undefined &&
          live.status !== "done" &&
          live.status !== "error" &&
          live.status !== "paused"
        ) {
          continue;
        }
        const path = this.#pathForCatalogTarget(target);
        const file = await this.#dependencies.stat(path);
        if (file?.isFile === true) {
          const integrityError = await this.#catalogIntegrityError(
            path,
            file,
            quantization.sizeBytes,
            quantization.sha256,
          );
          states.set(key, {
            ...target,
            status: integrityError === undefined ? "done" : "error",
            downloadedBytes: file.size,
            totalBytes: quantization.sizeBytes,
            ...(integrityError === undefined ? {} : { error: integrityError }),
          });
          continue;
        }
        if (live?.status === "error") continue;
        states.delete(key);
        const partial = await this.#dependencies.stat(`${path}.part`);
        if (partial?.isFile === true) {
          states.set(key, {
            ...target,
            status: "paused",
            downloadedBytes: partial.size,
            totalBytes: quantization.sizeBytes,
          });
        }
      }
    }
    for (const { entry, path, size } of await this.#scanSideloaded()) {
      const target = { modelId: entry.id, quantizationId: SIDELOAD_QUANTIZATION_ID };
      states.set(targetKey(target), {
        ...target,
        status: "done",
        downloadedBytes: size,
        totalBytes: size,
      });
      this.#sideloadPaths.set(targetKey(target), path);
    }
    return [...states.values()];
  }

  async download(target: DesktopVoiceModelTarget): Promise<void> {
    const model = getModel(target.modelId);
    const quantization = getModelQuant(target.modelId, target.quantizationId);
    if (model === undefined || quantization === undefined) {
      throw new Error(`Unknown voice model target: ${target.modelId}/${target.quantizationId}`);
    }
    const key = targetKey(target);
    if (this.#downloads.has(key)) return;
    const finalPath = this.#pathForCatalogTarget(target);
    const installed = await this.#dependencies.stat(finalPath);
    if (installed?.isFile === true) {
      const integrityError = await this.#catalogIntegrityError(
        finalPath,
        installed,
        quantization.sizeBytes,
        quantization.sha256,
      );
      if (integrityError === undefined) {
        this.#publish({
          ...target,
          status: "done",
          downloadedBytes: installed.size,
          totalBytes: quantization.sizeBytes,
        });
        return;
      }
      await this.#removeFile(finalPath);
    }

    const downloader = this.#downloaders.get(key) ?? this.#dependencies.createDownloader(finalPath);
    this.#downloaders.set(key, downloader);
    this.#publish({
      ...target,
      status: "queued",
      downloadedBytes: 0,
      totalBytes: quantization.sizeBytes,
    });
    const operation = downloader
      .download(
        {
          url: getModelDownloadUrl(model, quantization),
          bytes: quantization.sizeBytes,
          sha256: quantization.sha256,
        },
        (state) => this.#publish(toDownloadState(target, state)),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#publish({
          ...target,
          status: "error",
          downloadedBytes: 0,
          totalBytes: quantization.sizeBytes,
          error: `network: ${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => {
        this.#downloads.delete(key);
      });
    this.#downloads.set(key, operation);
  }

  async pauseDownload(target: DesktopVoiceModelTarget): Promise<void> {
    this.#downloaders.get(targetKey(target))?.pause();
  }

  async cancelDownload(target: DesktopVoiceModelTarget): Promise<void> {
    await this.#downloaders.get(targetKey(target))?.cancel();
  }

  async removeModel(target: DesktopVoiceModelTarget): Promise<void> {
    const catalogQuant = getModelQuant(target.modelId, target.quantizationId);
    const path =
      catalogQuant === undefined
        ? await this.resolveModelPath(target)
        : this.#pathForCatalogTarget(target);
    if ((await this.#dependencies.stat(path))?.isFile !== true) {
      throw new Error(`Voice model is not downloaded: ${target.modelId}/${target.quantizationId}`);
    }
    await this.#removeFile(path);
    this.#liveStates.delete(targetKey(target));
    this.#sideloadPaths.delete(targetKey(target));
  }

  async resolveModelPath(target: DesktopVoiceModelTarget): Promise<string> {
    const catalogQuant = getModelQuant(target.modelId, target.quantizationId);
    if (catalogQuant !== undefined) {
      const path = this.#pathForCatalogTarget(target);
      const file = await this.#dependencies.stat(path);
      if (file?.isFile === true) {
        const integrityError = await this.#catalogIntegrityError(
          path,
          file,
          catalogQuant.sizeBytes,
          catalogQuant.sha256,
        );
        if (integrityError === undefined) return path;
        throw new Error(
          `Voice model integrity check failed for ${target.modelId}/${target.quantizationId}: ${integrityError}`,
        );
      }
      throw new Error(`Voice model is not downloaded: ${target.modelId}/${target.quantizationId}`);
    }

    await this.#scanSideloaded();
    const path = this.#sideloadPaths.get(targetKey(target));
    if (path !== undefined) return path;
    throw new Error(`Unknown sideloaded voice model: ${target.modelId}`);
  }

  async resolvePreferredModel(
    preferred: Partial<DesktopVoiceModelTarget>,
  ): Promise<{ readonly target: DesktopVoiceModelTarget; readonly path: string }> {
    if (preferred.modelId && preferred.quantizationId) {
      const target = {
        modelId: preferred.modelId,
        quantizationId: preferred.quantizationId,
      };
      try {
        return { target, path: await this.resolveModelPath(target) };
      } catch {
        // A stale client setting falls through to an installed model.
      }
    }
    const installed = (await this.getDownloadStates()).find((state) => state.status === "done");
    if (installed === undefined) {
      throw new Error("No local voice model is installed.");
    }
    const target = {
      modelId: installed.modelId,
      quantizationId: installed.quantizationId,
    };
    return { target, path: await this.resolveModelPath(target) };
  }

  async waitForDownloads(): Promise<void> {
    await Promise.all(this.#downloads.values());
  }

  #publish(state: ModelDownloadState): void {
    this.#liveStates.set(targetKey(state), state);
    const event = { kind: "progress", state } as const;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A renderer listener cannot break the download state machine.
      }
    }
  }

  #pathForCatalogTarget(target: DesktopVoiceModelTarget): string {
    return NodePath.join(this.#dependencies.modelsDirectory(), modelFileName(target));
  }

  async #catalogIntegrityError(
    path: string,
    file: FileInfo,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<string | undefined> {
    if (file.size !== expectedSize) {
      return "The installed file size does not match the catalog.";
    }
    const cached = file.identity === undefined ? undefined : this.#verifiedCatalogFiles.get(path);
    if (cached !== undefined && cached.identity === file.identity) {
      return cached.digest === expectedSha256.toLowerCase()
        ? undefined
        : "The installed file SHA-256 does not match the catalog.";
    }
    try {
      const digest = (await this.#dependencies.sha256(path)).toLowerCase();
      const after = await this.#dependencies.stat(path);
      if (
        after?.isFile !== true ||
        after.size !== file.size ||
        (file.identity !== undefined && after.identity !== file.identity)
      ) {
        return "The installed file changed while it was being verified.";
      }
      if (file.identity !== undefined) {
        this.#verifiedCatalogFiles.set(path, { identity: file.identity, digest });
      }
      return digest === expectedSha256.toLowerCase()
        ? undefined
        : "The installed file SHA-256 does not match the catalog.";
    } catch (error) {
      return `The installed file could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  async #removeFile(path: string): Promise<void> {
    this.#verifiedCatalogFiles.delete(path);
    await this.#dependencies.removeFile(path);
  }

  async #scanSideloaded(): Promise<
    readonly { readonly entry: ModelCatalogEntry; readonly path: string; readonly size: number }[]
  > {
    const modelsDirectory = this.#dependencies.modelsDirectory();
    const knownNames = new Set(
      MODEL_CATALOG.flatMap((model) =>
        model.quantizations.map((quantization) =>
          modelFileName({ modelId: model.id, quantizationId: quantization.id }),
        ),
      ),
    );
    const results = [];
    for (const fileName of await this.#dependencies.listDirectory(modelsDirectory)) {
      if (!fileName.toLowerCase().endsWith(GGUF_EXTENSION) || knownNames.has(fileName)) continue;
      const path = NodePath.join(modelsDirectory, fileName);
      const stat = await this.#dependencies.stat(path);
      if (stat?.isFile !== true) continue;
      const entry = customCatalogEntry(fileName, stat.size);
      this.#sideloadPaths.set(
        targetKey({ modelId: entry.id, quantizationId: SIDELOAD_QUANTIZATION_ID }),
        path,
      );
      results.push({ entry, path, size: stat.size });
    }
    return results;
  }
}

export class DesktopModelManager extends Context.Service<
  DesktopModelManager,
  DesktopModelManagerImpl
>()("@t3tools/desktop/transcription/DesktopModelManager") {}

export const layer = (modelsDirectory: () => string) =>
  Layer.sync(
    DesktopModelManager,
    () => new DesktopModelManagerImpl(makeNodeDependencies(modelsDirectory)),
  );

export const layerTest = (manager: DesktopModelManagerImpl) =>
  Layer.succeed(DesktopModelManager, manager);
