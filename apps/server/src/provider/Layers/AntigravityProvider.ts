import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const MINIMUM_STRUCTURED_OUTPUT_VERSION = [1, 1, 8] as const;
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODELS_PROBE_TIMEOUT_MS = 10_000;
const EMPTY_CAPABILITIES: ModelCapabilities = {};

const AntigravitySettingsFile = Schema.fromJsonString(
  Schema.Struct({ modelProvider: Schema.optional(Schema.String) }),
);
const decodeAntigravitySettingsFile = Schema.decodeUnknownOption(AntigravitySettingsFile);

const presentation = {
  displayName: "Antigravity",
  badgeLabel: "Experimental",
} as const;

export function parseAntigravityModels(output: string): ReadonlyArray<ServerProviderModel> {
  const models: Array<ServerProviderModel> = [];
  const seen = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = /^(\S+)(?:\t+|\s{2,})(.+)$/u.exec(line);
    const slug = (fields?.[1] ?? line).trim();
    if (!slug || !/^[a-z0-9][a-z0-9._-]*$/iu.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const label = fields?.[2]?.trim() ?? "";
    models.push({
      slug,
      name: label || slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

export function isSupportedAntigravityVersion(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split(".").slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let index = 0; index < MINIMUM_STRUCTURED_OUTPUT_VERSION.length; index += 1) {
    const current = parts[index] ?? 0;
    const minimum = MINIMUM_STRUCTURED_OUTPUT_VERSION[index]!;
    if (current !== minimum) return current > minimum;
  }
  return true;
}

const runAntigravityCommand = (
  settings: AntigravitySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, args, {
      env: environment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        stdin: "ignore",
      }),
    );
  });

const readAuth = Effect.fn("AntigravityProvider.readAuth")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  {
    auth: ServerProviderAuth;
    message?: string;
  },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const home = environment.HOME ?? environment.USERPROFILE;
  if (!home) return { auth: { status: "unknown" } };
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  const parsed = yield* fileSystem.readFileString(settingsPath).pipe(
    Effect.map(decodeAntigravitySettingsFile),
    Effect.orElseSucceed(() => Option.none()),
  );
  const modelProvider = Option.isSome(parsed) ? parsed.value.modelProvider?.trim() : undefined;
  const hasApiKey = Boolean(environment.GEMINI_API_KEY?.trim());
  if (modelProvider === "gemini" && hasApiKey) {
    return { auth: { status: "authenticated", type: "api-key", label: "Gemini API key" } };
  }
  if (modelProvider === "gemini") {
    return {
      auth: { status: "unauthenticated", type: "api-key", label: "Gemini API key" },
      message:
        "Antigravity is configured for Gemini API-key authentication, but GEMINI_API_KEY is missing.",
    };
  }
  if (hasApiKey) {
    return {
      auth: { status: "unknown" },
      message:
        "GEMINI_API_KEY is set, but Antigravity only uses it when modelProvider is set to 'gemini' in its settings file.",
    };
  }
  return {
    auth: { status: "unknown" },
    message: "Antigravity account authentication will be verified by the first delegated run.",
  };
});

export function buildInitialAntigravityProviderSnapshot(
  settings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
      ...(settings.enabled
        ? {
            delegation: {
              available: false,
              reason: "Antigravity CLI availability is still being checked.",
            },
          }
        : {}),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Antigravity CLI availability..."
          : "Antigravity is disabled in T3 Code settings.",
      },
    });
  });
}

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    | import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const customModels = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
    if (!settings.enabled) {
      return buildServerProvider({
        presentation,
        enabled: false,
        checkedAt,
        models: customModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    const versionProbe = yield* runAntigravityCommand(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (versionProbe._tag === "Failure") {
      const missing = isCommandMissingCause(versionProbe.failure);
      const reason = missing
        ? `Antigravity CLI command \`${settings.binaryPath}\` was not found.`
        : "Failed to execute the Antigravity CLI health check.";
      return buildServerProvider({
        presentation,
        enabled: true,
        checkedAt,
        models: customModels,
        delegation: { available: false, reason },
        probe: {
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: reason,
        },
      });
    }
    if (Option.isNone(versionProbe.success)) {
      const reason = "Antigravity CLI timed out while running `agy --version`.";
      return buildServerProvider({
        presentation,
        enabled: true,
        checkedAt,
        models: customModels,
        delegation: { available: false, reason },
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: reason,
        },
      });
    }
    const versionResult = versionProbe.success.value;
    const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (versionResult.code !== 0 || !version) {
      const reason = "Antigravity CLI did not return a valid version.";
      return buildServerProvider({
        presentation,
        enabled: true,
        checkedAt,
        models: customModels,
        delegation: { available: false, reason },
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: reason,
        },
      });
    }
    if (!isSupportedAntigravityVersion(version)) {
      const reason = "Antigravity CLI 1.1.8 or newer is required for structured headless output.";
      return buildServerProvider({
        presentation,
        enabled: true,
        checkedAt,
        models: customModels,
        delegation: { available: false, reason },
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: reason,
        },
      });
    }

    const auth = yield* readAuth(environment);
    const modelProbe = yield* runAntigravityCommand(settings, ["models"], environment).pipe(
      Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
    let modelWarning: string | undefined;
    if (modelProbe._tag === "Success" && Option.isSome(modelProbe.success)) {
      const result = modelProbe.success.value;
      discoveredModels = result.code === 0 ? parseAntigravityModels(result.stdout) : [];
      if (result.code !== 0 || discoveredModels.length === 0) {
        modelWarning =
          "Antigravity model discovery failed; runs without an explicit model use the CLI default.";
      }
    } else {
      modelWarning =
        "Antigravity model discovery timed out or failed; runs without an explicit model use the CLI default.";
    }
    const message = [auth.message, modelWarning].filter(Boolean).join(" ") || undefined;
    const delegation =
      auth.auth.status === "unauthenticated"
        ? {
            available: false,
            reason:
              auth.message ?? "Antigravity authentication must be configured before delegation.",
          }
        : { available: true };
    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        discoveredModels,
        settings.customModels,
        EMPTY_CAPABILITIES,
      ),
      delegation,
      probe: {
        installed: true,
        version,
        status:
          auth.auth.status === "unauthenticated" ? "error" : modelWarning ? "warning" : "ready",
        auth: auth.auth,
        ...(message ? { message } : {}),
      },
    });
  },
);
