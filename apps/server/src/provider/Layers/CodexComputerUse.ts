import * as NodeURL from "node:url";

import {
  type CodexSettings,
  ComputerUseDiagnosticMetadata as ComputerUseDiagnosticMetadataSchema,
  type ComputerUseDiagnosticMetadata,
  type ComputerUseNodeReplState,
  type ComputerUseProviderStatus,
  type ComputerUseRemediation,
  type ComputerUseSkillState,
  type ComputerUseTestFailureCategory,
  type ComputerUseTestResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  deriveComputerUseProviderStatus,
  type ComputerUseCapabilityShape,
  type ComputerUseReadinessFacts,
} from "../computerUseCapability.ts";
import { makeInitializedCodexAppServerClient } from "./CodexProvider.ts";

const COMPUTER_USE_SKILL_NAME = "computer-use";
const NODE_REPL_SERVER_NAME = "node_repl";
const NODE_REPL_TOOL_NAME = "js";
const DIAGNOSTIC_MARKER = "T3_COMPUTER_USE_DIAGNOSTIC:";
const COMPUTER_USE_HOST_APP_NAMES = ["ChatGPT.app", "Codex.app"] as const;
const HOST_KIND_ENV_VAR = "T3CODE_COMPUTER_USE_HOST_KIND";
const HOST_BUNDLE_ID_ENV_VAR = "T3CODE_COMPUTER_USE_HOST_BUNDLE_ID";
const T3_PACKAGED_BUNDLE_ID = "com.t3tools.t3code";
const T3_DEV_BUNDLE_ID_PREFIX = "com.t3tools.t3code.dev";
// An unpackaged Electron binary reports Electron's default bundle identity,
// so dev candidates matched this way must be verified by window content.
const GENERIC_ELECTRON_BUNDLE_ID = "com.github.Electron";

export interface ComputerUseHostContext {
  readonly kind: "t3-packaged" | "t3-electron-dev" | "unknown";
  readonly bundleId: string | undefined;
}

const DiagnosticPayload = Schema.Struct({
  failureCategory: Schema.NullOr(
    Schema.Literals([
      "runtime-initialization-failed",
      "app-discovery-failed",
      "target-app-not-found",
      "accessibility-permission-denied",
      "accessibility-unavailable",
      "screen-recording-permission-denied",
      "screenshot-unavailable",
      "native-service-failed",
      "unknown",
    ]),
  ),
  metadata: Schema.Struct({
    ...ComputerUseDiagnosticMetadataSchema.fields,
  }),
});
type DiagnosticPayload = typeof DiagnosticPayload.Type;
const decodeDiagnosticPayload = Schema.decodeUnknownOption(DiagnosticPayload, {
  onExcessProperty: "error",
});

interface ComputerUseInventory {
  readonly facts: ComputerUseReadinessFacts;
  readonly wrapperPath: string | undefined;
}

export function buildComputerUseAppServerInput(input: {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) {
  return {
    binaryPath: input.config.binaryPath,
    homePath: input.config.homePath,
    cwd: input.cwd,
    environment: input.environment,
  } as const;
}

export function buildComputerUseHostAppPaths(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  return COMPUTER_USE_HOST_APP_NAMES.flatMap((appName) => [
    `/Applications/${appName}`,
    ...(environment.HOME ? [`${environment.HOME}/Applications/${appName}`] : []),
  ]);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function inspectNodeReplState(input: {
  readonly config: CodexSchema.V2ConfigReadResponse;
  readonly mcpStatus: CodexSchema.V2ListMcpServerStatusResponse;
}): ComputerUseNodeReplState {
  const servers = asRecord(input.config.config["mcp_servers"]);
  const nodeReplConfig = servers?.[NODE_REPL_SERVER_NAME];
  if (nodeReplConfig === undefined) return "missing";
  if (asRecord(nodeReplConfig)?.["enabled"] === false) return "disabled";

  const status = input.mcpStatus.data.find((server) => server.name === NODE_REPL_SERVER_NAME);
  if (!status) return "startup-failed";
  return status.tools[NODE_REPL_TOOL_NAME] ? "available" : "tool-missing";
}

// Newer Codex app-servers namespace plugin-provided skills as
// "<plugin>:<skill>" (observed: "computer-use:computer-use"); older ones
// return the bare "computer-use". Qualified names from other plugins are
// rejected unless their path provenance identifies the Computer Use plugin.
export function isComputerUseSkill(skill: {
  readonly name: string;
  readonly path: string;
}): boolean {
  if (skill.name === COMPUTER_USE_SKILL_NAME) return true;
  const separatorIndex = skill.name.lastIndexOf(":");
  if (separatorIndex < 0) return false;
  if (skill.name.slice(separatorIndex + 1) !== COMPUTER_USE_SKILL_NAME) return false;
  const pluginRoot = pluginRootFromSkillPath(skill.path);
  return pluginRoot !== undefined && pluginRoot.split("/").includes(COMPUTER_USE_SKILL_NAME);
}

export function findComputerUseSkill(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): CodexSchema.V2SkillsListResponse__SkillMetadata | undefined {
  const entries = response.data.filter((entry) => entry.cwd === cwd);
  const candidates = (entries.length > 0 ? entries : response.data).flatMap(
    (entry) => entry.skills,
  );
  return candidates.find(isComputerUseSkill);
}

function skillState(
  skill: CodexSchema.V2SkillsListResponse__SkillMetadata | undefined,
): ComputerUseSkillState {
  return skill === undefined ? "missing" : skill.enabled ? "available" : "disabled";
}

function pluginRootFromSkillPath(skillPath: string): string | undefined {
  const normalized = skillPath.replaceAll("\\", "/");
  const expectedSuffix = `skills/${COMPUTER_USE_SKILL_NAME}/SKILL.md`;
  return normalized.endsWith(expectedSuffix)
    ? normalized.slice(0, -expectedSuffix.length).replace(/\/$/, "")
    : undefined;
}

const fileExists = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));

function emptyMetadata(): ComputerUseDiagnosticMetadata {
  return {
    runtimeInitialized: false,
    appDiscoverySucceeded: false,
    discoveredAppCount: 0,
    targetAppFound: false,
    targetKind: "not-found",
    accessibilityAvailable: false,
    accessibilityTextLength: 0,
    screenshotAvailable: false,
  };
}

function remediationForFailure(
  category: ComputerUseTestFailureCategory,
): ReadonlyArray<ComputerUseRemediation> {
  switch (category) {
    case "host-app-missing":
      return ["install-host-app", "start-new-session"];
    case "skill-missing":
      return ["install-enable-plugin", "start-new-session"];
    case "skill-disabled":
    case "node-repl-tool-missing":
      return ["enable-plugin-capabilities", "start-new-session"];
    case "node-repl-missing":
    case "node-repl-disabled":
      return ["enable-node-repl", "start-new-session"];
    case "plugin-runtime-missing":
    case "runtime-initialization-failed":
      return ["repair-plugin-runtime", "install-host-app", "start-new-session"];
    case "accessibility-permission-denied":
    case "accessibility-unavailable":
      return ["grant-accessibility", "allow-required-applications", "retry-test"];
    case "screen-recording-permission-denied":
    case "screenshot-unavailable":
      return ["grant-screen-recording", "allow-required-applications", "retry-test"];
    case "unsupported-platform":
    case "provider-unavailable":
    case "node-repl-startup-failed":
    case "app-discovery-failed":
    case "target-app-not-found":
    case "native-service-failed":
    case "unknown":
      return ["retry-test"];
  }
}

function readinessFailure(
  status: ComputerUseProviderStatus,
): ComputerUseTestFailureCategory | undefined {
  switch (status.readiness) {
    case "unsupported":
      return "unsupported-platform";
    case "provider-disabled":
    case "provider-unavailable":
      return "provider-unavailable";
    case "skill-missing":
      return "skill-missing";
    case "skill-disabled":
      return "skill-disabled";
    case "node-repl-missing":
      return "node-repl-missing";
    case "node-repl-disabled":
      return "node-repl-disabled";
    case "node-repl-startup-failed":
      return "node-repl-startup-failed";
    case "node-repl-tool-missing":
      return "node-repl-tool-missing";
    case "host-app-missing":
      return "host-app-missing";
    case "plugin-runtime-missing":
      return "plugin-runtime-missing";
    case "ready-unverified":
    case "verified":
      return undefined;
  }
}

function makeFailureResult(
  providerInstanceId: ProviderInstanceId,
  failureCategory: ComputerUseTestFailureCategory,
  metadata = emptyMetadata(),
): ComputerUseTestResult {
  return {
    providerInstanceId,
    passed: false,
    failureCategory,
    metadata,
    remediation: remediationForFailure(failureCategory),
  };
}

function extractTextContent(content: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return content.flatMap((item) => {
    const record = asRecord(item);
    return record?.["type"] === "text" && typeof record["text"] === "string"
      ? [record["text"]]
      : [];
  });
}

export function parseComputerUseDiagnosticResponse(
  response: CodexSchema.V2McpServerToolCallResponse,
): DiagnosticPayload | undefined {
  for (const text of extractTextContent(response.content)) {
    const markerIndex = text.lastIndexOf(DIAGNOSTIC_MARKER);
    if (markerIndex < 0) continue;
    const line = text
      .slice(markerIndex + DIAGNOSTIC_MARKER.length)
      .split(/\r?\n/, 1)[0]
      ?.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const diagnostic = decodeDiagnosticPayload(parsed);
      if (diagnostic._tag === "Some") return diagnostic.value;
    } catch {
      // Ignore unrelated or truncated node_repl output and keep scanning.
    }
  }
  return undefined;
}

export function resolveComputerUseHostContext(
  environment: NodeJS.ProcessEnv,
): ComputerUseHostContext {
  const rawKind = environment[HOST_KIND_ENV_VAR];
  const kind =
    rawKind === "t3-packaged" || rawKind === "t3-electron-dev" ? rawKind : ("unknown" as const);
  const rawBundleId = environment[HOST_BUNDLE_ID_ENV_VAR]?.trim();
  return { kind, bundleId: rawBundleId ? rawBundleId : undefined };
}

export function buildComputerUseDiagnosticScript(
  wrapperPath: string,
  hostContext: ComputerUseHostContext = { kind: "unknown", bundleId: undefined },
): string {
  const wrapperUrl = NodeURL.pathToFileURL(wrapperPath).href;
  return `await (async () => {
  const metadata = { runtimeInitialized: false, appDiscoverySucceeded: false, discoveredAppCount: 0, targetAppFound: false, targetKind: "not-found", accessibilityAvailable: false, accessibilityTextLength: 0, screenshotAvailable: false };
  let failureCategory = null;
  const classify = (error, fallback) => {
    const message = String(error?.message ?? error ?? "").toLowerCase();
    if (message.includes("accessibility") && (message.includes("permission") || message.includes("denied"))) return "accessibility-permission-denied";
    if ((message.includes("screen recording") || message.includes("screenshot")) && (message.includes("permission") || message.includes("denied"))) return "screen-recording-permission-denied";
    if (message.includes("skycomputeruseservice") || message.includes("native service")) return "native-service-failed";
    return fallback;
  };
  try {
    const { setupComputerUseRuntime } = await import(${JSON.stringify(wrapperUrl)});
    await setupComputerUseRuntime({ globals: globalThis });
    metadata.runtimeInitialized = Boolean(globalThis.sky);
  } catch (error) {
    failureCategory = classify(error, "runtime-initialization-failed");
  }
  let apps = [];
  if (!failureCategory) {
    try {
      apps = await globalThis.sky.list_apps();
      metadata.appDiscoverySucceeded = Array.isArray(apps);
      metadata.discoveredAppCount = Array.isArray(apps) ? apps.length : 0;
    } catch (error) {
      failureCategory = classify(error, "app-discovery-failed");
    }
  }
  let state;
  if (!failureCategory) {
    const hostBundleId = ${JSON.stringify(hostContext.bundleId ?? null)};
    const preferDev = ${JSON.stringify(hostContext.kind)} === "t3-electron-dev";
    const idOf = (app) => (typeof app?.id === "string" ? app.id : "");
    const nameOf = (app) => (typeof app?.displayName === "string" ? app.displayName : "");
    const isPackagedIdentity = (app) => idOf(app) === ${JSON.stringify(T3_PACKAGED_BUNDLE_ID)} || (nameOf(app).startsWith("T3 Code") && !nameOf(app).includes("(Dev)"));
    const isDevIdentity = (app) => idOf(app).startsWith(${JSON.stringify(T3_DEV_BUNDLE_ID_PREFIX)}) || idOf(app) === ${JSON.stringify(GENERIC_ELECTRON_BUNDLE_ID)} || nameOf(app) === "T3 Code (Dev)";
    const needsWindowVerification = (app) => idOf(app) === ${JSON.stringify(GENERIC_ELECTRON_BUNDLE_ID)} && nameOf(app) !== "T3 Code (Dev)";
    const packaged = apps.filter((app) => isPackagedIdentity(app)).map((app) => ({ app, kind: "t3-packaged" }));
    const dev = apps.filter((app) => !isPackagedIdentity(app) && isDevIdentity(app)).map((app) => ({ app, kind: "t3-electron-dev" }));
    const ordered = preferDev ? [...dev, ...packaged] : [...packaged, ...dev];
    const candidates = [...ordered.filter((candidate) => hostBundleId !== null && idOf(candidate.app) === hostBundleId), ...ordered.filter((candidate) => hostBundleId === null || idOf(candidate.app) !== hostBundleId)];
    let lastError = null;
    let unverifiable = null;
    for (const candidate of candidates) {
      try {
        const candidateState = await globalThis.sky.get_app_state({ app: idOf(candidate.app) || nameOf(candidate.app), disableDiff: true });
        const text = typeof candidateState?.text === "string" ? candidateState.text : "";
        if (needsWindowVerification(candidate.app) && !text.includes("T3 Code (Dev)") && !text.includes("t3code-dev://")) {
          // Empty text means Accessibility could not read the window, so the
          // candidate cannot be confirmed or ruled out; keep it as a fallback
          // so permission failures are not misreported as target-app-not-found.
          if (text.length === 0 && unverifiable === null) unverifiable = { candidate, candidateState };
          continue;
        }
        state = candidateState;
        metadata.targetAppFound = true;
        metadata.targetKind = candidate.kind;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!metadata.targetAppFound && unverifiable !== null) {
      state = unverifiable.candidateState;
      metadata.targetAppFound = true;
      metadata.targetKind = unverifiable.candidate.kind;
    }
    if (!metadata.targetAppFound) {
      failureCategory = lastError ? classify(lastError, "native-service-failed") : "target-app-not-found";
    }
  }
  if (!failureCategory) {
    metadata.accessibilityTextLength = typeof state?.text === "string" ? state.text.length : 0;
    metadata.accessibilityAvailable = metadata.accessibilityTextLength > 0;
    metadata.screenshotAvailable = typeof state?.screenshot?.url === "string" && state.screenshot.url.length > 0;
    if (!metadata.accessibilityAvailable) failureCategory = "accessibility-unavailable";
    else if (!metadata.screenshotAvailable) failureCategory = "screenshot-unavailable";
  }
  nodeRepl.write(${JSON.stringify(DIAGNOSTIC_MARKER)} + JSON.stringify({ failureCategory, metadata }));
})();`;
}

const inspectInventory = Effect.fn("CodexComputerUse.inspectInventory")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDisplayName: string;
  readonly providerEnabled: boolean;
  readonly platformSupported: boolean;
  readonly hostAppPaths: ReadonlyArray<string>;
  readonly cwd: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.fn.Return<ComputerUseInventory, CodexErrors.CodexAppServerError> {
  yield* input.client.request("config/mcpServer/reload", undefined);
  const [config, skills, mcpStatus] = yield* Effect.all(
    [
      input.client.request("config/read", { cwd: input.cwd, includeLayers: false }),
      input.client.request("skills/list", { cwds: [input.cwd], forceReload: true }),
      input.client.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }),
    ],
    { concurrency: "unbounded" },
  );
  const skill = findComputerUseSkill(skills, input.cwd);
  const pluginRoot = skill ? pluginRootFromSkillPath(skill.path) : undefined;
  const wrapperPath = pluginRoot
    ? input.path.join(pluginRoot, "scripts", "computer-use-client.mjs")
    : undefined;
  const serviceAppPath = pluginRoot
    ? input.path.join(pluginRoot, "Codex Computer Use.app")
    : undefined;
  const [hostInstalled, wrapperInstalled, serviceInstalled] = yield* Effect.all(
    [
      Effect.forEach(input.hostAppPaths, (candidate) => fileExists(input.fileSystem, candidate), {
        concurrency: "unbounded",
      }).pipe(Effect.map((results) => results.some(Boolean))),
      wrapperPath ? fileExists(input.fileSystem, wrapperPath) : Effect.succeed(false),
      serviceAppPath ? fileExists(input.fileSystem, serviceAppPath) : Effect.succeed(false),
    ],
    { concurrency: "unbounded" },
  );

  return {
    facts: {
      providerInstanceId: input.providerInstanceId,
      providerDisplayName: input.providerDisplayName,
      platformSupported: input.platformSupported,
      providerEnabled: input.providerEnabled,
      providerAvailable: true,
      skill: skillState(skill),
      nodeRepl: inspectNodeReplState({ config, mcpStatus }),
      hostApp: hostInstalled ? "available" : "missing",
      pluginRuntime:
        skill === undefined
          ? "unknown"
          : wrapperInstalled && serviceInstalled
            ? "available"
            : "missing",
    },
    wrapperPath: wrapperInstalled ? wrapperPath : undefined,
  };
});

export const makeCodexComputerUseCapability = Effect.fn("makeCodexComputerUseCapability")(
  function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerDisplayName: string;
    readonly config: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<
    ComputerUseCapabilityShape,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platformSupported = (yield* HostProcessPlatform) === "darwin";
    const hostAppPaths = buildComputerUseHostAppPaths(input.environment);
    const hostContext = resolveComputerUseHostContext(input.environment);
    const withInventory = <A>(
      cwd: string,
      use: (input: {
        readonly inventory: ComputerUseInventory;
        readonly client: CodexClient.CodexAppServerClient["Service"];
      }) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
    ) =>
      Effect.gen(function* () {
        const { client } = yield* makeInitializedCodexAppServerClient(
          buildComputerUseAppServerInput({
            config: input.config,
            environment: input.environment,
            cwd,
          }),
        );
        const inventory = yield* inspectInventory({
          client,
          providerInstanceId: input.providerInstanceId,
          providerDisplayName: input.providerDisplayName,
          providerEnabled: input.config.enabled,
          platformSupported,
          hostAppPaths,
          cwd,
          fileSystem,
          path,
        });
        return yield* use({ inventory, client });
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    const unavailableFacts = (): ComputerUseReadinessFacts => ({
      providerInstanceId: input.providerInstanceId,
      providerDisplayName: input.providerDisplayName,
      platformSupported,
      providerEnabled: input.config.enabled,
      providerAvailable: false,
      skill: "missing",
      nodeRepl: "startup-failed",
      hostApp: "unknown",
      pluginRuntime: "unknown",
    });

    const preflightFacts = (): ComputerUseReadinessFacts => ({
      ...unavailableFacts(),
      providerAvailable: true,
      nodeRepl: "missing",
    });
    const canProbe = platformSupported && input.config.enabled;

    const getStatus: ComputerUseCapabilityShape["getStatus"] = (requestedCwd) => {
      const cwd = requestedCwd ?? process.cwd();
      return canProbe
        ? withInventory(cwd, ({ inventory }) =>
            Effect.succeed(deriveComputerUseProviderStatus(inventory.facts)),
          ).pipe(
            Effect.timeout("15 seconds"),
            Effect.orElseSucceed(() => deriveComputerUseProviderStatus(unavailableFacts())),
          )
        : Effect.succeed(deriveComputerUseProviderStatus(preflightFacts()));
    };

    const test: ComputerUseCapabilityShape["test"] = (requestedCwd) => {
      const cwd = requestedCwd ?? process.cwd();
      return canProbe
        ? withInventory(cwd, ({ inventory, client }) =>
            Effect.gen(function* () {
              const status = deriveComputerUseProviderStatus(inventory.facts);
              const preconditionFailure = readinessFailure(status);
              if (preconditionFailure) {
                return makeFailureResult(input.providerInstanceId, preconditionFailure);
              }
              if (!inventory.wrapperPath) {
                return makeFailureResult(input.providerInstanceId, "plugin-runtime-missing");
              }
              const response = yield* client.request("mcpServer/tool/call", {
                server: NODE_REPL_SERVER_NAME,
                tool: NODE_REPL_TOOL_NAME,
                threadId: `computer-use-diagnostic-${input.providerInstanceId}`,
                arguments: {
                  code: buildComputerUseDiagnosticScript(inventory.wrapperPath, hostContext),
                },
              });
              const diagnostic = parseComputerUseDiagnosticResponse(response);
              if (!diagnostic) return makeFailureResult(input.providerInstanceId, "unknown");
              if (diagnostic.failureCategory) {
                return makeFailureResult(
                  input.providerInstanceId,
                  diagnostic.failureCategory,
                  diagnostic.metadata,
                );
              }
              return {
                providerInstanceId: input.providerInstanceId,
                passed: true,
                failureCategory: null,
                metadata: diagnostic.metadata,
                remediation: [],
              } satisfies ComputerUseTestResult;
            }),
          ).pipe(
            Effect.timeout("45 seconds"),
            Effect.orElseSucceed(() =>
              makeFailureResult(input.providerInstanceId, "native-service-failed"),
            ),
          )
        : Effect.succeed(
            makeFailureResult(
              input.providerInstanceId,
              platformSupported ? "provider-unavailable" : "unsupported-platform",
            ),
          );
    };

    return { getStatus, test };
  },
);
