import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  copyRemoteSelection,
  listenForRemotePreviewClipboard,
  pasteDeviceClipboard,
} from "./remotePreviewClipboard";

afterEach(() => vi.unstubAllGlobals());

class RemoteInput extends EventTarget {
  dataset: Record<string, string> = { remoteInput: "" };
}

function clipboardRig() {
  vi.stubGlobal("HTMLElement", RemoteInput);
  vi.stubGlobal("navigator", {});
  const root = new RemoteInput();
  const copy = vi.fn();
  const paste = vi.fn();
  let enabled = true;
  const remove = listenForRemotePreviewClipboard(root as unknown as HTMLElement, {
    canSendInput: () => enabled,
    copy,
    paste,
  });
  const pasteEvent = (text = "from the iPad") =>
    Object.assign(new Event("paste", { cancelable: true }), {
      clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
    });
  return {
    root,
    copy,
    paste,
    pasteEvent,
    remove,
    disable: () => {
      enabled = false;
    },
  };
}

it.each([
  { key: "v", metaKey: true },
  { key: "v", ctrlKey: true },
  { key: "V", ctrlKey: true, shiftKey: true },
  { key: "Insert", shiftKey: true },
])("allows native paste for $key without async clipboard access", (chord) => {
  const rig = clipboardRig();
  for (const type of ["keydown", "keyup"]) {
    const key = Object.assign(new Event(type, { cancelable: true }), chord);
    const stopPropagation = vi.spyOn(key, "stopPropagation");
    rig.root.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(stopPropagation).toHaveBeenCalledOnce();
  }
  expect(rig.paste).not.toHaveBeenCalled();
  const event = rig.pasteEvent("clipboard without navigator.clipboard");
  rig.root.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(rig.paste).toHaveBeenCalledExactlyOnceWith("clipboard without navigator.clipboard");
  rig.remove();
});

it("handles an iPad native Paste action without a key event and detaches on cleanup", () => {
  const rig = clipboardRig();
  const event = rig.pasteEvent();
  rig.root.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(rig.paste).toHaveBeenCalledExactlyOnceWith("from the iPad");
  rig.remove();
  const afterCleanup = rig.pasteEvent();
  rig.root.dispatchEvent(afterCleanup);
  expect(afterCleanup.defaultPrevented).toBe(false);
  expect(rig.paste).toHaveBeenCalledOnce();
});

it("leaves viewer chrome and non-controlling viewers alone", () => {
  const rig = clipboardRig();
  delete rig.root.dataset.remoteInput;
  const chromePaste = rig.pasteEvent();
  rig.root.dispatchEvent(chromePaste);
  expect(chromePaste.defaultPrevented).toBe(false);
  rig.root.dataset.remoteInput = "";
  rig.disable();
  const spectatorPaste = rig.pasteEvent();
  rig.root.dispatchEvent(spectatorPaste);
  expect(spectatorPaste.defaultPrevented).toBe(false);
  expect(rig.paste).not.toHaveBeenCalled();
  rig.remove();
});

it("keeps copy shortcuts on the device and ignores key repeats", () => {
  const rig = clipboardRig();
  for (const [type, repeat] of [
    ["keydown", false],
    ["keydown", true],
    ["keyup", false],
  ] as const) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      key: "c",
      metaKey: true,
      repeat,
    });
    rig.root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(rig.copy).toHaveBeenCalledOnce();
  rig.remove();
});

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
