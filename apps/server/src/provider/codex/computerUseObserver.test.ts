// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - executes generated native bootstrap files and probes the real loopback boundary.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  findUnifiedComputerUseRuntime,
  computerUseForwarderSource,
  computerUseLauncherSource,
  startComputerUseObserver,
  type ComputerUseObservation,
} from "./computerUseObserver.ts";

const { AsyncLocalStorage } = NodeAsyncHooks;
const { execFile } = NodeChildProcess;
const { mkdir, mkdtemp, readFile, rm, writeFile } = NodeFSP;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { pathToFileURL } = NodeURL;
const { promisify } = NodeUtil;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "t3-observer-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const servicePath = join(directory, "original.mjs");
  await writeFile(
    servicePath,
    `export async function handleRpc(request) {
    if (request.args?.[0]?.fail) throw new Error("original denial");
    if (request.args?.[0]?.wait) await globalThis.observerTestBarrier;
    return { method: request.method, args: request.args };
  }`,
  );
  return { directory, servicePath };
}

describe("unified computer-use discovery", () => {
  it("uses declared service exports and respects disabled plugins and explicit user servers", async () => {
    const { directory } = await fixture();
    const root = join(
      directory,
      "plugins",
      "cache",
      "openai-bundled",
      "unified-computer-use",
      "26.901.41600",
    );
    const modules = join(directory, "modules");
    const sky = join(modules, "@oai", "sky");
    await Promise.all([
      mkdir(join(root, "scripts"), { recursive: true }),
      mkdir(sky, { recursive: true }),
    ]);
    await writeFile(
      join(root, "scripts", "launch.mjs"),
      "// NODE_REPL_TRUSTED_SERVICES CUA_REPL_NODE_REPL_PATH",
    );
    await writeFile(
      join(sky, "package.json"),
      JSON.stringify({ exports: { "./service": "./service.mjs" } }),
    );
    await writeFile(join(sky, "service.mjs"), "export function handleRpc() {}");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          cua_repl: {
            command: process.execPath,
            args: [join(root, "scripts", "launch.mjs")],
            enabled_tools: ["js", "js_reset"],
            startup_timeout_sec: 120,
            env: { CUA_REPL_NODE_REPL_PATH: process.execPath, NODE_REPL_NODE_MODULE_DIRS: modules },
          },
        },
      }),
    );
    const enabled = '[plugins."unified-computer-use@openai-bundled"]\nenabled = true\n';
    await writeFile(join(directory, "config.toml"), enabled);
    const runtime = await findUnifiedComputerUseRuntime(directory);
    expect(runtime?.servicePath).toBe(join(sky, "service.mjs"));
    expect(runtime?.enabledTools).toEqual(["js", "js_reset"]);
    expect(runtime?.startupTimeoutSec).toBe(120);
    await writeFile(join(directory, "config.toml"), enabled.replace("true", "false"));
    expect(await findUnifiedComputerUseRuntime(directory)).toBeUndefined();
    await writeFile(
      join(directory, "config.toml"),
      enabled + '\n[mcp_servers.cua_repl]\ncommand = "custom-runtime"\n',
    );
    expect(await findUnifiedComputerUseRuntime(directory)).toBeUndefined();
  });
});

describe("computer-use runtime forwarding", () => {
  it("observes Linux desktop operations and drag handles without treating audio as screen sharing", async () => {
    const { directory, servicePath } = await fixture();
    const events: ComputerUseObservation[] = [];
    const observer = await startComputerUseObserver({
      runtime: {
        command: process.execPath,
        nodeReplPath: process.execPath,
        args: [],
        env: {},
        servicePath,
      },
      observe: (event) => events.push(event),
    });
    cleanup.push(observer.close);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "nodeRepl");
    Object.defineProperty(globalThis, "nodeRepl", {
      configurable: true,
      value: { requestMeta: { "x-codex-turn-metadata": { thread_id: "linux", turn_id: "turn" } } },
    });
    cleanup.push(async () => {
      if (previous) Object.defineProperty(globalThis, "nodeRepl", previous);
      else Reflect.deleteProperty(globalThis, "nodeRepl");
    });
    const modulePath = join(directory, "linux-forwarder.mjs");
    await writeFile(
      modulePath,
      computerUseForwarderSource(servicePath, observer.socketPath, observer.token, "linux"),
    );
    const forwarder = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    await forwarder.handleRpc({ type: "execute", method: "get_screenshot", args: [] });
    await forwarder.handleRpc({ type: "drag_start", handle_id: "drag", point: { x: 1, y: 2 } });
    await forwarder.handleRpc({ type: "drag_move", handle_id: "drag", point: { x: 3, y: 4 } });
    await forwarder.handleRpc({ type: "drag_end", handle_id: "drag" });
    expect(events).toHaveLength(8);
    expect(events.every((event) => event.target?.kind === "desktop")).toBe(true);
    expect(events.map((event) => event.phase)).toEqual(
      Array.from({ length: 4 }, () => ["intent", "completed"]).flat(),
    );
    await forwarder.handleRpc({ type: "execute", method: "start_audio_recording", args: [] });
    await forwarder.handleRpc({ type: "setup" });
    expect(events).toHaveLength(8);
  });

  it("reports operations during a call, preserves native child metadata and original results/errors", async () => {
    const { directory, servicePath } = await fixture();
    const events: ComputerUseObservation[] = [];
    const observer = await startComputerUseObserver({
      runtime: {
        command: process.execPath,
        nodeReplPath: process.execPath,
        args: [],
        env: {},
        servicePath,
      },
      observe: (event) => events.push(event),
    });
    cleanup.push(observer.close);
    const contexts = new AsyncLocalStorage<{ requestMeta: unknown }>();
    const runtimeGlobals = globalThis as typeof globalThis & {
      nodeRepl?: unknown;
      observerTestBarrier?: Promise<void>;
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "nodeRepl");
    Object.defineProperty(globalThis, "nodeRepl", {
      configurable: true,
      get: () => contexts.getStore(),
    });
    let release!: () => void;
    runtimeGlobals.observerTestBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(async () => {
      if (previous) Object.defineProperty(globalThis, "nodeRepl", previous);
      else delete runtimeGlobals.nodeRepl;
      delete runtimeGlobals.observerTestBarrier;
    });
    const modulePath = join(directory, "forwarder.mjs");
    await writeFile(
      modulePath,
      computerUseForwarderSource(servicePath, observer.socketPath, observer.token),
    );
    const forwarder = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    const first = contexts.run(
      { requestMeta: { "x-codex-turn-metadata": { thread_id: "child-a", turn_id: "turn-a" } } },
      () =>
        forwarder.handleRpc({
          type: "execute",
          method: "click",
          args: [{ app: "com.apple.TextEdit", wait: true }],
        }),
    );
    const second = await contexts.run(
      {
        requestMeta: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: "child-b", turn_id: "turn-b" }),
        },
      },
      () =>
        forwarder.handleRpc({
          type: "execute",
          method: "get_app_state",
          args: [{ app: "com.apple.finder" }],
        }),
    );
    expect(second).toEqual({ method: "get_app_state", args: [{ app: "com.apple.finder" }] });
    expect(
      events.filter((event) => event.phase === "completed").map((event) => event.nativeThreadId),
    ).toEqual(["child-b"]);
    release();
    await first;
    expect(
      events
        .filter((event) => event.phase === "completed")
        .map((event) => [event.nativeThreadId, event.turnId]),
    ).toEqual([
      ["child-b", "turn-b"],
      ["child-a", "turn-a"],
    ]);
    await expect(
      contexts.run(
        { requestMeta: { "x-codex-turn-metadata": { thread_id: "child-a", turn_id: "turn-a" } } },
        () =>
          forwarder.handleRpc({
            type: "execute",
            method: "click",
            args: [{ app: "denied-app", fail: true }],
          }),
      ),
    ).rejects.toThrow("original denial");
    expect(events.at(-1)?.phase).toBe("failed");
    expect(
      events
        .filter((event) => event.target?.kind === "app" && event.target.appId === "denied-app")
        .map((event) => event.phase),
    ).toEqual(["intent", "failed"]);
    expect(JSON.stringify(events)).not.toContain("wait");
  });

  it("does not break operations when observation is unavailable", async () => {
    const { directory, servicePath } = await fixture();
    const modulePath = join(directory, "forwarder-offline.mjs");
    await writeFile(
      modulePath,
      computerUseForwarderSource(
        servicePath,
        "/private/tmp/t3-observer-nonexistent.sock",
        "unavailable",
      ),
    );
    const forwarder = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "nodeRepl");
    Object.defineProperty(globalThis, "nodeRepl", {
      configurable: true,
      value: {
        requestMeta: { "x-codex-turn-metadata": { thread_id: "offline", turn_id: "offline-turn" } },
      },
    });
    cleanup.push(async () => {
      if (previous) Object.defineProperty(globalThis, "nodeRepl", previous);
      else Reflect.deleteProperty(globalThis, "nodeRepl");
    });
    expect(
      await forwarder.handleRpc({ type: "execute", method: "click", args: [{ app: "test" }] }),
    ).toEqual({ method: "click", args: [{ app: "test" }] });
  });

  it("executes the original REPL with only the sky service replaced", async () => {
    const { directory } = await fixture();
    const original = join(directory, "repl.mjs");
    const shim = join(directory, "shim.mjs");
    await writeFile(
      original,
      `#!${process.execPath}\nconsole.log(JSON.stringify({services: JSON.parse(process.env.NODE_REPL_TRUSTED_SERVICES), banner: process.env.NODE_REPL_JS_BANNER, args: process.argv.slice(2)}));`,
      { mode: 0o700 },
    );
    await writeFile(
      shim,
      computerUseLauncherSource(process.execPath, original, "/private/t3/service.mjs"),
      { mode: 0o700 },
    );
    const { stdout } = await promisify(execFile)(shim, ["argument"], {
      env: {
        ...process.env,
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
          browser: "browser-service",
          sky: "sky-service",
        }),
        NODE_REPL_JS_BANNER: "original banner",
      },
    });
    expect(JSON.parse(stdout)).toEqual({
      services: { browser: "browser-service", sky: "/private/t3/service.mjs" },
      banner: "original banner",
      args: ["argument"],
    });
  });

  it("rejects unauthenticated and invalid observation payloads", async () => {
    const { servicePath } = await fixture();
    const events: ComputerUseObservation[] = [];
    const observer = await startComputerUseObserver({
      runtime: {
        command: process.execPath,
        nodeReplPath: process.execPath,
        args: [],
        env: {},
        servicePath,
      },
      observe: (event) => events.push(event),
    });
    cleanup.push(observer.close);
    const request = (body: unknown, token?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = NodeHttp.request(
          {
            socketPath: observer.socketPath,
            path: "/observe",
            method: "POST",
            headers: token ? { authorization: `Bearer ${token}` } : {},
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        req.once("error", reject);
        req.end(JSON.stringify(body));
      });
    expect(await request({ phase: "completed", operationId: "a" })).toBe(403);
    expect(await request({ phase: "live", operationId: "a" }, observer.token)).toBe(400);
    expect(events).toEqual([]);
    expect(await readFile(join(observer.directory, "launch.mjs"), "utf8")).toContain(
      "NODE_REPL_TRUSTED_SERVICES",
    );
  });
});
