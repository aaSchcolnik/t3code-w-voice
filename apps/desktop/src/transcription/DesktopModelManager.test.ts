import { assert, describe, expect, it } from "@effect/vitest";

import { getModelQuant, type ModelDownloadState as CoreDownloadState } from "@t3tools/voice-core";

import {
  DesktopModelManagerImpl,
  type DesktopModelManagerDependencies,
} from "./DesktopModelManager.ts";

class FakeDownloader {
  readonly states: CoreDownloadState[];
  readonly error: Error | undefined;
  paused = false;
  cancelled = false;

  constructor(states: CoreDownloadState[], error?: Error) {
    this.states = states;
    this.error = error;
  }

  async download(
    _request: { readonly url: string; readonly bytes: number; readonly sha256?: string },
    onState: (state: CoreDownloadState) => void,
  ): Promise<CoreDownloadState> {
    for (const state of this.states) onState(state);
    if (this.error !== undefined) throw this.error;
    return this.states.at(-1)!;
  }

  pause(): void {
    this.paused = true;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

function makeFixture(files: Readonly<Record<string, number>> = {}) {
  const fileSizes = new Map(Object.entries(files));
  const fileHashes = new Map<string, string>();
  const fileRevisions = new Map([...fileSizes.keys()].map((path) => [path, 1]));
  let hashCount = 0;
  const removed: string[] = [];
  const downloaders: FakeDownloader[] = [];
  let downloaderFactory = () => {
    const downloader = new FakeDownloader([]);
    downloaders.push(downloader);
    return downloader;
  };
  const dependencies: DesktopModelManagerDependencies = {
    modelsDirectory: () => "/workspace/models",
    listDirectory: async () =>
      [...fileSizes.keys()].map((path) => path.slice(path.lastIndexOf("/") + 1)),
    stat: async (path) => {
      const size = fileSizes.get(path);
      return size === undefined
        ? undefined
        : { size, isFile: true, identity: `${path}:${fileRevisions.get(path) ?? 1}` };
    },
    sha256: async (path) => {
      hashCount += 1;
      const explicit = fileHashes.get(path);
      if (explicit !== undefined) return explicit;
      if (path.endsWith("/whisper-tiny-Q8_0.gguf")) {
        return getModelQuant("whisper-tiny", "Q8_0")!.sha256;
      }
      return "0".repeat(64);
    },
    removeFile: async (path) => {
      removed.push(path);
      fileSizes.delete(path);
      fileHashes.delete(path);
      fileRevisions.delete(path);
    },
    createDownloader: () => downloaderFactory(),
  };
  return {
    dependencies,
    fileSizes,
    removed,
    downloaders,
    get hashCount() {
      return hashCount;
    },
    setFileHash: (path: string, hash: string) => {
      fileHashes.set(path, hash);
      fileRevisions.set(path, (fileRevisions.get(path) ?? 0) + 1);
    },
    setDownloaderFactory: (factory: () => FakeDownloader) => {
      downloaderFactory = factory;
    },
  };
}

describe("DesktopModelManager", () => {
  it("surfaces sideloaded GGUF files and resolves them without trusting renderer paths", async () => {
    const fixture = makeFixture({
      "/workspace/models/acme-custom.gguf": 1234,
      "/workspace/models/readme.txt": 10,
    });
    const manager = new DesktopModelManagerImpl(fixture.dependencies);

    const custom = (await manager.getCatalog()).find((entry) => entry.id === "custom:acme-custom");
    assert.equal(custom?.quantizations[0]?.sizeBytes, 1234);
    assert.equal(
      await manager.resolveModelPath({
        modelId: "custom:acme-custom",
        quantizationId: "sideload",
      }),
      "/workspace/models/acme-custom.gguf",
    );
  });

  it("publishes queued and downloader progress without blocking the IPC command", async () => {
    const fixture = makeFixture();
    const downloader = new FakeDownloader([
      {
        status: "downloading",
        downloadedBytes: 10,
        totalBytes: 46_000_000,
      },
      {
        status: "done",
        downloadedBytes: 46_000_000,
        totalBytes: 46_000_000,
      },
    ]);
    fixture.setDownloaderFactory(() => downloader);
    const manager = new DesktopModelManagerImpl(fixture.dependencies);
    const statuses: string[] = [];
    manager.subscribe((event) => statuses.push(event.state.status));

    await manager.download({ modelId: "whisper-tiny", quantizationId: "Q8_0" });
    await manager.waitForDownloads();

    assert.deepEqual(statuses, ["queued", "downloading", "done"]);
  });

  it("converts unexpected background download failures into observable error state", async () => {
    const fixture = makeFixture();
    fixture.setDownloaderFactory(() => new FakeDownloader([], new Error("storage unavailable")));
    const manager = new DesktopModelManagerImpl(fixture.dependencies);

    await manager.download({ modelId: "whisper-tiny", quantizationId: "Q8_0" });
    await manager.waitForDownloads();

    const state = (await manager.getDownloadStates()).find(
      (candidate) => candidate.modelId === "whisper-tiny" && candidate.quantizationId === "Q8_0",
    );
    assert.deepInclude(state, {
      status: "error",
      downloadedBytes: 0,
      error: "network: storage unavailable",
    });
  });

  it("restores a partial download as paused state after restart", async () => {
    const fixture = makeFixture({
      "/workspace/models/whisper-tiny-Q8_0.gguf.part": 1024,
    });
    const manager = new DesktopModelManagerImpl(fixture.dependencies);

    const state = (await manager.getDownloadStates()).find(
      (candidate) => candidate.modelId === "whisper-tiny" && candidate.quantizationId === "Q8_0",
    );
    assert.deepInclude(state, {
      status: "paused",
      downloadedBytes: 1024,
    });
  });

  it("rejects a truncated catalog model and removes it before retrying", async () => {
    const modelPath = "/workspace/models/whisper-tiny-Q8_0.gguf";
    const fixture = makeFixture({ [modelPath]: 12 });
    const downloader = new FakeDownloader([
      {
        status: "done",
        downloadedBytes: 46_000_000,
        totalBytes: 46_000_000,
      },
    ]);
    fixture.setDownloaderFactory(() => downloader);
    const manager = new DesktopModelManagerImpl(fixture.dependencies);

    const invalid = (await manager.getDownloadStates()).find(
      (candidate) => candidate.modelId === "whisper-tiny" && candidate.quantizationId === "Q8_0",
    );
    assert.deepInclude(invalid, {
      status: "error",
      downloadedBytes: 12,
    });

    await manager.download({ modelId: "whisper-tiny", quantizationId: "Q8_0" });
    await manager.waitForDownloads();
    assert.deepEqual(fixture.removed, [modelPath]);
  });

  it("rejects a same-size catalog model whose SHA-256 does not match", async () => {
    const modelPath = "/workspace/models/whisper-tiny-Q8_0.gguf";
    const catalogSize = getModelQuant("whisper-tiny", "Q8_0")!.sizeBytes;
    const fixture = makeFixture({ [modelPath]: catalogSize });
    fixture.setFileHash(modelPath, "f".repeat(64));
    const manager = new DesktopModelManagerImpl(fixture.dependencies);

    const invalid = (await manager.getDownloadStates()).find(
      (candidate) => candidate.modelId === "whisper-tiny" && candidate.quantizationId === "Q8_0",
    );
    assert.deepInclude(invalid, {
      status: "error",
      downloadedBytes: catalogSize,
      error: "The installed file SHA-256 does not match the catalog.",
    });
    await expect(
      manager.resolveModelPath({ modelId: "whisper-tiny", quantizationId: "Q8_0" }),
    ).rejects.toThrow(/integrity check failed/u);
  });

  it("rehashes a catalog model when its file identity changes", async () => {
    const modelPath = "/workspace/models/whisper-tiny-Q8_0.gguf";
    const fixture = makeFixture({
      [modelPath]: getModelQuant("whisper-tiny", "Q8_0")!.sizeBytes,
    });
    const manager = new DesktopModelManagerImpl(fixture.dependencies);
    const target = { modelId: "whisper-tiny", quantizationId: "Q8_0" };

    assert.equal(await manager.resolveModelPath(target), modelPath);
    assert.equal(fixture.hashCount, 1);
    assert.equal(await manager.resolveModelPath(target), modelPath);
    assert.equal(fixture.hashCount, 1);

    fixture.setFileHash(modelPath, "a".repeat(64));
    await expect(manager.resolveModelPath(target)).rejects.toThrow(/SHA-256/u);
    assert.equal(fixture.hashCount, 2);
  });

  it("rejects a catalog file that changes while its hash is being computed", async () => {
    const modelPath = "/workspace/models/whisper-tiny-Q8_0.gguf";
    const quantization = getModelQuant("whisper-tiny", "Q8_0")!;
    const fixture = makeFixture({ [modelPath]: quantization.sizeBytes });
    const manager = new DesktopModelManagerImpl({
      ...fixture.dependencies,
      sha256: async () => {
        fixture.setFileHash(modelPath, "c".repeat(64));
        return quantization.sha256;
      },
    });

    const state = (await manager.getDownloadStates()).find(
      (candidate) => candidate.modelId === "whisper-tiny" && candidate.quantizationId === "Q8_0",
    );

    assert.deepInclude(state, {
      status: "error",
      error: "The installed file changed while it was being verified.",
    });
  });

  it("removes a same-size tampered file before starting a replacement download", async () => {
    const modelPath = "/workspace/models/whisper-tiny-Q8_0.gguf";
    const fixture = makeFixture({
      [modelPath]: getModelQuant("whisper-tiny", "Q8_0")!.sizeBytes,
    });
    fixture.setFileHash(modelPath, "b".repeat(64));
    const manager = new DesktopModelManagerImpl(fixture.dependencies);

    await manager.download({ modelId: "whisper-tiny", quantizationId: "Q8_0" });

    assert.deepEqual(fixture.removed, [modelPath]);
    assert.lengthOf(fixture.downloaders, 1);
  });

  it("removes only a model target resolved from the manager registry", async () => {
    const fixture = makeFixture({
      "/workspace/models/acme-custom.gguf": 1234,
    });
    const manager = new DesktopModelManagerImpl(fixture.dependencies);

    await manager.removeModel({
      modelId: "custom:acme-custom",
      quantizationId: "sideload",
    });

    assert.deepEqual(fixture.removed, ["/workspace/models/acme-custom.gguf"]);
    await expect(
      manager.removeModel({ modelId: "../../escape", quantizationId: "sideload" }),
    ).rejects.toThrow(/Unknown sideloaded voice model/u);
  });
});
