// @effect-diagnostics nodeBuiltinImport:off - This macOS native resolver is a bounded Promise adapter used by the Electron capture boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const MacWindow = Schema.Struct({
  windowId: Schema.Number,
  processId: Schema.Number,
  appId: Schema.String,
  appName: Schema.String,
});
export type MacWindow = typeof MacWindow.Type;
const decodeWindows = Schema.decodeUnknownSync(Schema.Array(MacWindow));

// AppKit resolves the exact bundle ID to processes. CoreGraphics supplies
// their window IDs in front-to-back order, including covered app windows.
// The target travels as argv, never executable script text.
const MAC_WINDOW_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(args) {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var owners = {};
  var identities = {};
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var bundle = ObjC.unwrap(app.bundleIdentifier);
    var name = ObjC.unwrap(app.localizedName);
    var path = app.bundleURL ? ObjC.unwrap(app.bundleURL.path) : undefined;
    if (args[0] !== bundle && args[0] !== name && args[0] !== path) continue;
    identities[bundle || path] = true;
    owners[app.processIdentifier] = name;
  }
  if (Object.keys(identities).length > 1) throw Error('Ambiguous app identity. Use its bundle ID or absolute app path.');
  var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0)));
  if (!Array.isArray(windows)) throw Error('Window metadata unavailable. Check Screen Recording permission.');
  return JSON.stringify(windows.filter(function(w) {
    return owners[w.kCGWindowOwnerPID] !== undefined && w.kCGWindowLayer === 0 &&
      w.kCGWindowBounds.Width > 1 && w.kCGWindowBounds.Height > 1;
  }).map(function(w) {
    return {windowId:w.kCGWindowNumber, processId:w.kCGWindowOwnerPID,
      appId:args[0], appName:owners[w.kCGWindowOwnerPID]};
  }));
}`;

export async function resolveMacWindows(appId: string): Promise<readonly MacWindow[]> {
  const { stdout } = await execute(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MAC_WINDOW_SCRIPT, appId],
    {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return decodeWindows(JSON.parse(stdout));
}

export function selectMacWindowSource<T extends { id: string }>(
  appId: string,
  windows: readonly MacWindow[],
  sources: readonly T[],
): { source: T; appName: string } | undefined {
  for (const window of windows) {
    if (window.appId !== appId) continue;
    const source = sources.find((candidate) => {
      const match = /^window:(\d+):\d+$/.exec(candidate.id);
      return match !== null && Number(match[1]) === window.windowId;
    });
    if (source) return { source, appName: window.appName };
  }
  return undefined;
}
