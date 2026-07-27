import { describe, expect, it } from "vite-plus/test";

import {
  ASAR_DIRECTORY_NAME,
  ASAR_UNPACKED_DIRECTORY_NAME,
  applyAsarTranscribeLibraryOverride,
  resolveAsarTranscribeLibrary,
  TRANSCRIBE_LIBRARY_FILE_NAMES,
  transcribeLibraryFileName,
  UnpackedTranscribeLibraryMissingError,
} from "./transcribeLibrary.ts";

describe("transcribeLibraryFileName", () => {
  it("mirrors transcribe-cpp loader library names per platform", () => {
    expect(transcribeLibraryFileName("darwin")).toBe("libtranscribe.dylib");
    expect(transcribeLibraryFileName("win32")).toBe("transcribe.dll");
    expect(transcribeLibraryFileName("linux")).toBe("libtranscribe.so");
    expect(transcribeLibraryFileName("freebsd")).toBe("libtranscribe.so");
  });
});

describe("resolveAsarTranscribeLibrary", () => {
  it("redirects a darwin packaged path to the unpacked sibling dylib", () => {
    const artifactDir = `/Applications/T3 Code.app/Contents/Resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`;
    const expected = `/Applications/T3 Code.app/Contents/Resources/${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        platform: "darwin",
        existingOverride: undefined,
        fileExists: (path) => path === expected,
      }),
    ).toEqual({ kind: "redirected", libraryPath: expected });
  });

  it("preserves win32 backslash separators and uses transcribe.dll", () => {
    const artifactDir = `C:\\Program Files\\T3 Code\\resources\\${ASAR_DIRECTORY_NAME}\\node_modules\\@transcribe-cpp\\win32-x64-cpu-vulkan`;
    const expected = `C:\\Program Files\\T3 Code\\resources\\${ASAR_UNPACKED_DIRECTORY_NAME}\\node_modules\\@transcribe-cpp\\win32-x64-cpu-vulkan\\transcribe.dll`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        platform: "win32",
        existingOverride: undefined,
        fileExists: (path) => path === expected,
      }),
    ).toEqual({ kind: "redirected", libraryPath: expected });
  });

  it("redirects a linux packaged path to libtranscribe.so", () => {
    const artifactDir = `/opt/T3Code/resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/linux-x64-cpu-vulkan`;
    const expected = `/opt/T3Code/resources/${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/linux-x64-cpu-vulkan/libtranscribe.so`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        platform: "linux",
        existingOverride: undefined,
        fileExists: (path) => path === expected,
      }),
    ).toEqual({ kind: "redirected", libraryPath: expected });
  });

  it("returns not-packaged for a dev-tree path without an app.asar segment", () => {
    expect(
      resolveAsarTranscribeLibrary({
        artifactDir: "/Users/dev/t3code/node_modules/@transcribe-cpp/darwin-arm64-metal",
        platform: "darwin",
        existingOverride: undefined,
        fileExists: () => true,
      }),
    ).toEqual({ kind: "not-packaged" });
  });

  it("returns already-overridden when TRANSCRIBE_LIBRARY is pre-set", () => {
    expect(
      resolveAsarTranscribeLibrary({
        artifactDir: `/app/resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`,
        platform: "darwin",
        existingOverride: "/custom/libtranscribe.dylib",
        fileExists: () => true,
      }),
    ).toEqual({
      kind: "already-overridden",
      libraryPath: "/custom/libtranscribe.dylib",
    });
  });

  it("returns unpacked-missing when the rewritten file is absent", () => {
    const artifactDir = `/Applications/T3 Code.app/Contents/Resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`;
    const unpackedDir = `/Applications/T3 Code.app/Contents/Resources/${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        platform: "darwin",
        existingOverride: undefined,
        fileExists: () => false,
      }),
    ).toEqual({
      kind: "unpacked-missing",
      unpackedDir,
      candidatePaths: [`${unpackedDir}/libtranscribe.dylib`],
    });
  });

  it("probes every known library name when no platform is supplied", () => {
    const artifactDir = `/opt/T3Code/resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/linux-x64-cpu-vulkan`;
    const expected = `/opt/T3Code/resources/${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/linux-x64-cpu-vulkan/libtranscribe.so`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        existingOverride: undefined,
        fileExists: (path) => path === expected,
      }),
    ).toEqual({ kind: "redirected", libraryPath: expected });
  });

  it("lists every candidate name in unpacked-missing when probing", () => {
    const artifactDir = `/opt/T3Code/resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/linux-x64-cpu-vulkan`;
    const unpackedDir = `/opt/T3Code/resources/${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/linux-x64-cpu-vulkan`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        existingOverride: undefined,
        fileExists: () => false,
      }),
    ).toEqual({
      kind: "unpacked-missing",
      unpackedDir,
      candidatePaths: TRANSCRIBE_LIBRARY_FILE_NAMES.map((name) => `${unpackedDir}/${name}`),
    });
  });

  it("preserves mixed separators outside the rewritten segment", () => {
    const artifactDir = `C:\\T3 Code\\resources\\${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan`;
    const expected = `C:\\T3 Code\\resources\\${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan/transcribe.dll`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        platform: "win32",
        existingOverride: undefined,
        fileExists: (path) => path === expected,
      }),
    ).toEqual({ kind: "redirected", libraryPath: expected });
  });

  it("rewrites only the last app.asar path segment", () => {
    const artifactDir = `/tmp/${ASAR_DIRECTORY_NAME}/mirror/resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`;
    const expected = `/tmp/${ASAR_DIRECTORY_NAME}/mirror/resources/${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib`;

    expect(
      resolveAsarTranscribeLibrary({
        artifactDir,
        platform: "darwin",
        existingOverride: undefined,
        fileExists: (path) => path === expected,
      }),
    ).toEqual({ kind: "redirected", libraryPath: expected });
  });

  it("does not match a segment that merely contains app.asar", () => {
    expect(
      resolveAsarTranscribeLibrary({
        artifactDir:
          "/Users/dev/my-app.asar-backup/node_modules/@transcribe-cpp/darwin-arm64-metal",
        platform: "darwin",
        existingOverride: undefined,
        fileExists: () => true,
      }),
    ).toEqual({ kind: "not-packaged" });
  });
});

describe("applyAsarTranscribeLibraryOverride", () => {
  it("returns not-packaged when binding.artifactDir is missing", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyAsarTranscribeLibraryOverride({}, { env, fileExists: () => true })).toEqual({
      kind: "not-packaged",
    });
    expect(env.TRANSCRIBE_LIBRARY).toBeUndefined();
  });

  it("returns resolve-failed when artifactDir throws and leaves env untouched", () => {
    const env: NodeJS.ProcessEnv = {};
    const error = new Error("no native package");
    const outcome = applyAsarTranscribeLibraryOverride(
      {
        artifactDir: () => {
          throw error;
        },
      },
      { env, platform: "darwin", fileExists: () => true },
    );
    expect(outcome).toEqual({ kind: "resolve-failed", error });
    expect(env.TRANSCRIBE_LIBRARY).toBeUndefined();
  });

  it("sets TRANSCRIBE_LIBRARY on redirected and is idempotent on a second call", () => {
    const artifactDir = `/Applications/T3 Code.app/Contents/Resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`;
    const expected = `/Applications/T3 Code.app/Contents/Resources/${ASAR_UNPACKED_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib`;
    const env: NodeJS.ProcessEnv = {};
    const binding = { artifactDir: () => artifactDir };
    const deps = {
      env,
      platform: "darwin" as const,
      fileExists: (path: string) => path === expected,
    };

    expect(applyAsarTranscribeLibraryOverride(binding, deps)).toEqual({
      kind: "redirected",
      libraryPath: expected,
    });
    expect(env.TRANSCRIBE_LIBRARY).toBe(expected);

    expect(applyAsarTranscribeLibraryOverride(binding, deps)).toEqual({
      kind: "already-overridden",
      libraryPath: expected,
    });
    expect(env.TRANSCRIBE_LIBRARY).toBe(expected);
  });

  it("throws an actionable error and leaves env unset when nothing was unpacked", () => {
    const env: NodeJS.ProcessEnv = {};
    const call = () =>
      applyAsarTranscribeLibraryOverride(
        {
          artifactDir: () =>
            `/Applications/T3 Code.app/Contents/Resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`,
        },
        { env, platform: "darwin", fileExists: () => false },
      );

    expect(call).toThrow(UnpackedTranscribeLibraryMissingError);
    expect(call).toThrow(/DESKTOP_ASAR_UNPACK/u);
    expect(env.TRANSCRIBE_LIBRARY).toBeUndefined();
  });

  it("leaves a pre-set TRANSCRIBE_LIBRARY untouched", () => {
    const env: NodeJS.ProcessEnv = { TRANSCRIBE_LIBRARY: "/custom/libtranscribe.dylib" };
    expect(
      applyAsarTranscribeLibraryOverride(
        {
          artifactDir: () =>
            `/Applications/T3 Code.app/Contents/Resources/${ASAR_DIRECTORY_NAME}/node_modules/@transcribe-cpp/darwin-arm64-metal`,
        },
        { env, platform: "darwin", fileExists: () => true },
      ),
    ).toEqual({
      kind: "already-overridden",
      libraryPath: "/custom/libtranscribe.dylib",
    });
    expect(env.TRANSCRIBE_LIBRARY).toBe("/custom/libtranscribe.dylib");
  });
});
