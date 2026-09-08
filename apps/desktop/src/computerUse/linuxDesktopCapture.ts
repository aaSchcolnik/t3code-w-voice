import type { ComputerUseCaptureStartInput } from "@t3tools/contracts";
import type { CaptureSource } from "./CaptureController.ts";

export interface DesktopCaptureSource {
  readonly id: string;
  readonly name: string;
}

/**
 * Linux native automation can expose the explicitly shared desktop. Electron
 * delegates source selection to the Wayland portal where available; X11 can
 * enumerate several displays, which require a separate explicit selection.
 * This does not claim automatic app-to-window tracking or portal restoration.
 */
export async function resolveLinuxDesktopCapture(
  target: ComputerUseCaptureStartInput["target"],
  dependencies: {
    getSources: () => Promise<readonly DesktopCaptureSource[]>;
    selectSource: (sources: readonly DesktopCaptureSource[]) => Promise<string | null>;
  },
): Promise<CaptureSource> {
  if (target.kind !== "desktop") {
    throw new Error(
      "Automatic application window tracking is unavailable on Linux. Desktop preview requires an explicit desktop-sharing operation.",
    );
  }
  const sources = await dependencies.getSources();
  if (sources.length === 0) {
    throw new Error("No desktop was shared. Allow screen sharing in the system picker and retry.");
  }
  const sourceId = sources.length === 1 ? sources[0]!.id : await dependencies.selectSource(sources);
  if (!sourceId) throw new Error("Desktop sharing was cancelled.");
  if (!sources.some((source) => source.id === sourceId)) {
    throw new Error("The selected display is no longer available. Reconnect to choose a display.");
  }
  return { sourceId, appName: "Shared desktop", scope: "desktop" };
}
