// @effect-diagnostics nodeBuiltinImport:off - private Node REPL bootstrap and loopback transport are also exercised outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Schema from "effect/Schema";

const { randomUUID, timingSafeEqual } = NodeCrypto;
const { access, chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } = NodeFSP;
const { createServer } = NodeHttp;
const { tmpdir } = NodeOS;
const { delimiter, isAbsolute, join } = NodePath;
const { pathToFileURL } = NodeURL;

const ShortString = Schema.String.check(Schema.isMaxLength(1024));
const Target = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("app"),
    appId: ShortString,
    appName: Schema.optionalKey(ShortString),
  }),
  Schema.Struct({ kind: Schema.Literal("desktop") }),
]);
const Observation = Schema.Struct({
  operationId: ShortString,
  nativeThreadId: Schema.optionalKey(ShortString),
  turnId: Schema.optionalKey(ShortString),
  phase: Schema.Literals(["intent", "completed", "failed"]),
  target: Schema.optionalKey(Target),
  message: Schema.optionalKey(ShortString),
});
export type ComputerUseObservation = typeof Observation.Type;
const decodeObservation = Schema.decodeUnknownSync(Observation);
const McpConfiguration = Schema.Struct({
  mcpServers: Schema.Struct({
    cua_repl: Schema.Struct({
      command: Schema.String,
      args: Schema.Array(Schema.String),
      enabled: Schema.optionalKey(Schema.Boolean),
      enabled_tools: Schema.optionalKey(Schema.Array(Schema.String)),
      disabled_tools: Schema.optionalKey(Schema.Array(Schema.String)),
      startup_timeout_sec: Schema.optionalKey(Schema.Number),
      tool_timeout_sec: Schema.optionalKey(Schema.Number),
      env: Schema.Record(Schema.String, Schema.String),
    }),
  }),
});
const decodeMcp = Schema.decodeUnknownSync(McpConfiguration);
const decodeSkyManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    exports: Schema.Struct({ "./service": Schema.String }),
  }),
);

export interface UnifiedComputerUseRuntime {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly servicePath: string;
  readonly nodeReplPath: string;
  readonly enabledTools?: ReadonlyArray<string>;
  readonly disabledTools?: ReadonlyArray<string>;
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
}

/** Only an explicitly enabled installation is eligible for an observation override. */
export async function findUnifiedComputerUseRuntime(
  homePath: string,
): Promise<UnifiedComputerUseRuntime | undefined> {
  try {
    const config = await readFile(join(homePath, "config.toml"), "utf8");
    if (/^\[mcp_servers\.(?:cua_repl|"cua_repl")\]/m.test(config)) return undefined;
    const pluginSection = config.match(
      /^\[plugins\."unified-computer-use@openai-bundled"\]\s*\n([^]*?)(?=^\[|$)/m,
    )?.[1];
    if (!pluginSection || !/^enabled\s*=\s*true\s*(?:#.*)?$/m.test(pluginSection)) return undefined;
    const cache = join(homePath, "plugins", "cache", "openai-bundled", "unified-computer-use");
    const versions = (await readdir(cache)).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    for (const version of versions) {
      try {
        const root = await realpath(join(cache, version));
        const { cua_repl: mcp } = decodeMcp(
          JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")),
        ).mcpServers;
        const nodeReplPath = mcp.env.CUA_REPL_NODE_REPL_PATH;
        if (
          mcp.enabled === false ||
          !nodeReplPath ||
          !isAbsolute(nodeReplPath) ||
          !isAbsolute(mcp.command)
        )
          continue;
        const launcherPath = mcp.args[0];
        if (
          mcp.args.length !== 1 ||
          !launcherPath ||
          (await realpath(launcherPath)) !== join(root, "scripts", "launch.mjs")
        )
          continue;
        const launcher = await readFile(launcherPath, "utf8");
        if (
          !launcher.includes("NODE_REPL_TRUSTED_SERVICES") ||
          !launcher.includes("CUA_REPL_NODE_REPL_PATH")
        )
          continue;
        for (const moduleDirectory of (mcp.env.NODE_REPL_NODE_MODULE_DIRS ?? "").split(delimiter)) {
          if (!isAbsolute(moduleDirectory)) continue;
          const packageDirectory = join(moduleDirectory, "@oai", "sky");
          try {
            const manifest = decodeSkyManifest(
              JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")),
            );
            const serviceExport = manifest.exports["./service"];
            if (!serviceExport.startsWith("./") || serviceExport.split("/").includes(".."))
              continue;
            const servicePath = join(packageDirectory, serviceExport);
            const service = await readFile(servicePath, "utf8");
            if (!service.includes("handleRpc")) continue;
            await Promise.all([access(mcp.command), access(nodeReplPath)]);
            return {
              command: mcp.command,
              args: mcp.args,
              env: mcp.env,
              servicePath,
              nodeReplPath,
              ...(mcp.enabled_tools ? { enabledTools: mcp.enabled_tools } : {}),
              ...(mcp.disabled_tools ? { disabledTools: mcp.disabled_tools } : {}),
              ...(mcp.startup_timeout_sec !== undefined
                ? { startupTimeoutSec: mcp.startup_timeout_sec }
                : {}),
              ...(mcp.tool_timeout_sec !== undefined
                ? { toolTimeoutSec: mcp.tool_timeout_sec }
                : {}),
            };
          } catch {
            /* This module directory does not contain a supported Sky service. */
          }
        }
      } catch {
        /* An old or partial cached version must not prevent provider startup. */
      }
    }
  } catch {
    /* Computer use is optional. */
  }
  return undefined;
}

/** Runs in the trusted service process. Only metadata is sent, never tool arguments or screenshots. */
export function computerUseForwarderSource(
  servicePath: string,
  socketPath: string,
  token: string,
  platform?: NodeJS.Platform,
): string {
  return `import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { handleRpc as delegate } from ${JSON.stringify(pathToFileURL(servicePath).href)};
const socketPath = ${JSON.stringify(socketPath)};
const token = ${JSON.stringify(token)};
const platform = ${platform ? JSON.stringify(platform) : "process.platform"};
const short = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 1024) : undefined;
async function report(event) {
  try {
    await new Promise(resolve => {
      const request = httpRequest({ socketPath, path: "/observe", method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" } }, response => {
        response.resume();
        response.once("end", resolve);
        response.once("error", resolve);
      });
      request.once("error", resolve);
      request.setTimeout(250, () => { request.destroy(); resolve(); });
      request.end(JSON.stringify(event));
    });
  } catch { /* Observation failures never prevent computer use. */ }
}
export async function handleRpc(request) {
  if (request?.type !== "execute" && !["drag_start", "drag_move", "drag_end"].includes(request?.type)) return delegate(request);
  let meta = globalThis.nodeRepl?.requestMeta?.["x-codex-turn-metadata"];
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = undefined; } }
  const nativeThreadId = short(meta?.thread_id ?? meta?.threadId ?? meta?.session_id);
  const turnId = short(meta?.turn_id);
  if (!nativeThreadId || !turnId) return delegate(request);
  const operationId = randomUUID();
  const arg = request?.args?.[0];
  const app = short(arg?.app);
  const desktopOperation = platform === "linux" &&
    (request.type !== "execute" || ["get_screenshot", "click", "drag", "move", "press_key", "scroll", "type_text"].includes(request.method));
  if (!app && !desktopOperation) return delegate(request);
  const target = app ? { kind: "app", appId: app } : { kind: "desktop" };
  const event = { operationId, nativeThreadId, turnId, ...(target ? { target } : {}) };
  await report({ ...event, phase: "intent" });
  try {
    const result = await delegate(request);
    await report({ ...event, phase: "completed" });
    return result;
  } catch (error) {
    await report({ ...event, phase: "failed", message: "Computer use did not complete this operation." });
    throw error;
  }
}
`;
}

export function computerUseLauncherSource(
  nodePath: string,
  nodeReplPath: string,
  forwarderPath: string,
): string {
  return `#!${nodePath}
import { spawn } from "node:child_process";
const env = { ...process.env };
try {
  const services = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES ?? "{}");
  if (services.sky) services.sky = ${JSON.stringify(forwarderPath)};
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify(services);
} catch { /* Preserve execution if an unsupported launcher changes the configuration. */ }
const child = spawn(${JSON.stringify(nodeReplPath)}, process.argv.slice(2), { env, stdio: "inherit" });
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = signal => child.kill(signal);
for (const signal of signals) process.on(signal, forward);
child.once("error", error => { console.error("Computer-use runtime could not start:", error.message); process.exitCode = 1; });
child.once("close", (code, signal) => {
  for (const name of signals) process.off(name, forward);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;
}

export async function startComputerUseObserver(input: {
  readonly runtime: UnifiedComputerUseRuntime;
  readonly observe: (event: ComputerUseObservation) => void;
}) {
  const directory = await mkdtemp(join(tmpdir(), "t3-computer-use-"));
  const token = randomUUID();
  const server = createServer((request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      request.method !== "POST" ||
      request.url !== "/observe" ||
      authorization.length !== expected.length ||
      !timingSafeEqual(authorization, expected)
    ) {
      response.writeHead(403).end();
      request.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > 8192) return;
      try {
        const event = decodeObservation(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        input.observe(event);
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
    request.on("error", () => response.destroy());
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  try {
    await chmod(directory, 0o700);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(directory, "s"), () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.unref();
    const socketPath = join(directory, "s");
    await chmod(socketPath, 0o600);
    const forwarder = join(directory, "service.mjs");
    const launcherScript = join(directory, "launch.mjs");
    const launcher = join(directory, "node-repl");
    await writeFile(
      forwarder,
      computerUseForwarderSource(input.runtime.servicePath, socketPath, token),
      { mode: 0o600 },
    );
    await writeFile(
      launcherScript,
      computerUseLauncherSource(input.runtime.command, input.runtime.nodeReplPath, forwarder),
      { mode: 0o700 },
    );
    const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${shellQuote(input.runtime.command)} ${shellQuote(launcherScript)} "$@"\n`,
      { mode: 0o700 },
    );
    const env = {
      ...input.runtime.env,
      CUA_REPL_NODE_REPL_PATH: launcher,
      NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: [
        input.runtime.env.NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS,
        socketPath,
      ]
        .filter(Boolean)
        .join(delimiter),
      NODE_REPL_TRUSTED_CODE_PATHS: [input.runtime.env.NODE_REPL_TRUSTED_CODE_PATHS, directory]
        .filter(Boolean)
        .join(delimiter),
    };
    const configArgs = [
      "-c",
      `mcp_servers.cua_repl.command=${JSON.stringify(input.runtime.command)}`,
      "-c",
      `mcp_servers.cua_repl.args=${JSON.stringify(input.runtime.args)}`,
      ...(input.runtime.enabledTools
        ? ["-c", `mcp_servers.cua_repl.enabled_tools=${JSON.stringify(input.runtime.enabledTools)}`]
        : []),
      ...(input.runtime.disabledTools
        ? [
            "-c",
            `mcp_servers.cua_repl.disabled_tools=${JSON.stringify(input.runtime.disabledTools)}`,
          ]
        : []),
      ...(input.runtime.startupTimeoutSec !== undefined
        ? ["-c", `mcp_servers.cua_repl.startup_timeout_sec=${input.runtime.startupTimeoutSec}`]
        : []),
      ...(input.runtime.toolTimeoutSec !== undefined
        ? ["-c", `mcp_servers.cua_repl.tool_timeout_sec=${input.runtime.toolTimeoutSec}`]
        : []),
      ...Object.entries(env).flatMap(([key, value]) => [
        "-c",
        `mcp_servers.cua_repl.env.${key}=${JSON.stringify(value)}`,
      ]),
    ];
    return {
      configArgs,
      directory,
      socketPath,
      token,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
