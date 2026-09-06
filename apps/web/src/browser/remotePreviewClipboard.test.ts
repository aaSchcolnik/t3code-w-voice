import { afterEach, expect, it, vi } from "vite-plus/test";
import { copyRemoteSelection, pasteDeviceClipboard } from "./remotePreviewClipboard";

afterEach(() => vi.unstubAllGlobals());

it("starts the Safari clipboard write before the remote selection arrives", async () => {
  vi.stubGlobal("window", {});
  let deliver!: (text: string) => void;
  const selected = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  let contents: Promise<Blob> | undefined;
  vi.stubGlobal("ClipboardItem", function (items: Record<string, Promise<Blob>>) {
    contents = items["text/plain"];
  });
  const write = vi.fn(async () => {
    await contents;
  });
  vi.stubGlobal("navigator", { clipboard: { write } });
  const copy = copyRemoteSelection(() => selected);
  expect(write).toHaveBeenCalledOnce();
  deliver("remote selection");
  await copy;
  expect(await (await contents!).text()).toBe("remote selection");
});

it("pastes the viewing device's clipboard text", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { clipboard: { readText: async () => "device clipboard" } });
  const send = vi.fn();
  await pasteDeviceClipboard(send);
  expect(send).toHaveBeenCalledWith("device clipboard");
});

it("uses the native device clipboard when hosted in the mobile app", async () => {
  const windowMock = Object.assign(new EventTarget(), {
    ReactNativeWebView: {
      postMessage: vi.fn((data: string) => {
        const request = JSON.parse(data);
        windowMock.dispatchEvent(
          Object.assign(new Event("t3-device-clipboard"), {
            detail: {
              requestId: request.requestId,
              text: request.action === "read" ? "native clipboard" : null,
              error: null,
            },
          }),
        );
      }),
    },
  });
  vi.stubGlobal("window", windowMock);
  await copyRemoteSelection(async () => "selected on desktop");
  const send = vi.fn();
  await pasteDeviceClipboard(send);
  expect(JSON.parse(windowMock.ReactNativeWebView.postMessage.mock.calls[0]![0])).toMatchObject({
    action: "write",
    text: "selected on desktop",
  });
  expect(send).toHaveBeenCalledWith("native clipboard");
});
