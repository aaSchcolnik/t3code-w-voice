import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeURL from "node:url";

import compatibilityFixture from "./fixtures/provider-compatibility.json" with { type: "json" };
import protocolFixture from "./fixtures/protocol-2026-07-28.json" with { type: "json" };
import {
  detectProtocolEra,
  MCP_STABLE_PROTOCOL_VERSION,
  MCP_TASKS_EXTENSION,
  resolveProtocolProfile,
  supportsModernCore,
  tasksMaturityGate,
  type McpConformanceRequest,
  type McpProviderCompatibility,
  type McpTransportDecision,
} from "./McpProtocolProfile.ts";

interface ProtocolFixture {
  readonly fixtureVersion: number;
  readonly protocolVersion: string;
  readonly tasksExtension: string;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly expectedEra: "legacy" | "2026";
    readonly request: McpConformanceRequest;
  }>;
  readonly multiRoundTripInput: {
    readonly extensionIndependent: boolean;
    readonly sequence: ReadonlyArray<{
      readonly direction: "client-to-server" | "server-to-client";
      readonly method: string;
      readonly result?: string;
    }>;
  };
}

interface CompatibilityFixture {
  readonly fixtureVersion: number;
  readonly observedAt: string;
  readonly providers: ReadonlyArray<McpProviderCompatibility>;
  readonly transportDecision: McpTransportDecision;
}

const workspaceRoot = NodeURL.fileURLToPath(new URL("../../../../..", import.meta.url));
const protocol = protocolFixture as ProtocolFixture;
const compatibility = compatibilityFixture as CompatibilityFixture;

describe("MCP 2026 protocol fixtures", () => {
  it("pins stable core and Tasks as separate versions", () => {
    expect(protocol.fixtureVersion).toBe(1);
    expect(protocol.protocolVersion).toBe(MCP_STABLE_PROTOCOL_VERSION);
    expect(protocol.tasksExtension).toBe(MCP_TASKS_EXTENSION);
  });

  it("classifies legacy sessionful and modern stateless requests", () => {
    for (const testCase of protocol.cases) {
      expect(detectProtocolEra(testCase.request), testCase.name).toBe(testCase.expectedEra);
    }

    const modernCases = protocol.cases.filter(({ expectedEra }) => expectedEra === "2026");
    expect(modernCases.length).toBeGreaterThanOrEqual(4);
    for (const testCase of modernCases) {
      expect(testCase.request.headers["mcp-session-id"], testCase.name).toBeUndefined();
      expect(testCase.request.headers["mcp-protocol-version"], testCase.name).toBe(
        MCP_STABLE_PROTOCOL_VERSION,
      );
      expect(testCase.request.headers["mcp-method"], testCase.name).toBe(
        testCase.request.body.method,
      );
    }
  });

  it("keeps multi-round-trip input independent from Tasks", () => {
    expect(protocol.multiRoundTripInput.extensionIndependent).toBe(true);
    expect(protocol.multiRoundTripInput.sequence.map(({ method }) => method)).toEqual([
      "tools/call",
      "elicitation/create",
      "elicitation/create",
      "tools/call",
    ]);
    expect(
      protocol.multiRoundTripInput.sequence.some(({ method }) => method.startsWith("tasks/")),
    ).toBe(false);
  });
});

describe("provider compatibility matrix", () => {
  it.effect("covers every supported provider adapter with an explicit profile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(compatibility.providers.map(({ provider }) => provider).sort()).toEqual([
        "claudeAgent",
        "codex",
        "cursor",
        "grok",
        "opencode",
      ]);

      for (const provider of compatibility.providers) {
        expect(["legacy", "2026", "auto"]).toContain(provider.profile);
        expect(provider.legacyInitializeSession.status).toBe("supported");
        for (const probe of [
          provider.legacyInitializeSession,
          provider.serverDiscover,
          provider.statelessTools,
          provider.tasksExtension,
          provider.multiRoundTripInput,
        ]) {
          expect(probe.evidence.length, `${provider.provider} probe evidence`).toBeGreaterThan(0);
          for (const evidencePath of probe.evidence) {
            expect(
              yield* fileSystem.exists(path.join(workspaceRoot, evidencePath)),
              evidencePath,
            ).toBe(true);
          }
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("does not claim modern core support without both required probes", () => {
    for (const provider of compatibility.providers) {
      expect(supportsModernCore(provider), provider.provider).toBe(false);
      if (provider.profile === "2026") {
        expect(supportsModernCore(provider), provider.provider).toBe(true);
      }
    }
  });

  it("uses auto only for provider clients whose binary is not workspace-pinned", () => {
    for (const provider of compatibility.providers) {
      expect(provider.profile === "auto").toBe(
        provider.clientVersion.source === "user-installed-binary",
      );
    }
  });

  it("resolves auto profiles per request without changing fixed profiles", () => {
    const legacy = protocol.cases.find(({ expectedEra }) => expectedEra === "legacy")!.request;
    const modern = protocol.cases.find(({ expectedEra }) => expectedEra === "2026")!.request;

    expect(resolveProtocolProfile("auto", legacy)).toBe("legacy");
    expect(resolveProtocolProfile("auto", modern)).toBe("2026");
    expect(resolveProtocolProfile("legacy", modern)).toBe("legacy");
    expect(resolveProtocolProfile("2026", legacy)).toBe("2026");
  });

  it("keeps Tasks blocked behind its independent maturity gate", () => {
    expect(tasksMaturityGate(compatibility.providers, false)).toBe("blocked");
    expect(tasksMaturityGate(compatibility.providers, true)).toBe("blocked");
    expect(compatibility.transportDecision.tasksMaturityGate).toBe("blocked");
    expect(
      compatibility.providers.every(({ tasksExtension }) => tasksExtension.status !== "supported"),
    ).toBe(true);
    expect(compatibility.transportDecision.tasksGateReasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("released Effect MCP transport decision", () => {
  it.effect("anchors the decision to local dependency and vendored source versions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const readWorkspaceFile = (relativePath: string) =>
        fileSystem.readFileString(path.join(workspaceRoot, relativePath));
      const workspace = yield* readWorkspaceFile("pnpm-workspace.yaml");
      const lockfile = yield* readWorkspaceFile("pnpm-lock.yaml");
      const effectMcpServer = yield* readWorkspaceFile(
        ".repos/effect-smol/packages/effect/src/unstable/ai/McpServer.ts",
      );

      expect(workspace).toContain("effect: 4.0.0-beta.102");
      expect(lockfile).toContain("'@anthropic-ai/claude-agent-sdk':");
      expect(lockfile).toContain(
        "version: 0.3.170(@anthropic-ai/sdk@0.93.0(zod@4.4.3))(@modelcontextprotocol/sdk@1.29.0",
      );
      expect(effectMcpServer).toContain('const LATEST_PROTOCOL_VERSION = "2025-06-18"');
      expect(effectMcpServer).not.toContain(MCP_STABLE_PROTOCOL_VERSION);
      expect(effectMcpServer).not.toContain('"server/discover"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("selects the isolated official SDK v2 adapter without a production transport change", () => {
    expect(compatibility.transportDecision).toMatchObject({
      effectVersion: "4.0.0-beta.102",
      effectLatestProtocolVersion: "2025-06-18",
      effectSupportsStableDualEra: false,
      modernTransport: "official-sdk-v2-adapter",
      legacyTransport: "effect",
      productionTransportChanged: false,
    });
  });
});
