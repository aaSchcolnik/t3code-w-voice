import { RemotePreviewDeviceClipboardResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const nativeBridge = () =>
  (
    window as Window & {
      ReactNativeWebView?: { postMessage: (data: string) => void };
    }
  ).ReactNativeWebView;
let nextRequestId = 0;

function nativeClipboard(action: "read" | "write", text?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = ++nextRequestId;
    const finish = () => {
      window.removeEventListener("t3-device-clipboard", receive);
      clearTimeout(timer);
    };
    const receive = (event: Event) => {
      const result = decodeClipboardResult((event as CustomEvent).detail);
      if (result._tag === "None" || result.value.requestId !== requestId) return;
      finish();
      if (result.value.error) reject(new Error(result.value.error));
      else resolve(result.value.text ?? "");
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("The device clipboard did not respond."));
    }, 10_000);
    window.addEventListener("t3-device-clipboard", receive);
    nativeBridge()?.postMessage(
      JSON.stringify({ type: "deviceClipboard", requestId, action, text }),
    );
  });
}

const decodeClipboardResult = Schema.decodeUnknownOption(RemotePreviewDeviceClipboardResult);

/** Begin the write during the gesture; Safari accepts a promised clipboard item. */
export async function copyRemoteSelection(read: () => Promise<string>): Promise<void> {
  if (nativeBridge()) {
    const text = await read();
    if (!text) throw new Error("Select text in the remote page first.");
    await nativeClipboard("write", text);
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error(
      "Clipboard access is unavailable here. Open the viewer over HTTPS to copy text.",
    );
  }
  const text = read().then((value) => {
    if (!value) throw new Error("Select text in the remote page first.");
    return new Blob([value], { type: "text/plain" });
  });
  // Observe a failed read even when the browser rejects the write immediately.
  void text.catch(() => undefined);
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
}

export async function pasteDeviceClipboard(send: (text: string) => void): Promise<void> {
  if (nativeBridge()) {
    const text = await nativeClipboard("read");
    if (text) send(text);
    return;
  }
  if (!navigator.clipboard?.readText) {
    throw new Error("Use Paste from your device's keyboard to paste text into the stream.");
  }
  const text = await navigator.clipboard.readText();
  if (text) send(text);
}
