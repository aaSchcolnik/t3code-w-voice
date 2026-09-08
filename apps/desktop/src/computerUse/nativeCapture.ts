import * as NodeCrypto from "node:crypto";
import { desktopCapturer, dialog, systemPreferences } from "electron";
import { resolveLinuxDesktopCapture } from "./linuxDesktopCapture.ts";
import { makeCaptureController } from "./CaptureController.ts";
import { resolveMacWindows, selectMacWindowSource } from "./windowResolver.ts";

export const nativeCapture = makeCaptureController({
  now: () => performance.now(),
  createId: NodeCrypto.randomUUID,
  authorize: async (input) => {
    const desktop = input.target.kind === "desktop";
    const result = await dialog.showMessageBox({
      type: "question",
      title: "Allow computer-use preview?",
      message: desktop
        ? "Share a live view of your entire display?"
        : "Share live views of apps used in this computer-use session?",
      detail:
        "Connected viewers with computer-use preview access can watch. This allows viewing only, without microphone audio or remote control.",
      buttons: ["Cancel", "Allow preview"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  },
  resolve: async (input) => {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- OS capture API selection at the Electron native boundary.
    const platform = process.platform;
    if (platform === "linux") {
      return resolveLinuxDesktopCapture(input.target, {
        getSources: () =>
          desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }),
        selectSource: async (sources) => {
          const selected = await dialog.showMessageBox({
            type: "question",
            title: "Choose a display to share",
            message: "Which display should connected viewers see?",
            detail:
              "The selected display is shared for this computer-use preview. Other displays are not included.",
            buttons: ["Cancel", ...sources.map((source) => source.name)],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return sources[selected.response - 1]?.id ?? null;
        },
      });
    }
    if (platform !== "darwin") {
      throw new Error("Computer-use preview capture is unavailable on this platform.");
    }
    const access = systemPreferences.getMediaAccessStatus("screen");
    if (access === "denied" || access === "restricted") {
      throw new Error(
        "Allow Screen Recording for T3 Code in macOS System Settings, then restart T3 Code.",
      );
    }
    if (input.target.kind === "desktop") {
      const screens = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (screens.length !== 1)
        throw new Error(
          "Desktop preview requires exactly one display. Select an app for window-only capture.",
        );
      return { sourceId: screens[0]!.id, scope: "desktop" };
    }
    const windows = await resolveMacWindows(input.target.appId);
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const selected = selectMacWindowSource(input.target.appId, windows, sources);
    if (!selected)
      throw new Error(
        "No capturable window belongs to the requested app. The app may be closed or minimized.",
      );
    return { sourceId: selected.source.id, appName: selected.appName, scope: "window" };
  },
});
