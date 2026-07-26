// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Tests exercise real disk and timer boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { MODEL_CATALOG, type ModelDownloadState as CoreDownloadState } from "@t3tools/voice-core";

import {
  makeServerVoiceModelNodeDependencies,
  ServerVoiceModelManagerImpl,
} from "./ServerVoiceModelManager.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

async function makeManager(options?: {
  readonly terminalDownloadState?: CoreDownloadState;
  readonly onCreateDownloader?: () => void;
  readonly sha256File?: (path: string) => Promise<string>;
}): Promise<{
  readonly directory: string;
  readonly manager: ServerVoiceModelManagerImpl;
}> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-models-"));
  temporaryDirectories.push(directory);
  const dependencies = makeServerVoiceModelNodeDependencies(directory);
  return {
    directory,
    manager: new ServerVoiceModelManagerImpl({
      ...dependencies,
      sha256File: options?.sha256File ?? (async (path) => catalogHashForPath(path)),
      createDownloader: (finalPath) => {
        options?.onCreateDownloader?.();
        return {
          download: async (request, onState) => {
            onState({
              status: "downloading",
              downloadedBytes: Math.floor(request.bytes / 2),
              totalBytes: request.bytes,
            });
            const terminal = options?.terminalDownloadState ?? {
              status: "done",
              downloadedBytes: request.bytes,
              totalBytes: request.bytes,
            };
            if (terminal.status === "done") {
              await NodeFSP.writeFile(finalPath, new Uint8Array());
              await NodeFSP.truncate(finalPath, request.bytes);
            }
            onState(terminal);
            return terminal;
          },
          pause: () => undefined,
          cancel: async () => undefined,
        };
      },
    }),
  };
}

const firstTwoTargets = () => {
  const firstModel = MODEL_CATALOG[0]!;
  const secondModel = MODEL_CATALOG[1]!;
  return {
    first: {
      modelId: firstModel.id,
      quantizationId: firstModel.quantizations[0]!.id,
    },
    second: {
      modelId: secondModel.id,
      quantizationId: secondModel.quantizations[0]!.id,
    },
  };
};

const filename = (target: { readonly modelId: string; readonly quantizationId: string }) =>
  `${target.modelId}-${target.quantizationId}.gguf`;

const catalogHashForPath = (path: string): string => {
  const fileName = NodePath.basename(path);
  for (const model of MODEL_CATALOG) {
    for (const quantization of model.quantizations) {
      if (fileName === filename({ modelId: model.id, quantizationId: quantization.id })) {
        return quantization.sha256;
      }
    }
  }
  throw new Error(`No catalog hash for ${fileName}`);
};

async function writeInstalledModel(
  directory: string,
  target: { readonly modelId: string; readonly quantizationId: string },
): Promise<void> {
  const model = MODEL_CATALOG.find((entry) => entry.id === target.modelId)!;
  const quantization = model.quantizations.find((entry) => entry.id === target.quantizationId)!;
  const path = NodePath.join(directory, filename(target));
  await NodeFSP.writeFile(path, new Uint8Array());
  await NodeFSP.truncate(path, quantization.sizeBytes);
}

describe("ServerVoiceModelManager", () => {
  it("downloads in the background and publishes authoritative progress", async () => {
    const { manager } = await makeManager();
    const target = firstTwoTargets().first;
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event) => {
      events.push(
        event.snapshot.downloads.find((state) => state.modelId === target.modelId)!.status,
      );
    });

    const initial = await manager.download(target);
    expect(initial.downloads.some((state) => state.modelId === target.modelId)).toBe(true);
    await manager.waitForDownloads();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const finished = await manager.getSnapshot();
    unsubscribe();

    expect(finished.downloads).toContainEqual(
      expect.objectContaining({ ...target, status: "done" }),
    );
    expect(finished.selected).toEqual(target);
    expect(events).toContain("done");
  });

  it("persists selection and recovers partial downloads as paused", async () => {
    const { directory, manager } = await makeManager();
    const { first, second } = firstTwoTargets();
    const third = {
      modelId: MODEL_CATALOG[2]!.id,
      quantizationId: MODEL_CATALOG[2]!.quantizations[0]!.id,
    };
    await Promise.all([
      writeInstalledModel(directory, first),
      writeInstalledModel(directory, second),
      NodeFSP.writeFile(
        `${NodePath.join(directory, filename(third))}.part`,
        new Uint8Array([3, 4]),
      ),
    ]);
    await manager.selectModel(second);

    const restarted = new ServerVoiceModelManagerImpl({
      ...makeServerVoiceModelNodeDependencies(directory),
      sha256File: async (path) => catalogHashForPath(path),
    });
    const snapshot = await restarted.getSnapshot();

    expect(snapshot.selected).toEqual(second);
    expect(snapshot.downloads).toContainEqual(
      expect.objectContaining({ status: "paused", downloadedBytes: 2 }),
    );
  });

  it("rejects removal while a model is actively serving a session", async () => {
    const { directory, manager } = await makeManager();
    const target = firstTwoTargets().first;
    const path = NodePath.join(directory, filename(target));
    await writeInstalledModel(directory, target);
    const release = manager.markActive(path);

    await expect(manager.removeModel(target)).rejects.toMatchObject({
      _tag: "ServerVoiceModelError",
      reason: "model_in_use",
    });
    release();
    const snapshot = await manager.removeModel(target);

    expect(snapshot.downloads).not.toContainEqual(expect.objectContaining(target));
  });

  it("surfaces downloader free-space and hash failures without selecting the model", async () => {
    const target = firstTwoTargets().first;
    for (const error of ["insufficient_space", "hash_mismatch"] as const) {
      const model = MODEL_CATALOG.find((entry) => entry.id === target.modelId)!;
      const quantization = model.quantizations.find((entry) => entry.id === target.quantizationId)!;
      const { manager } = await makeManager({
        terminalDownloadState: {
          status: "error",
          downloadedBytes: 0,
          totalBytes: quantization.sizeBytes,
          error,
        },
      });

      await manager.download(target);
      await manager.waitForDownloads();
      const snapshot = await manager.getSnapshot();
      expect(snapshot.downloads).toContainEqual(
        expect.objectContaining({ ...target, status: "error", error }),
      );
      expect(snapshot.selected).toBeNull();
    }
  });

  it("treats a repeated download of an integrity-verified model as a no-op", async () => {
    let downloaderCreations = 0;
    const { manager } = await makeManager({
      onCreateDownloader: () => {
        downloaderCreations += 1;
      },
    });
    const target = firstTwoTargets().first;

    await manager.download(target);
    await manager.waitForDownloads();
    await manager.download(target);

    expect(downloaderCreations).toBe(1);
    expect((await manager.getSnapshot()).downloads).toContainEqual(
      expect.objectContaining({ ...target, status: "done" }),
    );
  });

  it("rejects same-size catalog corruption before loading the model", async () => {
    let corrupted = false;
    const { directory, manager } = await makeManager({
      sha256File: async (path) => (corrupted ? "0".repeat(64) : catalogHashForPath(path)),
    });
    const target = firstTwoTargets().first;
    await manager.download(target);
    await manager.waitForDownloads();

    corrupted = true;
    const modelPath = NodePath.join(directory, filename(target));
    await NodeFSP.writeFile(modelPath, new Uint8Array([1]), {
      flag: "r+",
    });
    await NodeFSP.utimes(modelPath, 2_000_000_000, 2_000_000_000);

    await expect(manager.resolveModelPath(target)).rejects.toMatchObject({
      _tag: "ServerVoiceModelError",
      reason: "not_downloaded",
      detail: expect.stringContaining("SHA-256"),
    });
    await expect(manager.resolveSelectedModelPath(filename(target))).rejects.toMatchObject({
      _tag: "ServerVoiceModelError",
      reason: "not_downloaded",
    });
    expect((await manager.getSnapshot()).downloads).toContainEqual(
      expect.objectContaining({ ...target, status: "error", error: "integrity_mismatch" }),
    );
  });

  it("rejects catalog and sideloaded symlinks that escape the model directory", async () => {
    const { directory, manager } = await makeManager();
    const target = firstTwoTargets().first;
    const catalog = MODEL_CATALOG.find((entry) => entry.id === target.modelId)!;
    const quantization = catalog.quantizations.find((entry) => entry.id === target.quantizationId)!;
    const outside = NodePath.join(
      NodePath.dirname(directory),
      `${NodePath.basename(directory)}.gguf`,
    );
    await NodeFSP.writeFile(outside, new Uint8Array());
    await NodeFSP.truncate(outside, quantization.sizeBytes);
    await NodeFSP.symlink(outside, NodePath.join(directory, filename(target)));
    await NodeFSP.symlink(outside, NodePath.join(directory, "custom-escape.gguf"));
    temporaryDirectories.push(outside);

    await expect(manager.resolveModelPath(target)).rejects.toMatchObject({
      _tag: "ServerVoiceModelError",
      reason: "not_downloaded",
    });
    const snapshot = await manager.getSnapshot();
    expect(snapshot.downloads).toContainEqual(
      expect.objectContaining({ ...target, status: "error", error: "unsafe_path" }),
    );
    expect(snapshot.catalog.some((entry) => entry.id === "custom:custom-escape")).toBe(false);
  });

  it("serializes snapshot fallback with an explicit model selection", async () => {
    const { directory } = await makeManager();
    const { first, second } = firstTwoTargets();
    await Promise.all([
      writeInstalledModel(directory, first),
      writeInstalledModel(directory, second),
    ]);
    const dependencies = makeServerVoiceModelNodeDependencies(directory);
    let releaseFirstWrite: (() => void) | undefined;
    let signalFirstWrite: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWrite = resolve;
    });
    const releaseWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    const manager = new ServerVoiceModelManagerImpl({
      ...dependencies,
      sha256File: async (path) => catalogHashForPath(path),
      writeTextAtomically: async (path, contents) => {
        writes += 1;
        if (writes === 1) {
          signalFirstWrite?.();
          await releaseWrite;
        }
        await dependencies.writeTextAtomically(path, contents);
      },
    });

    const snapshotRead = manager.getSnapshot();
    await firstWriteStarted;
    const explicitSelection = manager.selectModel(second);
    releaseFirstWrite?.();
    await Promise.all([snapshotRead, explicitSelection]);

    expect((await manager.getSnapshot()).selected).toEqual(second);
  });
});
