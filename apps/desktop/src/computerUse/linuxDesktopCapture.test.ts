import { describe, expect, it, vi } from "vite-plus/test";
import { resolveLinuxDesktopCapture } from "./linuxDesktopCapture.ts";

const desktop = { kind: "desktop" } as const;
describe("explicit Linux desktop capture", () => {
  it("never opens a portal or falls back to desktop for an app target", async () => {
    const getSources = vi.fn(async () => [{ id: "screen:1:0", name: "Display 1" }]);
    await expect(
      resolveLinuxDesktopCapture(
        { kind: "app", appId: "org.gnome.TextEditor" },
        {
          getSources,
          selectSource: async () => null,
        },
      ),
    ).rejects.toThrow("explicit desktop-sharing operation");
    expect(getSources).not.toHaveBeenCalled();
  });
  it("uses the one portal-selected source and labels the actual desktop scope", async () => {
    const selectSource = vi.fn(async () => null);
    await expect(
      resolveLinuxDesktopCapture(desktop, {
        getSources: async () => [{ id: "screen:chosen:0", name: "Portal choice" }],
        selectSource,
      }),
    ).resolves.toEqual({
      sourceId: "screen:chosen:0",
      appName: "Shared desktop",
      scope: "desktop",
    });
    expect(selectSource).not.toHaveBeenCalled();
  });
  it("requires an explicit selection among multiple X11 displays", async () => {
    const sources = [
      { id: "screen:1:0", name: "Display 1" },
      { id: "screen:2:0", name: "Display 2" },
    ];
    const selectSource = vi.fn(async () => sources[1]!.id);
    await expect(
      resolveLinuxDesktopCapture(desktop, { getSources: async () => sources, selectSource }),
    ).resolves.toMatchObject({ sourceId: "screen:2:0" });
    expect(selectSource).toHaveBeenCalledWith(sources);
  });
  it("reports declined portal access without selecting anything else", async () => {
    await expect(
      resolveLinuxDesktopCapture(desktop, {
        getSources: async () => [],
        selectSource: async () => "screen:1:0",
      }),
    ).rejects.toThrow("No desktop was shared");
  });
  it("preserves display selection cancellation", async () => {
    await expect(
      resolveLinuxDesktopCapture(desktop, {
        getSources: async () => [
          { id: "1", name: "one" },
          { id: "2", name: "two" },
        ],
        selectSource: async () => null,
      }),
    ).rejects.toThrow("cancelled");
  });
  it("rejects selections outside the enumerated sources", async () => {
    await expect(
      resolveLinuxDesktopCapture(desktop, {
        getSources: async () => [
          { id: "1", name: "one" },
          { id: "2", name: "two" },
        ],
        selectSource: async () => "3",
      }),
    ).rejects.toThrow("no longer available");
  });
});
