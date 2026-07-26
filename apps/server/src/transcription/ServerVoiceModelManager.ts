// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Server model storage is intentionally Node-backed.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ServerVoiceModelError,
  type ModelCatalogEntry,
  type ModelDownloadState,
  type ServerVoiceModelSnapshot,
  type ServerVoiceModelStateEvent,
  type ServerVoiceModelTarget,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { SERVER_VOICE_MODELS_DIRECTORY } from "./TranscribeCppEngine.ts";

const SELECTION_FILENAME = "selection.json";
const SIDELOAD_QUANTIZATION_ID = "sideload";
const GGUF_EXTENSION = ".gguf";
const DEFAULT_TARGET: ServerVoiceModelTarget = {
  modelId: "parakeet-tdt-0.6b-v3",
  quantizationId: "Q8_0",
};

interface FileInfo {
  readonly size: number;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly device: number;
  readonly inode: number;
}

interface Downloader {
  download(
    request: { readonly url: string; readonly bytes: number; readonly sha256?: string },
    onState: (state: CoreModelDownloadState) => void,
  ): Promise<CoreModelDownloadState>;
  pause(): void;
  cancel(): Promise<void>;
}

export interface ServerVoiceModelManagerDependencies {
  readonly modelsDirectory: string;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly listDirectory: (path: string) => Promise<readonly string[]>;
  readonly stat: (path: string) => Promise<FileInfo | undefined>;
  readonly realPath: (path: string) => Promise<string | undefined>;
  readonly sha256File: (path: string) => Promise<string>;
  readonly readText: (path: string) => Promise<string | undefined>;
  readonly writeTextAtomically: (path: string, contents: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly createDownloader: (finalPath: string) => Downloader;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

export const makeServerVoiceModelNodeDependencies = (
  modelsDirectory: string,
): ServerVoiceModelManagerDependencies => ({
  modelsDirectory,
  makeDirectory: async (path) => {
    await NodeFSP.mkdir(path, { recursive: true });
  },
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
      const stat = await NodeFSP.lstat(path);
      return {
        size: stat.size,
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        device: stat.dev,
        inode: stat.ino,
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  realPath: async (path) => {
    try {
      return await NodeFSP.realpath(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  sha256File: async (path) =>
    new Promise<string>((resolve, reject) => {
      const hash = NodeCrypto.createHash("sha256");
      const stream = NodeFS.createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    }),
  readText: async (path) => {
    try {
      return await NodeFSP.readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  writeTextAtomically: async (path, contents) => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    try {
      await NodeFSP.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
      await NodeFSP.rename(temporaryPath, path);
    } finally {
      await NodeFSP.rm(temporaryPath, { force: true });
    }
  },
  removeFile: async (path) => {
    await NodeFSP.rm(path, { force: true });
  },
  createDownloader: (finalPath) => new ModelDownloader(createNodeDownloaderDependencies(finalPath)),
});

const targetKey = (target: ServerVoiceModelTarget): string =>
  `${target.modelId}\u0000${target.quantizationId}`;

const targetsEqual = (
  left: ServerVoiceModelTarget | null,
  right: ServerVoiceModelTarget | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.modelId === right.modelId &&
    left.quantizationId === right.quantizationId);

const modelFileName = (target: ServerVoiceModelTarget): string =>
  `${target.modelId}-${target.quantizationId}${GGUF_EXTENSION}`;

const toDownloadState = (
  target: ServerVoiceModelTarget,
  state: CoreModelDownloadState,
): ModelDownloadState => ({
  ...target,
  status: state.status,
  downloadedBytes: state.downloadedBytes,
  totalBytes: state.totalBytes,
  ...(state.error === undefined
    ? {}
    : { error: state.message === undefined ? state.error : `${state.error}: ${state.message}` }),
});

const customCatalogEntry = (fileName: string, sizeBytes: number): ModelCatalogEntry => ({
  id: `custom:${fileName.slice(0, -GGUF_EXTENSION.length)}`,
  displayName: fileName.slice(0, -GGUF_EXTENSION.length),
  description: "Sideloaded GGUF model on this server",
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
});

const voiceModelError = (
  reason: ServerVoiceModelError["reason"],
  detail: string,
): ServerVoiceModelError => new ServerVoiceModelError({ reason, detail });
const isServerVoiceModelError = Schema.is(ServerVoiceModelError);

function parsePersistedSelection(contents: string | undefined): ServerVoiceModelTarget | null {
  if (contents === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("selected" in parsed)
    ) {
      return null;
    }
    const selected = parsed.selected;
    if (selected === null) return null;
    if (
      typeof selected !== "object" ||
      !("modelId" in selected) ||
      typeof selected.modelId !== "string" ||
      !("quantizationId" in selected) ||
      typeof selected.quantizationId !== "string"
    ) {
      return null;
    }
    return { modelId: selected.modelId, quantizationId: selected.quantizationId };
  } catch {
    return null;
  }
}

/**
 * Server-wide model registry. Its snapshot is the source of truth for browser
 * clients; operations publish complete snapshots so reconnects and dropped
 * progress frames cannot leave the UI in an invented state.
 */
export class ServerVoiceModelManagerImpl {
  readonly #dependencies: ServerVoiceModelManagerDependencies;
  readonly #liveStates = new Map<string, ModelDownloadState>();
  readonly #downloaders = new Map<string, Downloader>();
  readonly #downloads = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(event: ServerVoiceModelStateEvent) => void>();
  readonly #sideloadPaths = new Map<string, string>();
  readonly #activePaths = new Map<string, number>();
  readonly #verifiedCatalogFiles = new Map<string, string>();
  #selected: ServerVoiceModelTarget | null = null;
  #initialized: Promise<void> | null = null;
  #selectionWrite: Promise<void> = Promise.resolve();
  #selectionTransition: Promise<void> = Promise.resolve();
  #progressPublishTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dependencies: ServerVoiceModelManagerDependencies) {
    this.#dependencies = dependencies;
  }

  subscribe(listener: (event: ServerVoiceModelStateEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async getSnapshot(): Promise<ServerVoiceModelSnapshot> {
    await this.#initialize();
    const [catalog, downloads] = await Promise.all([this.#getCatalog(), this.#getDownloadStates()]);
    return this.#withSelectionTransition(async () => {
      const doneTargets = downloads.filter((state) => state.status === "done");
      const preferredInstalled =
        this.#selected !== null &&
        doneTargets.some((state) => targetKey(state) === targetKey(this.#selected!));
      if (!preferredInstalled) {
        const fallback =
          doneTargets.find((state) => targetKey(state) === targetKey(DEFAULT_TARGET)) ??
          doneTargets[0] ??
          null;
        const nextSelected =
          fallback === null
            ? null
            : { modelId: fallback.modelId, quantizationId: fallback.quantizationId };
        if (!targetsEqual(this.#selected, nextSelected)) {
          await this.#persistSelection(nextSelected);
          this.#selected = nextSelected;
        }
      }
      return { catalog, downloads, selected: this.#selected };
    });
  }

  async download(target: ServerVoiceModelTarget): Promise<ServerVoiceModelSnapshot> {
    await this.#initialize();
    const model = getModel(target.modelId);
    const quantization = getModelQuant(target.modelId, target.quantizationId);
    if (model === undefined || quantization === undefined) {
      throw voiceModelError(
        "unknown_target",
        `Unknown server voice model: ${target.modelId}/${target.quantizationId}`,
      );
    }
    const key = targetKey(target);
    if (!this.#downloads.has(key)) {
      const finalPath = this.#pathForCatalogTarget(target);
      const existing = await this.#dependencies.stat(finalPath);
      if (existing !== undefined) {
        try {
          await this.#verifyCatalogFile(target);
          this.#liveStates.set(key, {
            ...target,
            status: "done",
            downloadedBytes: quantization.sizeBytes,
            totalBytes: quantization.sizeBytes,
          });
          return this.getSnapshot();
        } catch {
          this.#verifiedCatalogFiles.delete(key);
        }
        await this.#dependencies.removeFile(finalPath);
      }
      const downloader =
        this.#downloaders.get(key) ?? this.#dependencies.createDownloader(finalPath);
      this.#downloaders.set(key, downloader);
      this.#publishState({
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
          (state) => this.#publishState(toDownloadState(target, state)),
        )
        .then(async (state) => {
          if (state.status === "done") {
            try {
              await this.#verifyCatalogFile(target);
            } catch (error) {
              const installed = await this.#dependencies.stat(finalPath);
              this.#publishState({
                ...target,
                status: "error",
                downloadedBytes: installed?.size ?? 0,
                totalBytes: quantization.sizeBytes,
                error: isServerVoiceModelError(error)
                  ? error.detail
                  : "integrity_verification_failed",
              });
              await this.#dependencies.removeFile(finalPath);
              this.#verifiedCatalogFiles.delete(key);
              return;
            }
            await this.#withSelectionTransition(async () => {
              if (this.#selected !== null) return;
              await this.#persistSelection(target);
              this.#selected = target;
            });
          }
        })
        .catch((error: unknown) => {
          this.#publishState({
            ...target,
            status: "error",
            downloadedBytes: 0,
            totalBytes: quantization.sizeBytes,
            error: `network: ${error instanceof Error ? error.message : String(error)}`,
          });
        })
        .finally(() => {
          this.#downloads.delete(key);
          void this.#publishSnapshot();
        });
      this.#downloads.set(key, operation);
    }
    return this.getSnapshot();
  }

  async pauseDownload(target: ServerVoiceModelTarget): Promise<ServerVoiceModelSnapshot> {
    await this.#initialize();
    this.#downloaders.get(targetKey(target))?.pause();
    return this.getSnapshot();
  }

  async cancelDownload(target: ServerVoiceModelTarget): Promise<ServerVoiceModelSnapshot> {
    await this.#initialize();
    const downloader = this.#downloaders.get(targetKey(target));
    if (downloader !== undefined) {
      await downloader.cancel();
      await this.#downloads.get(targetKey(target));
    }
    await this.#dependencies.removeFile(`${this.#pathForCatalogTarget(target)}.part`);
    this.#liveStates.delete(targetKey(target));
    this.#verifiedCatalogFiles.delete(targetKey(target));
    await this.#publishSnapshot();
    return this.getSnapshot();
  }

  async removeModel(target: ServerVoiceModelTarget): Promise<ServerVoiceModelSnapshot> {
    await this.#initialize();
    const path = await this.resolveModelPath(target);
    if ((this.#activePaths.get(path) ?? 0) > 0) {
      throw voiceModelError(
        "model_in_use",
        "This model is serving an active transcription. Stop dictation before removing it.",
      );
    }
    const downloader = this.#downloaders.get(targetKey(target));
    if (downloader !== undefined) {
      await downloader.cancel();
      await this.#downloads.get(targetKey(target));
    }
    await Promise.all([
      this.#dependencies.removeFile(path),
      this.#dependencies.removeFile(`${path}.part`),
    ]);
    this.#liveStates.delete(targetKey(target));
    this.#sideloadPaths.delete(targetKey(target));
    await this.#withSelectionTransition(async () => {
      if (!targetsEqual(this.#selected, target)) return;
      await this.#persistSelection(null);
      this.#selected = null;
    });
    await this.#publishSnapshot();
    return this.getSnapshot();
  }

  async selectModel(target: ServerVoiceModelTarget): Promise<ServerVoiceModelSnapshot> {
    await this.#initialize();
    await this.resolveModelPath(target);
    await this.#withSelectionTransition(async () => {
      await this.#persistSelection(target);
      this.#selected = target;
    });
    await this.#publishSnapshot();
    return this.getSnapshot();
  }

  async resolveSelectedModelPath(preferredFilename?: string): Promise<string> {
    await this.#initialize();
    if (preferredFilename !== undefined && preferredFilename.length > 0) {
      if (
        preferredFilename !== NodePath.basename(preferredFilename) ||
        !preferredFilename.toLowerCase().endsWith(GGUF_EXTENSION)
      ) {
        throw voiceModelError(
          "invalid_selection",
          "T3_TRANSCRIBE_CPP_MODEL must name a GGUF file inside the server model directory.",
        );
      }
      const path = NodePath.join(this.#dependencies.modelsDirectory, preferredFilename);
      for (const model of MODEL_CATALOG) {
        const quantization = model.quantizations.find(
          (entry) =>
            modelFileName({ modelId: model.id, quantizationId: entry.id }) === preferredFilename,
        );
        if (quantization !== undefined) {
          return this.#verifyCatalogFile({
            modelId: model.id,
            quantizationId: quantization.id,
          });
        }
      }
      if ((await this.#safeFileInfo(path)) === undefined) {
        throw voiceModelError(
          "not_downloaded",
          `Selected server voice model is not downloaded: ${preferredFilename}`,
        );
      }
      return path;
    }
    const snapshot = await this.getSnapshot();
    if (snapshot.selected === null) {
      throw voiceModelError(
        "not_downloaded",
        `No transcribe.cpp model is installed in ${this.#dependencies.modelsDirectory}`,
      );
    }
    return this.resolveModelPath(snapshot.selected);
  }

  /**
   * Revalidates containment at the native loader boundary. Selection scans are
   * not sufficient because a file can be replaced between discovery and load.
   */
  async validateModelPathForLoad(path: string): Promise<void> {
    await this.#initialize();
    if ((await this.#safeFileInfo(path)) === undefined) {
      throw voiceModelError(
        "not_downloaded",
        "The selected server voice model has an unsafe path.",
      );
    }
    const fileName = NodePath.basename(path);
    for (const model of MODEL_CATALOG) {
      for (const quantization of model.quantizations) {
        const target = { modelId: model.id, quantizationId: quantization.id };
        if (modelFileName(target) !== fileName) continue;
        const verified = await this.#verifyCatalogFile(target);
        if (NodePath.resolve(verified) !== NodePath.resolve(path)) {
          throw voiceModelError(
            "not_downloaded",
            "The selected server voice model changed before loading.",
          );
        }
        return;
      }
    }
  }

  async resolveModelPath(target: ServerVoiceModelTarget): Promise<string> {
    const catalogQuantization = getModelQuant(target.modelId, target.quantizationId);
    if (catalogQuantization !== undefined) {
      return this.#verifyCatalogFile(target);
    }
    await this.#scanSideloaded();
    const path = this.#sideloadPaths.get(targetKey(target));
    if (path !== undefined) return path;
    throw voiceModelError(
      "unknown_target",
      `Unknown server voice model: ${target.modelId}/${target.quantizationId}`,
    );
  }

  markActive(path: string): () => void {
    this.#activePaths.set(path, (this.#activePaths.get(path) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#activePaths.get(path) ?? 1) - 1;
      if (remaining <= 0) this.#activePaths.delete(path);
      else this.#activePaths.set(path, remaining);
    };
  }

  async waitForDownloads(): Promise<void> {
    await Promise.all(this.#downloads.values());
  }

  async #initialize(): Promise<void> {
    if (this.#initialized === null) {
      this.#initialized = (async () => {
        await this.#dependencies.makeDirectory(this.#dependencies.modelsDirectory);
        this.#selected = parsePersistedSelection(
          await this.#dependencies.readText(this.#selectionPath()),
        );
      })();
    }
    await this.#initialized;
  }

  async #getCatalog(): Promise<readonly ModelCatalogEntry[]> {
    const sideloaded = await this.#scanSideloaded();
    return [...MODEL_CATALOG, ...sideloaded.map(({ entry }) => entry)];
  }

  async #getDownloadStates(): Promise<readonly ModelDownloadState[]> {
    const states = new Map(this.#liveStates);
    const fileNames = new Set(
      await this.#dependencies.listDirectory(this.#dependencies.modelsDirectory),
    );
    for (const model of MODEL_CATALOG) {
      for (const quantization of model.quantizations) {
        const target = { modelId: model.id, quantizationId: quantization.id };
        const key = targetKey(target);
        if (states.get(key)?.status !== "done" && states.has(key)) continue;
        const fileName = modelFileName(target);
        if (fileNames.has(fileName)) {
          const path = NodePath.join(this.#dependencies.modelsDirectory, fileName);
          const file = await this.#dependencies.stat(path);
          if (file !== undefined) {
            let integrityError: string | undefined;
            if (file.isFile && !file.isSymbolicLink && file.size === quantization.sizeBytes) {
              try {
                await this.#verifyCatalogFile(target);
              } catch {
                integrityError = "integrity_mismatch";
              }
            }
            const done =
              integrityError === undefined &&
              file.isFile &&
              !file.isSymbolicLink &&
              file.size === quantization.sizeBytes;
            states.set(key, {
              ...target,
              status: done ? "done" : "error",
              downloadedBytes: file.size,
              totalBytes: quantization.sizeBytes,
              ...(done
                ? {}
                : {
                    error:
                      integrityError ?? (file.isSymbolicLink ? "unsafe_path" : "size_mismatch"),
                  }),
            });
          }
        } else if (states.get(key)?.status === "done") {
          states.delete(key);
        } else if (fileNames.has(`${fileName}.part`)) {
          const partial = await this.#dependencies.stat(
            NodePath.join(this.#dependencies.modelsDirectory, `${fileName}.part`),
          );
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

  #publishState(state: ModelDownloadState): void {
    this.#liveStates.set(targetKey(state), state);
    if (this.#progressPublishTimer !== undefined) return;
    this.#progressPublishTimer = setTimeout(() => {
      this.#progressPublishTimer = undefined;
      void this.#publishSnapshot();
    }, 100);
    this.#progressPublishTimer.unref?.();
  }

  async #publishSnapshot(): Promise<void> {
    let snapshot: ServerVoiceModelSnapshot;
    try {
      snapshot = await this.getSnapshot();
    } catch {
      return;
    }
    const event = { kind: "state", snapshot } as const;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected client cannot disrupt the server download state machine.
      }
    }
  }

  async #persistSelection(selected: ServerVoiceModelTarget | null): Promise<void> {
    const contents = `${JSON.stringify({ version: 1, selected }, null, 2)}\n`;
    const write = () => this.#dependencies.writeTextAtomically(this.#selectionPath(), contents);
    this.#selectionWrite = this.#selectionWrite.then(write, write);
    await this.#selectionWrite;
  }

  async #withSelectionTransition<A>(operation: () => Promise<A>): Promise<A> {
    const current = this.#selectionTransition.then(operation, operation);
    this.#selectionTransition = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  #selectionPath(): string {
    return NodePath.join(this.#dependencies.modelsDirectory, SELECTION_FILENAME);
  }

  #pathForCatalogTarget(target: ServerVoiceModelTarget): string {
    const filename = modelFileName(target);
    if (filename !== NodePath.basename(filename)) {
      throw voiceModelError("unknown_target", "Voice model target contains an unsafe path.");
    }
    return NodePath.join(this.#dependencies.modelsDirectory, filename);
  }

  async #scanSideloaded(): Promise<
    readonly { readonly entry: ModelCatalogEntry; readonly path: string; readonly size: number }[]
  > {
    this.#sideloadPaths.clear();
    const knownNames = new Set(
      MODEL_CATALOG.flatMap((model) =>
        model.quantizations.map((quantization) =>
          modelFileName({ modelId: model.id, quantizationId: quantization.id }),
        ),
      ),
    );
    const results = [];
    for (const fileName of await this.#dependencies.listDirectory(
      this.#dependencies.modelsDirectory,
    )) {
      if (
        fileName !== NodePath.basename(fileName) ||
        !fileName.toLowerCase().endsWith(GGUF_EXTENSION) ||
        knownNames.has(fileName)
      ) {
        continue;
      }
      const path = NodePath.join(this.#dependencies.modelsDirectory, fileName);
      const stat = await this.#safeFileInfo(path);
      if (stat === undefined) continue;
      const entry = customCatalogEntry(fileName, stat.size);
      this.#sideloadPaths.set(
        targetKey({ modelId: entry.id, quantizationId: SIDELOAD_QUANTIZATION_ID }),
        path,
      );
      results.push({ entry, path, size: stat.size });
    }
    return results;
  }

  async #safeFileInfo(path: string): Promise<FileInfo | undefined> {
    const stat = await this.#dependencies.stat(path);
    if (stat?.isFile !== true || stat.isSymbolicLink) return undefined;
    const [modelsRoot, resolved] = await Promise.all([
      this.#dependencies.realPath(this.#dependencies.modelsDirectory),
      this.#dependencies.realPath(path),
    ]);
    if (modelsRoot === undefined || resolved === undefined) return undefined;
    const relative = NodePath.relative(modelsRoot, resolved);
    if (
      relative === "" ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    ) {
      return undefined;
    }
    return stat;
  }

  async #verifyCatalogFile(target: ServerVoiceModelTarget): Promise<string> {
    const quantization = getModelQuant(target.modelId, target.quantizationId);
    if (quantization === undefined) {
      throw voiceModelError(
        "unknown_target",
        `Unknown server voice model: ${target.modelId}/${target.quantizationId}`,
      );
    }
    const path = this.#pathForCatalogTarget(target);
    const file = await this.#safeFileInfo(path);
    if (file === undefined) {
      throw voiceModelError(
        "not_downloaded",
        `Server voice model is missing or has an unsafe path: ${target.modelId}/${target.quantizationId}`,
      );
    }
    if (file.size !== quantization.sizeBytes) {
      throw voiceModelError(
        "not_downloaded",
        `Server voice model has an invalid byte size: ${target.modelId}/${target.quantizationId}`,
      );
    }
    const fingerprint = `${file.device}:${file.inode}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
    const key = targetKey(target);
    if (this.#verifiedCatalogFiles.get(key) === fingerprint) return path;
    const digest = (await this.#dependencies.sha256File(path)).toLowerCase();
    if (digest !== quantization.sha256.toLowerCase()) {
      throw voiceModelError(
        "not_downloaded",
        `Server voice model failed SHA-256 verification: ${target.modelId}/${target.quantizationId}`,
      );
    }
    const verifiedAgain = await this.#safeFileInfo(path);
    if (
      verifiedAgain === undefined ||
      `${verifiedAgain.device}:${verifiedAgain.inode}:${verifiedAgain.size}:${verifiedAgain.mtimeMs}:${verifiedAgain.ctimeMs}` !==
        fingerprint
    ) {
      throw voiceModelError(
        "not_downloaded",
        `Server voice model changed during SHA-256 verification: ${target.modelId}/${target.quantizationId}`,
      );
    }
    this.#verifiedCatalogFiles.set(key, fingerprint);
    return path;
  }
}

export class ServerVoiceModelManager extends Context.Service<
  ServerVoiceModelManager,
  ServerVoiceModelManagerImpl
>()("t3/transcription/ServerVoiceModelManager") {}

export const layer = Layer.effect(
  ServerVoiceModelManager,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const modelsDirectory = NodePath.join(config.stateDir, SERVER_VOICE_MODELS_DIRECTORY);
    return new ServerVoiceModelManagerImpl(makeServerVoiceModelNodeDependencies(modelsDirectory));
  }),
);
