import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { ModelDownloader, type ModelDownloaderDependencies } from "./core.ts";

const chunks = async function* (...values: ReadonlyArray<Uint8Array>): AsyncGenerator<Uint8Array> {
  yield* values;
};

function memoryDependencies(
  input: {
    readonly bytes?: Uint8Array;
    readonly available?: number;
    readonly enospc?: boolean;
    readonly rejectHttp?: boolean;
    readonly chunks?: ReadonlyArray<Uint8Array>;
    readonly contentRange?: ModelDownloaderDependencies["http"] extends {
      get(...args: never[]): Promise<infer Response>;
    }
      ? Response extends { readonly contentRange?: infer Range }
        ? Range
        : never
      : never;
    readonly contentLength?: number | null;
    readonly onAbort?: () => void;
    readonly onAppend?: (chunk: Uint8Array) => void;
  } = {},
): ModelDownloaderDependencies {
  let part = input.bytes ?? new Uint8Array();
  return {
    http: {
      get: async (_url, options) => {
        if (input.rejectHttp) throw new Error("HTTP should not be called");
        options.signal.addEventListener("abort", () => input.onAbort?.(), { once: true });
        return {
          status: options.rangeStart > 0 ? 206 : 200,
          body: chunks(...(input.chunks ?? [new TextEncoder().encode("def")])),
          ...(input.contentLength === undefined ? {} : { contentLength: input.contentLength }),
          ...(input.contentRange === undefined ? {} : { contentRange: input.contentRange }),
        };
      },
    },
    storage: {
      partSize: async () => part.length,
      availableBytes: async () => input.available ?? 10_000,
      appendPart: async (chunk) => {
        input.onAppend?.(chunk);
        if (input.enospc) {
          const error = Object.assign(new Error("full"), { code: "ENOSPC" });
          throw error;
        }
        part = new Uint8Array([...part, ...chunk]);
      },
      readPart: async function* () {
        if (part.length > 0) yield part;
      },
      removePart: async () => {
        part = new Uint8Array();
      },
      renamePartToFinal: async () => {
        part = new Uint8Array();
      },
    },
    hashes: {
      createSha256: () => {
        const hash = NodeCrypto.createHash("sha256");
        return {
          update: (chunk: Uint8Array) => hash.update(chunk),
          digestHex: async () => hash.digest("hex"),
        };
      },
    },
  };
}

describe("model downloader", () => {
  it("resumes a part, validates its hash, and atomically completes", async () => {
    const prefix = new TextEncoder().encode("abc");
    const sha256 = NodeCrypto.createHash("sha256").update("abcdef").digest("hex");
    const downloader = new ModelDownloader(memoryDependencies({ bytes: prefix }));
    const state = await downloader.download(
      { url: "https://example.test/model", bytes: 6, sha256 },
      () => undefined,
    );
    expect(state.status).toBe("done");
    expect(state.downloadedBytes).toBe(6);
  });

  it("refuses insufficient space before requesting bytes", async () => {
    const downloader = new ModelDownloader(memoryDependencies({ available: 1 }));
    const state = await downloader.download(
      { url: "https://example.test/model", bytes: 100 },
      () => undefined,
    );
    expect(state.error).toBe("insufficient_space");
  });

  it("verifies and promotes a complete part after a restart without another request", async () => {
    const complete = new TextEncoder().encode("abcdef");
    const sha256 = NodeCrypto.createHash("sha256").update(complete).digest("hex");
    const downloader = new ModelDownloader(
      memoryDependencies({ bytes: complete, rejectHttp: true }),
    );

    const state = await downloader.download(
      { url: "https://example.test/model", bytes: complete.length, sha256 },
      () => undefined,
    );

    expect(state.status).toBe("done");
    expect(state.downloadedBytes).toBe(complete.length);
  });

  it("cleans partial files on ENOSPC", async () => {
    const downloader = new ModelDownloader(memoryDependencies({ enospc: true }));
    const state = await downloader.download(
      { url: "https://example.test/model", bytes: 3 },
      () => undefined,
    );
    expect(state.error).toBe("disk_full");
  });

  it("aborts before appending a chunk that exceeds the catalog byte length", async () => {
    let aborted = false;
    const appended: Uint8Array[] = [];
    const downloader = new ModelDownloader(
      memoryDependencies({
        chunks: [new TextEncoder().encode("toolong")],
        onAbort: () => {
          aborted = true;
        },
        onAppend: (chunk) => appended.push(chunk),
      }),
    );

    const state = await downloader.download(
      { url: "https://example.test/model", bytes: 3 },
      () => undefined,
    );

    expect(state).toMatchObject({ status: "error", error: "network", downloadedBytes: 0 });
    expect(aborted).toBe(true);
    expect(appended).toEqual([]);
  });

  it("rejects mismatched resumable range metadata before appending", async () => {
    const appended: Uint8Array[] = [];
    const downloader = new ModelDownloader(
      memoryDependencies({
        bytes: new TextEncoder().encode("abc"),
        contentRange: { start: 0, end: 2, total: 6 },
        onAppend: (chunk) => appended.push(chunk),
      }),
    );

    const state = await downloader.download(
      { url: "https://example.test/model", bytes: 6 },
      () => undefined,
    );

    expect(state).toMatchObject({ status: "error", error: "network", downloadedBytes: 3 });
    expect(state.message).toContain("Content-Range");
    expect(appended).toEqual([]);
  });

  it("rejects a response whose Content-Length differs from the catalog size", async () => {
    const appended: Uint8Array[] = [];
    const downloader = new ModelDownloader(
      memoryDependencies({
        contentLength: 7,
        chunks: [new TextEncoder().encode("abc")],
        onAppend: (chunk) => appended.push(chunk),
      }),
    );

    const state = await downloader.download(
      { url: "https://example.test/model", bytes: 3 },
      () => undefined,
    );

    expect(state).toMatchObject({ status: "error", error: "network", downloadedBytes: 0 });
    expect(state.message).toContain("Content-Length");
    expect(appended).toEqual([]);
  });
});
