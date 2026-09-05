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
  if (event.isComposing) return null;
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

/** React's onBeforeInput uses textInput/keypress events, which lack inputType. */
export function listenForRemotePreviewBeforeInput(
  textarea: HTMLTextAreaElement,
  options: {
    readonly canSendInput: () => boolean;
    readonly send: (message: RemotePreviewControlDraft) => void;
  },
): () => void {
  const beforeInput = (event: InputEvent) => {
    if (!options.canSendInput()) return;
    for (const message of translateBeforeInput(event)) options.send(message);
  };
  textarea.addEventListener("beforeinput", beforeInput);
  return () => textarea.removeEventListener("beforeinput", beforeInput);
}
