export type DownloadStatus = "queued" | "downloading" | "paused" | "verifying" | "done" | "error";
export type DownloadErrorCode =
  | "network"
  | "hash_mismatch"
  | "disk_full"
  | "insufficient_space"
  | "cancelled";

export interface ModelDownloadState {
  readonly status: DownloadStatus;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly error?: DownloadErrorCode;
  readonly message?: string;
}

export interface DownloadHttpResponse {
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array>;
  /**
   * `undefined` means the adapter cannot expose Content-Length metadata.
   * `null` means it can, but the response omitted or malformed the header.
   */
  readonly contentLength?: number | null;
  /**
   * `undefined` means the adapter cannot expose Content-Range metadata.
   * `null` means it can, but the response omitted or malformed the header.
   */
  readonly contentRange?: {
    readonly start: number;
    readonly end: number;
    readonly total: number;
  } | null;
}

export interface DownloadHttp {
  get(
    url: string,
    options: { readonly rangeStart: number; readonly signal: AbortSignal },
  ): Promise<DownloadHttpResponse>;
}

export interface DownloadStorage {
  partSize(): Promise<number>;
  availableBytes(): Promise<number>;
  appendPart(chunk: Uint8Array): Promise<void>;
  readPart(): AsyncIterable<Uint8Array>;
  removePart(): Promise<void>;
  renamePartToFinal(): Promise<void>;
}

export interface IncrementalHash {
  update(chunk: Uint8Array): void;
  digestHex(): Promise<string>;
}

export interface HashFactory {
  createSha256(): IncrementalHash;
}

export interface DownloadRequest {
  readonly url: string;
  readonly bytes: number;
  /** Hash verification is mandatory whenever a catalog entry contains this value. */
  readonly sha256?: string;
}

export interface ModelDownloaderDependencies {
  readonly http: DownloadHttp;
  readonly storage: DownloadStorage;
  readonly hashes: HashFactory;
}

const isEnospc = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOSPC";

/** Platform-neutral, resumable download state machine. */
export class ModelDownloader {
  readonly #dependencies: ModelDownloaderDependencies;
  #controller: AbortController | undefined;
  #pauseRequested = false;
  #cancelRequested = false;

  constructor(dependencies: ModelDownloaderDependencies) {
    this.#dependencies = dependencies;
  }

  pause(): void {
    this.#pauseRequested = true;
    this.#controller?.abort();
  }

  async cancel(): Promise<void> {
    this.#cancelRequested = true;
    this.#controller?.abort();
    await this.#dependencies.storage.removePart();
  }

  async download(
    request: DownloadRequest,
    onState: (state: ModelDownloadState) => void,
  ): Promise<ModelDownloadState> {
    this.#pauseRequested = false;
    this.#cancelRequested = false;
    let downloadedBytes = await this.#dependencies.storage.partSize();
    if (downloadedBytes > request.bytes) {
      await this.#dependencies.storage.removePart();
      downloadedBytes = 0;
    }
    const requiredBytes = Math.ceil(request.bytes * 1.1);
    if (downloadedBytes < request.bytes) {
      const availableBytes = await this.#dependencies.storage.availableBytes();
      if (availableBytes + downloadedBytes < requiredBytes) {
        return this.#emit(onState, {
          status: "error",
          downloadedBytes,
          totalBytes: request.bytes,
          error: "insufficient_space",
        });
      }
    }

    this.#controller = new AbortController();
    let hash = this.#dependencies.hashes.createSha256();
    for await (const priorChunk of this.#dependencies.storage.readPart()) hash.update(priorChunk);
    try {
      if (downloadedBytes === request.bytes) {
        this.#emit(onState, { status: "verifying", downloadedBytes, totalBytes: request.bytes });
        if (
          request.sha256 !== undefined &&
          (await hash.digestHex()).toLowerCase() !== request.sha256.toLowerCase()
        ) {
          await this.#dependencies.storage.removePart();
          return this.#emit(onState, {
            status: "error",
            downloadedBytes: 0,
            totalBytes: request.bytes,
            error: "hash_mismatch",
          });
        }
        await this.#dependencies.storage.renamePartToFinal();
        return this.#emit(onState, { status: "done", downloadedBytes, totalBytes: request.bytes });
      }
      this.#emit(onState, { status: "downloading", downloadedBytes, totalBytes: request.bytes });
      const response = await this.#dependencies.http.get(request.url, {
        rangeStart: downloadedBytes,
        signal: this.#controller.signal,
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Download request returned ${response.status}.`);
      // A server that ignores Range must never append a full file to a partial file.
      if (downloadedBytes > 0 && response.status === 200) {
        await this.#dependencies.storage.removePart();
        downloadedBytes = 0;
        hash = this.#dependencies.hashes.createSha256();
      }
      const expectedResponseBytes = request.bytes - downloadedBytes;
      if (
        response.contentLength !== undefined &&
        (response.contentLength === null || response.contentLength !== expectedResponseBytes)
      ) {
        this.#controller.abort();
        throw new Error("Download response returned invalid Content-Length metadata.");
      }
      if (response.status === 206 && response.contentRange !== undefined) {
        const range = response.contentRange;
        if (
          range === null ||
          range.start !== downloadedBytes ||
          range.end < range.start ||
          range.end !== request.bytes - 1 ||
          range.total !== request.bytes
        ) {
          this.#controller.abort();
          throw new Error("Download response returned invalid Content-Range metadata.");
        }
        if (
          response.contentLength !== undefined &&
          response.contentLength !== range.end - range.start + 1
        ) {
          this.#controller.abort();
          throw new Error("Content-Length does not match Content-Range.");
        }
      }
      for await (const chunk of response.body) {
        if (this.#controller.signal.aborted) break;
        if (downloadedBytes + chunk.byteLength > request.bytes) {
          this.#controller.abort();
          throw new Error("Download exceeded the expected byte length.");
        }
        await this.#dependencies.storage.appendPart(chunk);
        hash.update(chunk);
        downloadedBytes += chunk.byteLength;
        this.#emit(onState, { status: "downloading", downloadedBytes, totalBytes: request.bytes });
      }
      if (this.#cancelRequested) {
        await this.#dependencies.storage.removePart();
        return this.#emit(onState, {
          status: "error",
          downloadedBytes: 0,
          totalBytes: request.bytes,
          error: "cancelled",
        });
      }
      if (this.#pauseRequested) {
        return this.#emit(onState, {
          status: "paused",
          downloadedBytes,
          totalBytes: request.bytes,
        });
      }
      if (downloadedBytes !== request.bytes)
        throw new Error("Download ended before the expected byte length.");
      this.#emit(onState, { status: "verifying", downloadedBytes, totalBytes: request.bytes });
      if (
        request.sha256 !== undefined &&
        (await hash.digestHex()).toLowerCase() !== request.sha256.toLowerCase()
      ) {
        await this.#dependencies.storage.removePart();
        return this.#emit(onState, {
          status: "error",
          downloadedBytes: 0,
          totalBytes: request.bytes,
          error: "hash_mismatch",
        });
      }
      await this.#dependencies.storage.renamePartToFinal();
      return this.#emit(onState, { status: "done", downloadedBytes, totalBytes: request.bytes });
    } catch (error) {
      if (this.#pauseRequested)
        return this.#emit(onState, {
          status: "paused",
          downloadedBytes,
          totalBytes: request.bytes,
        });
      if (this.#cancelRequested) {
        await this.#dependencies.storage.removePart();
        return this.#emit(onState, {
          status: "error",
          downloadedBytes: 0,
          totalBytes: request.bytes,
          error: "cancelled",
        });
      }
      if (isEnospc(error)) {
        await this.#dependencies.storage.removePart();
        return this.#emit(onState, {
          status: "error",
          downloadedBytes: 0,
          totalBytes: request.bytes,
          error: "disk_full",
        });
      }
      return this.#emit(onState, {
        status: "error",
        downloadedBytes,
        totalBytes: request.bytes,
        error: "network",
        message: error instanceof Error ? error.message : "Download failed.",
      });
    } finally {
      this.#controller = undefined;
    }
  }

  #emit(
    onState: (state: ModelDownloadState) => void,
    state: ModelDownloadState,
  ): ModelDownloadState {
    onState(state);
    return state;
  }
}
