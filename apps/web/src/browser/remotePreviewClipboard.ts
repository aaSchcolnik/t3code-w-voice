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

/** Forward device paste events without requiring a separate clipboard read permission. */
export function listenForRemotePreviewClipboard(
  root: HTMLElement,
  options: {
    readonly canSendInput: () => boolean;
    readonly paste: (text: string) => void;
    readonly copy: () => void;
  },
): () => void {
  const isRemoteInput = (target: EventTarget | null) =>
    target instanceof HTMLElement && target.dataset.remoteInput !== undefined;
  const onPaste = (event: ClipboardEvent) => {
    if (!options.canSendInput() || !isRemoteInput(event.target)) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (text) options.paste(text);
  };
  const onKey = (event: KeyboardEvent) => {
    if (!options.canSendInput() || !isRemoteInput(event.target)) return;
    const key = event.key.toLowerCase();
    const paste =
      ((event.metaKey || event.ctrlKey) && !event.altKey && key === "v") ||
      (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && key === "insert");
    if (paste) {
      // Let the device emit paste, including on HTTP and in iOS WebViews.
      // Keep the chord out of the guest, which has a different clipboard.
      event.stopPropagation();
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || key !== "c") return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "keydown" && !event.repeat) options.copy();
  };
  root.addEventListener("paste", onPaste, { capture: true });
  root.addEventListener("keydown", onKey, { capture: true });
  root.addEventListener("keyup", onKey, { capture: true });
  return () => {
    root.removeEventListener("paste", onPaste, { capture: true });
    root.removeEventListener("keydown", onKey, { capture: true });
    root.removeEventListener("keyup", onKey, { capture: true });
  };
}

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
