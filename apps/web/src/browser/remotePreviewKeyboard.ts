/**
 * Keyboard translation for the remote preview viewer.
 *
 * Two sources feed the same control channel. A hardware keyboard produces real
 * `keydown`/`keyup` on the capture layer. The on-screen keyboard cannot be
 * raised by a remote focus, so a button in the chrome row focuses a hidden
 * textarea on a local gesture and its editing events are translated here.
 */
import type { RemotePreviewModifier } from "@t3tools/contracts";

import type { RemotePreviewControlDraft } from "./remotePreviewMessages";

export interface RemotePreviewKeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
}

/** iPad Command and Mac Command both arrive as `metaKey`, which CDP calls Meta. */
export function keyModifiers(event: RemotePreviewKeyEventLike): readonly RemotePreviewModifier[] {
  const modifiers: RemotePreviewModifier[] = [];
  if (event.altKey) modifiers.push("Alt");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers;
}

/**
 * Printable keys carry their text so the guest inserts a character instead of
 * only seeing a raw key code. A chord is a command, not text.
 */
export function keyText(event: RemotePreviewKeyEventLike): string | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if (event.key === "Enter") return "\r";
  if (event.key === "Tab") return "\t";
  return [...event.key].length === 1 ? event.key : undefined;
}

const keyMessage = (
  type: "keyDown" | "keyUp",
  event: RemotePreviewKeyEventLike,
): RemotePreviewControlDraft => {
  const text = keyText(event);
  return {
    type,
    key: event.key,
    code: event.code,
    modifiers: keyModifiers(event),
    ...(text === undefined ? {} : { text }),
  };
};

/** Null while an IME is composing: the commit arrives as `compositionend`. */
export function translateKeyEvent(
  type: "keydown" | "keyup",
  event: RemotePreviewKeyEventLike,
): RemotePreviewControlDraft | null {
  if (event.isComposing || ["Unidentified", "Process", "Dead"].includes(event.key)) return null;
  return keyMessage(type === "keydown" ? "keyDown" : "keyUp", event);
}

export interface RemotePreviewBeforeInputLike {
  readonly inputType: string;
  readonly data: string | null;
  readonly isComposing?: boolean;
}

const EDITING_KEYS: Readonly<Record<string, { readonly key: string; readonly code: string }>> = {
  insertLineBreak: { key: "Enter", code: "Enter" },
  insertParagraph: { key: "Enter", code: "Enter" },
  deleteContentBackward: { key: "Backspace", code: "Backspace" },
  deleteWordBackward: { key: "Backspace", code: "Backspace" },
  deleteContentForward: { key: "Delete", code: "Delete" },
  deleteWordForward: { key: "Delete", code: "Delete" },
};

const keyPress = (
  descriptor: { readonly key: string; readonly code: string },
  text?: string,
): readonly RemotePreviewControlDraft[] => [
  { type: "keyDown", ...descriptor, modifiers: [], ...(text === undefined ? {} : { text }) },
  { type: "keyUp", ...descriptor, modifiers: [] },
];

/**
 * Hidden-textarea editing → guest input.
 *
 * Only `beforeinput` is translated. It carries the text before the textarea
 * mutates and fires for deletions that would otherwise be invisible on an
 * empty field; the matching `input` event exists solely to clear the textarea.
 */
export function translateBeforeInput(
  event: RemotePreviewBeforeInputLike,
): readonly RemotePreviewControlDraft[] {
  if (event.isComposing) return [];
  const editingKey = EDITING_KEYS[event.inputType];
  if (editingKey) {
    return keyPress(editingKey, editingKey.key === "Enter" ? "\r" : undefined);
  }
  if (!event.inputType.startsWith("insert")) return [];
  const text = event.data;
  if (text === null || text.length === 0) return [];
  return [{ type: "insertText", text }];
}

/** IME commit. The guest sees one insertion, never the intermediate reading. */
export function translateCompositionEnd(data: string): readonly RemotePreviewControlDraft[] {
  return data.length === 0 ? [] : [{ type: "compositionCommit", text: data }];
}

/** Own native editing events so hardware, software and IME input are sent once. */
export function listenForRemotePreviewBeforeInput(
  textarea: HTMLTextAreaElement,
  options: {
    readonly canSendInput: () => boolean;
    readonly send: (message: RemotePreviewControlDraft) => void;
  },
): () => void {
  let composing = false;
  let handledBeforeInput = false;
  let committedText: string | null = null;
  const reset = () => {
    // Keep a character behind the caret so iOS emits deletion on an otherwise
    // empty input. The remote page owns the actual editing buffer.
    textarea.value = "\u200b";
    textarea.setSelectionRange?.(1, 1);
  };
  const send = (messages: readonly RemotePreviewControlDraft[]) => {
    if (!options.canSendInput()) return;
    for (const message of messages) options.send(message);
  };
  const beforeInput = (event: InputEvent) => {
    if (composing || event.isComposing) return;
    const compositionEcho =
      event.inputType === "insertFromComposition" ||
      (committedText !== null && event.inputType === "insertText" && event.data === committedText);
    const messages = compositionEcho ? [] : translateBeforeInput(event);
    handledBeforeInput = messages.length > 0 || compositionEcho;
    send(messages);
    if (handledBeforeInput && event.cancelable) {
      event.preventDefault();
      reset();
      handledBeforeInput = false;
    }
  };
  const input = (event: InputEvent) => {
    if (composing || event.isComposing) return;
    if (!handledBeforeInput && event.inputType !== "insertFromComposition") {
      send(translateBeforeInput(event));
    }
    handledBeforeInput = false;
    reset();
  };
  const compositionStart = () => {
    composing = true;
  };
  const compositionEnd = (event: CompositionEvent) => {
    composing = false;
    committedText = event.data;
    queueMicrotask(() => {
      committedText = null;
    });
    send(translateCompositionEnd(event.data));
    handledBeforeInput = true;
    reset();
  };
  const key = (event: KeyboardEvent) => {
    // Text and software-keyboard editing belong to beforeinput. Let clipboard
    // shortcuts reach the browser's paste/copy event handlers.
    if (composing || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && ["c", "v", "x"].includes(event.key.toLowerCase()))
      return;
    if (
      !event.metaKey &&
      !event.ctrlKey &&
      ([...event.key].length === 1 || ["Backspace", "Delete", "Enter"].includes(event.key))
    )
      return;
    const message = translateKeyEvent(event.type === "keydown" ? "keydown" : "keyup", event);
    if (!message) return;
    event.preventDefault();
    send([message]);
  };
  reset();
  textarea.addEventListener("beforeinput", beforeInput);
  textarea.addEventListener("input", input);
  textarea.addEventListener("compositionstart", compositionStart);
  textarea.addEventListener("compositionend", compositionEnd);
  textarea.addEventListener("keydown", key);
  textarea.addEventListener("keyup", key);
  return () => {
    textarea.removeEventListener("beforeinput", beforeInput);
    textarea.removeEventListener("input", input);
    textarea.removeEventListener("compositionstart", compositionStart);
    textarea.removeEventListener("compositionend", compositionEnd);
    textarea.removeEventListener("keydown", key);
    textarea.removeEventListener("keyup", key);
  };
}
