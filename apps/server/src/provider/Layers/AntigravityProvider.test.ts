import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AntigravitySettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  checkAntigravityProviderStatus,
  isSupportedAntigravityVersion,
  parseAntigravityModels,
} from "./AntigravityProvider.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it("parses legacy and tab-separated model listings", () => {
  assert.deepEqual(
    parseAntigravityModels(
      [
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
        "claude-sonnet-4-6",
        "gpt-oss-120b-medium  GPT-OSS 120B (Medium)",
        "gemini-3.7-flash-high\tduplicate",
        "",
      ].join("\n"),
    ).map(({ slug, name }) => ({ slug, name })),
    [
      { slug: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
      { slug: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      { slug: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  );
});

it("enforces the structured-output version floor", () => {
  assert.equal(isSupportedAntigravityVersion("1.1.7"), false);
  assert.equal(isSupportedAntigravityVersion("1.1.8"), true);
  assert.equal(isSupportedAntigravityVersion("2.0.0"), true);
  assert.equal(isSupportedAntigravityVersion(null), false);
});

it.layer(NodeServices.layer)("Antigravity provider probe", (it) => {
  it.effect("discovers version, models, and API-key authentication", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-probe-" });
      const binaryPath = path.join(tempDir, "agy");
      const settingsDir = path.join(tempDir, ".gemini", "antigravity-cli");
      yield* fileSystem.makeDirectory(settingsDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(settingsDir, "settings.json"),
        encodeJson({ modelProvider: "gemini" }),
      );
      yield* fileSystem.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "agy 1.1.20"; exit 0; fi',
          'if [ "$1" = "models" ]; then printf "gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n"; exit 0; fi',
          "exit 1",
          "",
        ].join("\n"),
      );
      yield* fileSystem.chmod(binaryPath, 0o755);

      const snapshot = yield* checkAntigravityProviderStatus(
        decodeSettings({ enabled: true, binaryPath }),
        { ...process.env, HOME: tempDir, GEMINI_API_KEY: "test-key" },
      );

      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.version, "1.1.20");
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["gemini-3.7-flash-high"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("gates binaries older than structured headless output", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-old-" });
      const binaryPath = path.join(tempDir, "agy");
      yield* fileSystem.writeFileString(binaryPath, "#!/bin/sh\necho 'agy 1.1.7'\n");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const snapshot = yield* checkAntigravityProviderStatus(
        decodeSettings({ enabled: true, binaryPath }),
        { ...process.env, HOME: tempDir },
      );

      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.version, "1.1.7");
      assert.equal(snapshot.delegation?.available, false);
      assert.match(snapshot.message ?? "", /1\.1\.8/);
    }).pipe(Effect.scoped),
  );
});
