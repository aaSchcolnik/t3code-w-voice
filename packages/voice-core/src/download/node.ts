// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Node-only adapters intentionally bridge platform APIs into the pure downloader core.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  DownloadHttp,
  DownloadStorage,
  HashFactory,
  IncrementalHash,
  ModelDownloaderDependencies,
} from "./core.ts";

const parseContentRange = (
  value: string | null,
): { readonly start: number; readonly end: number; readonly total: number } | null => {
  if (value === null) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total)
    ? { start, end, total }
    : null;
};

const parseContentLength = (value: string | null): number | null => {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export class NodeFetchHttp implements DownloadHttp {
  async get(url: string, options: { readonly rangeStart: number; readonly signal: AbortSignal }) {
    const response = await fetch(url, {
      ...(options.rangeStart > 0 ? { headers: { Range: `bytes=${options.rangeStart}-` } } : {}),
      signal: options.signal,
    });
    if (response.body === null) throw new Error("Download response has no body.");
    return {
      status: response.status,
      body: response.body,
      contentLength: parseContentLength(response.headers.get("content-length")),
      contentRange: parseContentRange(response.headers.get("content-range")),
    };
  }
}

export class NodeSha256 implements IncrementalHash {
  readonly #hash = NodeCrypto.createHash("sha256");

  update(chunk: Uint8Array): void {
    this.#hash.update(chunk);
  }

  async digestHex(): Promise<string> {
    return this.#hash.digest("hex");
  }
}

export const nodeHashFactory: HashFactory = { createSha256: () => new NodeSha256() };

export class NodeFileStorage implements DownloadStorage {
  readonly partPath: string;
  readonly finalPath: string;

  constructor(finalPath: string) {
    this.finalPath = finalPath;
    this.partPath = `${finalPath}.part`;
  }

  async partSize(): Promise<number> {
    try {
      return (await NodeFSP.stat(this.partPath)).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  async availableBytes(): Promise<number> {
    await NodeFSP.mkdir(NodePath.dirname(this.finalPath), { recursive: true });
    const fileSystem = await NodeFSP.statfs(NodePath.dirname(this.finalPath));
    return Number(fileSystem.bavail) * Number(fileSystem.bsize);
  }

  async appendPart(chunk: Uint8Array): Promise<void> {
    await NodeFSP.mkdir(NodePath.dirname(this.finalPath), { recursive: true });
    await NodeFSP.writeFile(this.partPath, chunk, { flag: "a" });
  }

  async *readPart(): AsyncIterable<Uint8Array> {
    try {
      for await (const chunk of NodeFS.createReadStream(this.partPath)) {
        yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async removePart(): Promise<void> {
    await NodeFSP.rm(this.partPath, { force: true });
  }

  async renamePartToFinal(): Promise<void> {
    await NodeFSP.mkdir(NodePath.dirname(this.finalPath), { recursive: true });
    await NodeFSP.rename(this.partPath, this.finalPath);
  }
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

export function createNodeDownloaderDependencies(finalPath: string): ModelDownloaderDependencies {
  return {
    http: new NodeFetchHttp(),
    storage: new NodeFileStorage(finalPath),
    hashes: nodeHashFactory,
  };
}
