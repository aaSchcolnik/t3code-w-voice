import { expect, it } from "@effect/vitest";

import {
  createTerminalSpawnEnv,
  normalizeShellCommand,
  resolveShellCandidates,
} from "./spawnEnv.ts";

it("normalizes POSIX shell commands without carrying shell arguments", () => {
  expect(normalizeShellCommand("'/opt/custom zsh' -l", "darwin")).toBe("/opt/custom");
  expect(normalizeShellCommand("  /bin/zsh -l  ", "darwin")).toBe("/bin/zsh");
  expect(normalizeShellCommand("", "darwin")).toBeNull();
});

it("keeps the requested shell first and de-duplicates fallbacks", () => {
  const candidates = resolveShellCandidates(() => "/bin/zsh", "darwin", {
    SHELL: "/bin/zsh",
  });

  expect(candidates[0]).toEqual({ shell: "/bin/zsh", args: ["-o", "nopromptsp"] });
  expect(candidates.filter((candidate) => candidate.shell === "/bin/zsh")).toHaveLength(1);
});

it("scrubs app variables while preserving runtime overrides", () => {
  const appDir = "/tmp/.mount_T3Code";
  const env = createTerminalSpawnEnv(
    {
      APPIMAGE: "/home/user/T3-Code.AppImage",
      APPDIR: appDir,
      PATH: `${appDir}/usr/bin:/usr/local/bin:/usr/bin`,
      PORT: "5173",
      T3CODE_PORT: "3773",
      VITE_URL: "http://localhost:5173",
      KEEP: "yes",
    },
    { T3CODE_PROJECT_ROOT: "/repo", CUSTOM: "runtime" },
  );

  expect(env).toEqual({
    COLORTERM: "truecolor",
    PATH: "/usr/local/bin:/usr/bin",
    KEEP: "yes",
    T3CODE_PROJECT_ROOT: "/repo",
    CUSTOM: "runtime",
  });
});

it("removes package-runner and node process state from terminal environments", () => {
  const env = createTerminalSpawnEnv({
    HOME: "/home/user",
    PATH: "/repo/node_modules/.bin:/usr/bin",
    NG_LINT_FLAGS: "--concurrency=4",
    NODE_CHANNEL_FD: "3",
    NODE_CHANNEL_SERIALIZATION_MODE: "json",
    NODE_PATH: "/t3code/node_modules",
    NODE_OPTIONS: "--max-old-space-size=4096",
    NODE_REPL_HISTORY: "/tmp/repl-history",
    INIT_CWD: "/t3code",
    PNPM_SCRIPT_SRC_DIR: "/t3code",
    WATCH_REPORT_DEPENDENCIES: "1",
    npm_package_json: "/t3code/package.json",
    npm_lifecycle_event: "dev",
    npm_config_user_agent: "pnpm/10",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
    pnpm_config_verify_deps_before_run: "false",
    PNPM_HOME: "/home/user/.local/share/pnpm",
    COREPACK_HOME: "/home/user/.cache/node/corepack",
  });

  expect(env).toEqual({
    COLORTERM: "truecolor",
    HOME: "/home/user",
    PATH: "/repo/node_modules/.bin:/usr/bin",
    NG_LINT_FLAGS: "--concurrency=4",
  });
});
