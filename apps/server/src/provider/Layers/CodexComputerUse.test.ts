import { describe, expect, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  buildComputerUseAppServerInput,
  buildComputerUseDiagnosticScript,
  buildComputerUseHostAppPaths,
  findComputerUseSkill,
  inspectNodeReplState,
  isComputerUseSkill,
  parseComputerUseDiagnosticResponse,
  resolveComputerUseHostContext,
} from "./CodexComputerUse.ts";
import { CodexSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

function configWithNodeRepl(value: unknown): CodexSchema.V2ConfigReadResponse {
  return {
    config: { mcp_servers: { node_repl: value } },
    origins: {},
  } as CodexSchema.V2ConfigReadResponse;
}

function mcpStatus(options?: { readonly includeServer?: boolean; readonly includeTool?: boolean }) {
  return {
    data:
      options?.includeServer === false
        ? []
        : [
            {
              name: "node_repl",
              authStatus: "unsupported",
              resourceTemplates: [],
              resources: [],
              tools: options?.includeTool === false ? {} : { js: { name: "js", inputSchema: {} } },
            },
          ],
  } as CodexSchema.V2ListMcpServerStatusResponse;
}

describe("Codex Computer Use inventory", () => {
  it("keeps each provider instance's effective custom CODEX_HOME and environment isolated", () => {
    const decode = Schema.decodeUnknownSync(CodexSettings);
    const personal = buildComputerUseAppServerInput({
      config: decode({ homePath: "/tmp/codex-personal" }),
      environment: { T3_PROVIDER_INSTANCE: "personal" },
      cwd: "/tmp/project",
    });
    const work = buildComputerUseAppServerInput({
      config: decode({ homePath: "/tmp/codex-work-shadow" }),
      environment: { T3_PROVIDER_INSTANCE: "work" },
      cwd: "/tmp/project",
    });
    expect(personal.homePath).toBe("/tmp/codex-personal");
    expect(work.homePath).toBe("/tmp/codex-work-shadow");
    expect(personal.environment).not.toBe(work.environment);
    expect(buildComputerUseHostAppPaths({ HOME: "/Users/personal" })).toContain(
      "/Users/personal/Applications/ChatGPT.app",
    );
    expect(buildComputerUseHostAppPaths({ HOME: "/Users/work" })).toContain(
      "/Users/work/Applications/Codex.app",
    );
  });

  it("distinguishes missing, disabled, failed, and tool-missing node_repl states", () => {
    expect(
      inspectNodeReplState({ config: configWithNodeRepl(undefined), mcpStatus: mcpStatus() }),
    ).toBe("missing");
    expect(
      inspectNodeReplState({
        config: configWithNodeRepl({ enabled: false }),
        mcpStatus: mcpStatus(),
      }),
    ).toBe("disabled");
    expect(
      inspectNodeReplState({
        config: configWithNodeRepl({ enabled: true }),
        mcpStatus: mcpStatus({ includeServer: false }),
      }),
    ).toBe("startup-failed");
    expect(
      inspectNodeReplState({
        config: configWithNodeRepl({ enabled: true }),
        mcpStatus: mcpStatus({ includeTool: false }),
      }),
    ).toBe("tool-missing");
    expect(
      inspectNodeReplState({
        config: configWithNodeRepl({ enabled: true }),
        mcpStatus: mcpStatus(),
      }),
    ).toBe("available");
  });

  it("does not inspect or depend on the duplicate standalone computer-use MCP", () => {
    const config = {
      config: {
        mcp_servers: {
          node_repl: { enabled: true },
          "computer-use": { enabled: false },
        },
      },
      origins: {},
    } as CodexSchema.V2ConfigReadResponse;
    expect(inspectNodeReplState({ config, mcpStatus: mcpStatus() })).toBe("available");
  });
});

describe("Codex Computer Use skill discovery", () => {
  const PLUGIN_SKILL_PATH =
    "/Users/test/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000366/skills/computer-use/SKILL.md";

  const skillsResponse = (
    skills: ReadonlyArray<{ name: string; path: string; enabled: boolean }>,
  ) =>
    ({
      data: [{ cwd: "/tmp/project", skills }],
    }) as unknown as CodexSchema.V2SkillsListResponse;

  it("accepts the unqualified skill name returned by older Codex app-servers", () => {
    const skill = findComputerUseSkill(
      skillsResponse([{ name: "computer-use", path: PLUGIN_SKILL_PATH, enabled: true }]),
      "/tmp/project",
    );
    expect(skill?.name).toBe("computer-use");
  });

  it("accepts the qualified plugin skill name returned by current Codex app-servers", () => {
    const skill = findComputerUseSkill(
      skillsResponse([
        { name: "other-skill", path: "/tmp/skills/other-skill/SKILL.md", enabled: true },
        { name: "computer-use:computer-use", path: PLUGIN_SKILL_PATH, enabled: true },
      ]),
      "/tmp/project",
    );
    expect(skill?.name).toBe("computer-use:computer-use");
  });

  it("rejects namespaced skills from unrelated plugins even with the same final segment", () => {
    expect(
      isComputerUseSkill({
        name: "unrelated-plugin:computer-use",
        path: "/Users/test/.codex/plugins/cache/vendor/unrelated-plugin/2.0.0/skills/computer-use/SKILL.md",
      }),
    ).toBe(false);
    expect(
      isComputerUseSkill({
        name: "computer-use:something-else",
        path: PLUGIN_SKILL_PATH,
      }),
    ).toBe(false);
  });
});

describe("Codex Computer Use diagnostic", () => {
  it("parses successful diagnostic metadata without accepting UI payloads", () => {
    const payload = {
      failureCategory: null,
      metadata: {
        runtimeInitialized: true,
        appDiscoverySucceeded: true,
        discoveredAppCount: 14,
        targetAppFound: true,
        targetKind: "t3-electron-dev",
        accessibilityAvailable: true,
        accessibilityTextLength: 812,
        screenshotAvailable: true,
      },
    };
    const parsed = parseComputerUseDiagnosticResponse({
      content: [{ type: "text", text: `T3_COMPUTER_USE_DIAGNOSTIC:${JSON.stringify(payload)}` }],
    });
    expect(parsed).toEqual(payload);
    expect(JSON.stringify(parsed)).not.toContain("screenshot.url");
    expect(JSON.stringify(parsed)).not.toContain('"text"');
  });

  it("rejects malformed or privacy-unsafe payload shapes", () => {
    const parsed = parseComputerUseDiagnosticResponse({
      content: [
        {
          type: "text",
          text: `T3_COMPUTER_USE_DIAGNOSTIC:${JSON.stringify({
            failureCategory: null,
            metadata: {
              runtimeInitialized: true,
              appDiscoverySucceeded: true,
              discoveredAppCount: 1,
              targetAppFound: true,
              targetKind: "t3-packaged",
              accessibilityAvailable: true,
              accessibilityTextLength: 6,
              screenshotAvailable: true,
              text: "secret",
              screenshot: { url: "data:image/png;base64,secret" },
            },
          })}`,
        },
      ],
    });
    expect(parsed).toBeUndefined();
  });

  it("loads only the plugin wrapper and emits aggregate metadata", () => {
    const script = buildComputerUseDiagnosticScript("/tmp/plugin/scripts/computer-use-client.mjs");
    expect(script).toContain("computer-use-client.mjs");
    expect(script).not.toContain('import("@oai/sky")');
    expect(script).not.toContain("state.text }");
    expect(script).not.toContain("screenshot.url }");
    expect(script).toContain("accessibilityTextLength");
    expect(script).toContain("screenshotAvailable");
  });

  it("targets both the packaged app and the dev Electron host deterministically", () => {
    const script = buildComputerUseDiagnosticScript("/tmp/plugin/scripts/computer-use-client.mjs", {
      kind: "t3-electron-dev",
      bundleId: "com.t3tools.t3code.dev.t3code",
    });
    expect(script).toContain('"com.t3tools.t3code"');
    expect(script).toContain('"com.github.Electron"');
    expect(script).toContain('"com.t3tools.t3code.dev"');
    expect(script).toContain('"com.t3tools.t3code.dev.t3code"');
    expect(script).toContain("targetKind");
    expect(script).toContain("t3code-dev://");
  });

  it("resolves host context from explicit desktop environment variables", () => {
    expect(
      resolveComputerUseHostContext({
        T3CODE_COMPUTER_USE_HOST_KIND: "t3-electron-dev",
        T3CODE_COMPUTER_USE_HOST_BUNDLE_ID: "com.t3tools.t3code.dev.t3code",
      }),
    ).toEqual({ kind: "t3-electron-dev", bundleId: "com.t3tools.t3code.dev.t3code" });
    expect(
      resolveComputerUseHostContext({
        T3CODE_COMPUTER_USE_HOST_KIND: "t3-packaged",
        T3CODE_COMPUTER_USE_HOST_BUNDLE_ID: "  ",
      }),
    ).toEqual({ kind: "t3-packaged", bundleId: undefined });
    expect(resolveComputerUseHostContext({})).toEqual({ kind: "unknown", bundleId: undefined });
  });
});
