// @effect-diagnostics nodeBuiltinImport:off - Node-only ASAR rewrite for dlopen; browser entry stays separate.
import * as NodeFS from "node:fs";

/**
 * In packaged Electron builds, `transcribe-cpp`'s loader resolves the native
 * library via `require.resolve` — which returns a path *inside* `app.asar`.
 * Electron's fs shim makes `contract.json` readable there, but `dlopen` and
 * native backend init have zero ASAR awareness (app.asar is a file, so path
 * components under it yield ENOTDIR). electron-builder unpacks
 * `@transcribe-cpp` / `transcribe-cpp` / `koffi` to the `app.asar.unpacked`
 * sibling (see `DESKTOP_ASAR_UNPACK` in `scripts/build-desktop-artifact.ts`).
 * The only injection point is `TRANSCRIBE_LIBRARY`; we resolve via
 * `artifactDir()` (no dlopen) and redirect that env var to the unpacked file.
 *
 * The library file name is discovered by probing the unpacked directory rather
 * than branching on the host platform: a platform package ships exactly one
 * library, and probing keeps this module free of a direct runtime platform read
 * (see `HostProcessPlatform` in `packages/shared/src/hostProcess.ts`, which is
 * Effect-only and unavailable to this plain helper).
 */

export const ASAR_DIRECTORY_NAME = "app.asar";
export const ASAR_UNPACKED_DIRECTORY_NAME = "app.asar.unpacked";

/** Mirrors `LIB_NAME` in transcribe-cpp's `dist/loader.js`. */
export const TRANSCRIBE_LIBRARY_FILE_NAMES = [
  "libtranscribe.dylib",
  "transcribe.dll",
  "libtranscribe.so",
] as const;

export type AsarTranscribeLibraryOutcome =
  | { readonly kind: "not-packaged" }
  | { readonly kind: "already-overridden"; readonly libraryPath: string }
  | { readonly kind: "resolve-failed"; readonly error: unknown }
  | {
      readonly kind: "unpacked-missing";
      readonly unpackedDir: string;
      readonly candidatePaths: ReadonlyArray<string>;
    }
  | { readonly kind: "redirected"; readonly libraryPath: string };

export type ResolveAsarTranscribeLibraryInput = {
  readonly artifactDir: string;
  readonly existingOverride: string | undefined;
  readonly fileExists: (path: string) => boolean;
  /** Narrows the probe to a single file name; omit to try every known name. */
  readonly platform?: NodeJS.Platform;
};

export type ApplyAsarTranscribeLibraryDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly fileExists?: (path: string) => boolean;
};

export type TranscribeCppBindingWithArtifactDir = {
  readonly artifactDir?: () => string;
};

export class UnpackedTranscribeLibraryMissingError extends Error {
  override readonly name = "UnpackedTranscribeLibraryMissingError";
  readonly unpackedDir: string;
  readonly candidatePaths: ReadonlyArray<string>;

  constructor(unpackedDir: string, candidatePaths: ReadonlyArray<string>) {
    super(
      `transcribe-cpp resolved into an app.asar archive, but no unpacked native library exists in ${unpackedDir}. ` +
        `dlopen cannot read inside an asar, so the library must be unpacked — check DESKTOP_ASAR_UNPACK in ` +
        `scripts/build-desktop-artifact.ts. Looked for: ${candidatePaths.join(", ")}.`,
    );
    this.unpackedDir = unpackedDir;
    this.candidatePaths = candidatePaths;
  }
}

export function transcribeLibraryFileName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "libtranscribe.dylib";
  if (platform === "win32") return "transcribe.dll";
  return "libtranscribe.so";
}

// Lookbehind/lookahead keep this an exact path-segment match, so a directory
// merely containing the text (`my-app.asar-backup`) is never rewritten.
const ASAR_SEGMENT_PATTERN = /(?<=^|[/\\])app\.asar(?=[/\\]|$)/gu;

const isPathSeparator = (character: string): boolean => character === "/" || character === "\\";

type RewrittenAsarDirectory = {
  readonly directory: string;
  readonly separator: string;
};

/**
 * Rewrites the *last* `app.asar` segment in place. Splicing the original string
 * (rather than splitting and rejoining) preserves every other separator
 * verbatim, so mixed-separator Windows paths survive untouched.
 */
function rewriteAsarDirectory(artifactDir: string): RewrittenAsarDirectory | undefined {
  const lastMatch = [...artifactDir.matchAll(ASAR_SEGMENT_PATTERN)].at(-1);
  if (lastMatch?.index === undefined) return undefined;

  const start = lastMatch.index;
  const end = start + ASAR_DIRECTORY_NAME.length;
  const directory =
    artifactDir.slice(0, start) + ASAR_UNPACKED_DIRECTORY_NAME + artifactDir.slice(end);

  const following = artifactDir.charAt(end);
  const preceding = start > 0 ? artifactDir.charAt(start - 1) : "";
  const separator = isPathSeparator(following)
    ? following
    : isPathSeparator(preceding)
      ? preceding
      : "/";

  return { directory, separator };
}

export function resolveAsarTranscribeLibrary(
  input: ResolveAsarTranscribeLibraryInput,
): AsarTranscribeLibraryOutcome {
  const existing = input.existingOverride?.trim();
  if (existing !== undefined && existing.length > 0) {
    return { kind: "already-overridden", libraryPath: existing };
  }

  const rewritten = rewriteAsarDirectory(input.artifactDir);
  if (rewritten === undefined) {
    return { kind: "not-packaged" };
  }

  const fileNames =
    input.platform === undefined
      ? TRANSCRIBE_LIBRARY_FILE_NAMES
      : [transcribeLibraryFileName(input.platform)];
  const candidatePaths = fileNames.map(
    (fileName) => `${rewritten.directory}${rewritten.separator}${fileName}`,
  );

  const libraryPath = candidatePaths.find((candidate) => input.fileExists(candidate));
  if (libraryPath === undefined) {
    return { kind: "unpacked-missing", unpackedDir: rewritten.directory, candidatePaths };
  }
  return { kind: "redirected", libraryPath };
}

/**
 * Points `TRANSCRIBE_LIBRARY` at the unpacked library when `binding` resolved
 * into an asar archive. Must run after the module is imported (it needs
 * `artifactDir()`, which does not dlopen) and before the first native load,
 * which caches the resolved binding.
 *
 * Throws `UnpackedTranscribeLibraryMissingError` when the archive path is real
 * but nothing was unpacked: the subsequent load could only fail with an opaque
 * ENOTDIR from dlopen, so an actionable error is strictly better. A failing
 * `artifactDir()` is swallowed — the library's own error is already accurate and
 * surfaces on load.
 */
export function applyAsarTranscribeLibraryOverride(
  binding: TranscribeCppBindingWithArtifactDir,
  deps: ApplyAsarTranscribeLibraryDeps = {},
): AsarTranscribeLibraryOutcome {
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? ((path) => NodeFS.existsSync(path));

  if (typeof binding.artifactDir !== "function") {
    return { kind: "not-packaged" };
  }

  let artifactDir: string;
  try {
    artifactDir = binding.artifactDir();
  } catch (error) {
    return { kind: "resolve-failed", error };
  }

  const outcome = resolveAsarTranscribeLibrary({
    artifactDir,
    existingOverride: env.TRANSCRIBE_LIBRARY,
    fileExists,
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });

  if (outcome.kind === "redirected") {
    env.TRANSCRIBE_LIBRARY = outcome.libraryPath;
  }
  if (outcome.kind === "unpacked-missing") {
    throw new UnpackedTranscribeLibraryMissingError(outcome.unpackedDir, outcome.candidatePaths);
  }

  return outcome;
}
