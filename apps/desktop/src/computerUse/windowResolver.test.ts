import { describe, expect, it } from "vite-plus/test";
import { selectMacWindowSource } from "./windowResolver.ts";

const window = { windowId: 42, processId: 12, appId: "com.apple.TextEdit", appName: "TextEdit" };
describe("Mac window ownership", () => {
  it("matches CoreGraphics window IDs and ignores misleading titles", () => {
    const sources = [
      { id: "window:40:0", name: "TextEdit" },
      { id: "window:42:0", name: "Untitled" },
    ];
    expect(selectMacWindowSource(window.appId, [window], sources)?.source).toBe(sources[1]);
  });
  it("does not fallback to another app or a desktop source", () => {
    expect(selectMacWindowSource("other.app", [window], [{ id: "window:42:0" }])).toBeUndefined();
    expect(selectMacWindowSource(window.appId, [window], [{ id: "screen:42:0" }])).toBeUndefined();
  });
  it("chooses the first capturable window owned by the requested app", () => {
    const sources = [{ id: "window:43:0" }];
    expect(
      selectMacWindowSource(window.appId, [window, { ...window, windowId: 43 }], sources)?.source,
    ).toBe(sources[0]);
  });
});
