// @effect-diagnostics nodeBuiltinImport:off -- Local provider credentials live in native host stores.
// @effect-diagnostics globalDate:off -- Provider cache and wire timestamps use epoch milliseconds.
// @effect-diagnostics globalDateInEffect:off -- The fallback service stamps a transport DTO.
// @effect-diagnostics globalFetch:off -- Vendor usage endpoints are isolated behind this server boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import type {
  SubscriptionUsageCard,
  SubscriptionUsageProvider,
  SubscriptionUsageReadInput,
  SubscriptionUsageSnapshot,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { expandHomePath } from "../pathExpansion.ts";
import { makeInitializedCodexAppServerClient } from "../provider/Layers/CodexProvider.ts";
import {
  mapClaudeUsage,
  mapCodexUsage,
  mapCopilotUsage,
  mapCursorUsage,
  titleCasePlan,
} from "./usageMappers.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const MIN_FORCE_REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CURSOR_API_BASE = "https://api2.cursor.sh";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

type JsonObject = Record<string, unknown>;

export interface UsageProviderAdapter {
  readonly provider: SubscriptionUsageProvider;
  readonly key: string;
  readonly displayName: string;
  readonly sourceStability: SubscriptionUsageCard["sourceStability"];
  readonly fallbackMessage: string;
  readonly read: () => Promise<SubscriptionUsageCard>;
}

export interface CachedUsageReader {
  readonly read: (input: SubscriptionUsageReadInput) => Promise<SubscriptionUsageSnapshot>;
}

class ProviderUsageFailure extends Error {
  readonly safeMessage: string;

  constructor(safeMessage: string) {
    super(safeMessage);
    this.safeMessage = safeMessage;
  }
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function errorCard(
  adapter: UsageProviderAdapter,
  nowMs: number,
  message: string,
): SubscriptionUsageCard {
  return {
    key: adapter.key,
    provider: adapter.provider,
    displayName: adapter.displayName,
    sourceStability: adapter.sourceStability,
    status: "error",
    metrics: [],
    refreshedAt: iso(nowMs),
    stale: false,
    message,
  };
}

function safeFailureMessage(cause: unknown, fallback: string): string {
  return cause instanceof ProviderUsageFailure ? cause.safeMessage : fallback;
}

export function makeCachedUsageReader(input: {
  readonly adapters: ReadonlyArray<UsageProviderAdapter>;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
}): CachedUsageReader {
  const now = input.now ?? Date.now;
  const refreshIntervalMs = input.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  let cached: SubscriptionUsageSnapshot | null = null;
  let inFlight: Promise<SubscriptionUsageSnapshot> | null = null;

  const refresh = async (): Promise<SubscriptionUsageSnapshot> => {
    const startedAt = now();
    const priorCards = new Map(cached?.cards.map((card) => [card.key, card]));
    const cards = await Promise.all(
      input.adapters.map(async (adapter): Promise<SubscriptionUsageCard> => {
        try {
          return await adapter.read();
        } catch (cause) {
          const previous = priorCards.get(adapter.key);
          const message = safeFailureMessage(cause, adapter.fallbackMessage);
          if (previous?.status === "available") {
            return { ...previous, stale: true, message };
          }
          return errorCard(adapter, startedAt, message);
        }
      }),
    );
    const fetchedAt = now();
    cached = {
      cards,
      fetchedAt: iso(fetchedAt),
      nextRefreshAt: iso(fetchedAt + refreshIntervalMs),
      refreshIntervalSeconds: refreshIntervalMs / 1_000,
      serverLocal: true,
    };
    return cached;
  };

  return {
    read: async ({ force }) => {
      const nowMs = now();
      const fetchedAt = cached ? Date.parse(cached.fetchedAt) : Number.NEGATIVE_INFINITY;
      if (
        cached &&
        ((!force && nowMs < Date.parse(cached.nextRefreshAt)) ||
          (force && nowMs - fetchedAt < MIN_FORCE_REFRESH_INTERVAL_MS))
      ) {
        return cached;
      }
      if (!inFlight) {
        inFlight = refresh().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfPresent(filePath: string): Promise<JsonObject | null> {
  const source = await readTextIfPresent(filePath);
  if (!source) return null;
  try {
    return jsonObject(JSON.parse(source)) ?? null;
  } catch {
    return null;
  }
}

async function readMacKeychain(
  service: string,
  hostPlatform: NodeJS.Platform,
): Promise<string | null> {
  if (hostPlatform !== "darwin") return null;
  const account = process.env.USER ?? NodeOS.userInfo().username;
  for (const args of [
    ["find-generic-password", "-a", account, "-s", service, "-w"],
    ["find-generic-password", "-s", service, "-w"],
  ]) {
    try {
      const { stdout } = await execFile("/usr/bin/security", args, {
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      const value = stdout.trim();
      if (value.length > 0) return value;
    } catch {
      // A missing or locked keychain item is an ordinary credential miss.
    }
  }
  return null;
}

async function fetchJson(input: {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}): Promise<{ readonly data: unknown; readonly response: Response }> {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: input.headers,
    body: input.body,
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  }).catch(() => {
    throw new ProviderUsageFailure("Usage service could not be reached. Try again later.");
  });
  const body = await response.text();
  let data: unknown = null;
  try {
    data = body.length > 0 ? JSON.parse(body) : null;
  } catch {
    if (response.ok) {
      throw new ProviderUsageFailure("The provider returned an invalid usage response.");
    }
  }
  return { data, response };
}

function providerCard(input: {
  readonly provider: SubscriptionUsageProvider;
  readonly displayName: string;
  readonly sourceStability: SubscriptionUsageCard["sourceStability"];
  readonly plan?: string | undefined;
  readonly metrics: SubscriptionUsageCard["metrics"];
  readonly message?: string | undefined;
  readonly nowMs?: number | undefined;
}): SubscriptionUsageCard {
  return {
    key: input.provider,
    provider: input.provider,
    displayName: input.displayName,
    sourceStability: input.sourceStability,
    status: "available",
    ...(input.plan ? { plan: input.plan } : {}),
    metrics: input.metrics,
    refreshedAt: iso(input.nowMs ?? Date.now()),
    stale: false,
    ...(input.message ? { message: input.message } : {}),
  };
}

function unavailableCard(input: {
  readonly provider: SubscriptionUsageProvider;
  readonly displayName: string;
  readonly sourceStability: SubscriptionUsageCard["sourceStability"];
  readonly message: string;
}): SubscriptionUsageCard {
  return {
    key: input.provider,
    provider: input.provider,
    displayName: input.displayName,
    sourceStability: input.sourceStability,
    status: "unavailable",
    metrics: [],
    refreshedAt: iso(Date.now()),
    stale: false,
    message: input.message,
  };
}

function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro 20x";
    case "prolite":
      return "Pro 5x";
    case "team":
      return "Team";
    case "self_serve_business_usage_based":
    case "business":
      return "Business";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "Enterprise";
    case "edu":
      return "Edu";
    default:
      return undefined;
  }
}

function makeCodexAdapter(
  childSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): UsageProviderAdapter {
  return {
    provider: "codex",
    key: "codex",
    displayName: "Codex",
    sourceStability: "official",
    fallbackMessage: "Codex usage is unavailable. Check the Codex provider and try again.",
    read: async () => {
      const binaryPath = text(process.env.T3CODE_CODEX_BINARY) ?? "codex";
      const homePath = text(process.env.CODEX_HOME);
      const effect = Effect.gen(function* () {
        const { client } = yield* makeInitializedCodexAppServerClient({
          binaryPath,
          ...(homePath ? { homePath } : {}),
          cwd: process.cwd(),
        });
        const account = yield* client.request("account/read", {});
        if (!account.account || account.account.type !== "chatgpt") {
          return unavailableCard({
            provider: "codex",
            displayName: "Codex",
            sourceStability: "official",
            message:
              account.account?.type === "apiKey"
                ? "Subscription usage is unavailable for API-key authentication."
                : "Sign in with Codex to view subscription usage.",
          });
        }
        const limits: CodexSchema.V2GetAccountRateLimitsResponse = yield* client.request(
          "account/rateLimits/read",
          undefined,
        );
        const metrics = mapCodexUsage(limits);
        return providerCard({
          provider: "codex",
          displayName: "Codex",
          sourceStability: "official",
          ...((codexPlanLabel(account.account.planType) ??
          codexPlanLabel(limits.rateLimits.planType))
            ? {
                plan:
                  codexPlanLabel(account.account.planType) ??
                  codexPlanLabel(limits.rateLimits.planType),
              }
            : {}),
          metrics,
          ...(metrics.length === 0
            ? { message: "Codex returned no quota windows for this account." }
            : {}),
        });
      }).pipe(
        Effect.timeout("18 seconds"),
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childSpawner),
      );
      return Effect.runPromise(effect).catch(() => {
        throw new ProviderUsageFailure(
          "Codex usage is unavailable. Check that Codex is installed and signed in.",
        );
      });
    },
  };
}

interface ClaudeCredential {
  readonly accessToken: string;
  readonly subscriptionType?: string;
  readonly rateLimitTier?: string;
}

function parseClaudeCredential(value: unknown): ClaudeCredential | null {
  const root = jsonObject(value);
  const oauth = jsonObject(root?.claudeAiOauth);
  const accessToken = text(oauth?.accessToken);
  if (!accessToken) return null;
  const subscriptionType = text(oauth?.subscriptionType);
  const rateLimitTier = text(oauth?.rateLimitTier);
  return {
    accessToken,
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
  };
}

function claudePlan(credential: ClaudeCredential): string | undefined {
  const base = titleCasePlan(credential.subscriptionType);
  const multiplier = credential.rateLimitTier?.match(/\d+x/u)?.[0];
  return base ? `${base}${multiplier ? ` ${multiplier}` : ""}` : undefined;
}

async function loadClaudeCredential(
  configDir: string,
  hostPlatform: NodeJS.Platform,
): Promise<ClaudeCredential | null> {
  const services = ["Claude Code-credentials"];
  if (process.env.CLAUDE_CONFIG_DIR) {
    const hash = NodeCrypto.createHash("sha256")
      .update(process.env.CLAUDE_CONFIG_DIR.normalize("NFC"))
      .digest("hex")
      .slice(0, 8);
    services.unshift(`Claude Code-credentials-${hash}`);
  }
  for (const service of services) {
    const raw = await readMacKeychain(service, hostPlatform);
    if (!raw) continue;
    try {
      const credential = parseClaudeCredential(JSON.parse(raw));
      if (credential) return credential;
    } catch {
      // Fall through to the file-backed credential.
    }
  }
  return parseClaudeCredential(
    await readJsonIfPresent(NodePath.join(configDir, ".credentials.json")),
  );
}

function makeClaudeAdapter(hostPlatform: NodeJS.Platform): UsageProviderAdapter {
  let cooldownUntil = 0;
  return {
    provider: "claude",
    key: "claude",
    displayName: "Claude",
    sourceStability: "vendor-private",
    fallbackMessage: "Claude usage is unavailable. Try again later.",
    read: async () => {
      if (Date.now() < cooldownUntil) {
        throw new ProviderUsageFailure(
          "Anthropic is rate limiting usage updates. Cached data is shown.",
        );
      }
      const configDir = expandHomePath(
        process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"),
      );
      const credential = await loadClaudeCredential(configDir, hostPlatform);
      if (!credential) {
        return unavailableCard({
          provider: "claude",
          displayName: "Claude",
          sourceStability: "vendor-private",
          message: "Run `claude` and sign in to view subscription usage.",
        });
      }
      const customBase = text(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL);
      const url = customBase
        ? `${customBase.replace(/\/+$/u, "")}/api/oauth/usage`
        : CLAUDE_USAGE_URL;
      const { data, response } = await fetchJson({
        url,
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.69",
        },
        timeoutMs: 10_000,
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        cooldownUntil =
          Date.now() +
          (Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1_000
            : REFRESH_INTERVAL_MS);
        throw new ProviderUsageFailure(
          "Anthropic is rate limiting usage updates. Cached data is shown.",
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderUsageFailure("Claude sign-in expired. Run `claude` to sign in again.");
      }
      if (!response.ok) {
        throw new ProviderUsageFailure("Claude usage is temporarily unavailable.");
      }
      const metrics = mapClaudeUsage(data);
      return providerCard({
        provider: "claude",
        displayName: "Claude",
        sourceStability: "vendor-private",
        ...(claudePlan(credential) ? { plan: claudePlan(credential) } : {}),
        metrics,
        ...(metrics.length === 0 ? { message: "Claude returned no quota windows." } : {}),
      });
    },
  };
}

function readCursorSqliteToken(hostPlatform: NodeJS.Platform): string | null {
  const databasePath =
    hostPlatform === "darwin"
      ? NodePath.join(
          NodeOS.homedir(),
          "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
        )
      : hostPlatform === "win32"
        ? NodePath.join(
            process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Roaming"),
            "Cursor/User/globalStorage/state.vscdb",
          )
        : NodePath.join(NodeOS.homedir(), ".config/Cursor/User/globalStorage/state.vscdb");
  try {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
        .get("cursorAuth/accessToken") as { readonly value?: unknown } | undefined;
      return text(row?.value) ?? null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

async function loadCursorToken(hostPlatform: NodeJS.Platform): Promise<string | null> {
  return (
    readCursorSqliteToken(hostPlatform) ??
    (await readMacKeychain("cursor-access-token", hostPlatform))
  );
}

async function cursorConnect(token: string, method: string): Promise<unknown> {
  const { data, response } = await fetchJson({
    url: `${CURSOR_API_BASE}/aiserver.v1.DashboardService/${method}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
    timeoutMs: 10_000,
  });
  if (response.status === 401 || response.status === 403) {
    throw new ProviderUsageFailure("Cursor sign-in expired. Sign in through Cursor and try again.");
  }
  if (!response.ok) throw new ProviderUsageFailure("Cursor usage is temporarily unavailable.");
  return data;
}

function makeCursorAdapter(hostPlatform: NodeJS.Platform): UsageProviderAdapter {
  return {
    provider: "cursor",
    key: "cursor",
    displayName: "Cursor",
    sourceStability: "vendor-private",
    fallbackMessage: "Cursor usage is unavailable. Try again later.",
    read: async () => {
      const token = await loadCursorToken(hostPlatform);
      if (!token) {
        return unavailableCard({
          provider: "cursor",
          displayName: "Cursor",
          sourceStability: "vendor-private",
          message: "Sign in through Cursor to view subscription usage.",
        });
      }
      const usage = await cursorConnect(token, "GetCurrentPeriodUsage");
      const [planResult, creditsResult] = await Promise.allSettled([
        cursorConnect(token, "GetPlanInfo"),
        cursorConnect(token, "GetCreditGrantsBalance"),
      ]);
      const mapped = mapCursorUsage(
        usage,
        planResult.status === "fulfilled" ? planResult.value : undefined,
        creditsResult.status === "fulfilled" ? creditsResult.value : undefined,
      );
      return providerCard({
        provider: "cursor",
        displayName: "Cursor",
        sourceStability: "vendor-private",
        ...(mapped.plan ? { plan: mapped.plan } : {}),
        metrics: mapped.metrics,
        ...(mapped.metrics.length === 0
          ? {
              message:
                "Cursor returned partial account data without a usable quota. Team and enterprise plans may not expose per-seat usage.",
            }
          : {}),
      });
    },
  };
}

function githubHostYamlValue(source: string, key: string): string | null {
  const prefix = `${key}:`;
  let inGithub = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine.length > 0 && !/^\s/u.test(rawLine)) {
      inGithub = rawLine.trim().startsWith("github.com:");
      continue;
    }
    if (!inGithub) continue;
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    const value = line
      .slice(prefix.length)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
    return value.length > 0 ? value : null;
  }
  return null;
}

function unwrapGoKeyring(raw: string): string | null {
  const value = raw.trim();
  const prefix = "go-keyring-base64:";
  if (!value.startsWith(prefix)) return value.length > 0 ? value : null;
  try {
    const decoded = Buffer.from(value.slice(prefix.length).trim(), "base64")
      .toString("utf8")
      .trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

async function loadCopilotToken(hostPlatform: NodeJS.Platform): Promise<string | null> {
  const configRoot =
    hostPlatform === "win32"
      ? (process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Roaming"))
      : NodePath.join(NodeOS.homedir(), ".config");
  for (const fileName of ["apps.json", "hosts.json"]) {
    const body = await readJsonIfPresent(NodePath.join(configRoot, "github-copilot", fileName));
    if (!body) continue;
    for (const [host, value] of Object.entries(body)) {
      if (host !== "github.com" && !host.startsWith("github.com:")) continue;
      const token = text(jsonObject(value)?.oauth_token);
      if (token) return token;
    }
  }
  const hostsSource = await readTextIfPresent(
    NodePath.join(configRoot, hostPlatform === "win32" ? "GitHub CLI" : "gh", "hosts.yml"),
  );
  const fileToken = hostsSource ? githubHostYamlValue(hostsSource, "oauth_token") : null;
  if (fileToken) return fileToken;
  const keychainToken = await readMacKeychain("gh:github.com", hostPlatform);
  if (keychainToken) return unwrapGoKeyring(keychainToken);
  try {
    const { stdout } = await execFile("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 5_000,
      maxBuffer: 1_000_000,
    });
    return text(stdout) ?? null;
  } catch {
    return null;
  }
}

function makeCopilotAdapter(hostPlatform: NodeJS.Platform): UsageProviderAdapter {
  return {
    provider: "copilot",
    key: "copilot",
    displayName: "GitHub Copilot",
    sourceStability: "vendor-private",
    fallbackMessage: "GitHub Copilot usage is unavailable. Try again later.",
    read: async () => {
      const token = await loadCopilotToken(hostPlatform);
      if (!token) {
        return unavailableCard({
          provider: "copilot",
          displayName: "GitHub Copilot",
          sourceStability: "vendor-private",
          message: "Sign in to GitHub Copilot or run `gh auth login` to view usage.",
        });
      }
      const { data, response } = await fetchJson({
        url: COPILOT_USAGE_URL,
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "Editor-Version": "vscode/1.96.2",
          "Editor-Plugin-Version": "copilot-chat/0.26.7",
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "X-GitHub-Api-Version": "2025-04-01",
        },
        timeoutMs: 15_000,
      });
      if (response.status === 401 || response.status === 403) {
        throw new ProviderUsageFailure(
          "GitHub authentication expired or cannot read Copilot usage. Re-authenticate and try again.",
        );
      }
      if (!response.ok) {
        throw new ProviderUsageFailure("GitHub Copilot usage is temporarily unavailable.");
      }
      const mapped = mapCopilotUsage(data);
      return providerCard({
        provider: "copilot",
        displayName: "GitHub Copilot",
        sourceStability: "vendor-private",
        ...(mapped.plan ? { plan: mapped.plan } : {}),
        metrics: mapped.metrics,
        ...(mapped.orgManaged
          ? { message: "This organization-managed seat does not expose per-seat quota usage." }
          : mapped.metrics.length === 0
            ? { message: "GitHub returned no usable Copilot quota meters." }
            : {}),
      });
    },
  };
}

export class SubscriptionLimitsService extends Context.Service<
  SubscriptionLimitsService,
  {
    readonly read: (input: SubscriptionUsageReadInput) => Effect.Effect<SubscriptionUsageSnapshot>;
  }
>()("t3/usage/SubscriptionLimitsService") {}

const make = Effect.gen(function* () {
  const childSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const reader = makeCachedUsageReader({
    adapters: [
      makeCodexAdapter(childSpawner),
      makeClaudeAdapter(hostPlatform),
      makeCursorAdapter(hostPlatform),
      makeCopilotAdapter(hostPlatform),
    ],
  });
  return SubscriptionLimitsService.of({
    read: (input) => Effect.promise(() => reader.read(input)),
  });
});

export const layer = Layer.effect(SubscriptionLimitsService, make);

export const unavailableService = SubscriptionLimitsService.of({
  read: () =>
    Effect.sync(() => {
      const nowMs = Date.now();
      const cards = (
        [
          ["codex", "Codex", "official"],
          ["claude", "Claude", "vendor-private"],
          ["cursor", "Cursor", "vendor-private"],
          ["copilot", "GitHub Copilot", "vendor-private"],
        ] as const
      ).map(([provider, displayName, sourceStability]) =>
        unavailableCard({
          provider,
          displayName,
          sourceStability,
          message: "Usage discovery is unavailable in this server runtime.",
        }),
      );
      return {
        cards,
        fetchedAt: iso(nowMs),
        nextRefreshAt: iso(nowMs + REFRESH_INTERVAL_MS),
        refreshIntervalSeconds: REFRESH_INTERVAL_MS / 1_000,
        serverLocal: true,
      };
    }),
});
