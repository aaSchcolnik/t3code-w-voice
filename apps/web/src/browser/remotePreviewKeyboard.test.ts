import { describe, expect, it, vi } from "vite-plus/test";

import {
  keyModifiers,
  listenForRemotePreviewBeforeInput,
  keyText,
  translateBeforeInput,
  translateCompositionEnd,
  translateKeyEvent,
} from "./remotePreviewKeyboard";

const key = (
  overrides: Partial<Parameters<typeof translateKeyEvent>[1]> & { key: string; code: string },
) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("hardware keys", () => {
  it("carries text for printable keys", () => {
    expect(translateKeyEvent("keydown", key({ key: "a", code: "KeyA" }))).toEqual({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: [],
      text: "a",
    });
  });

  it("sends a chord without text", () => {
    expect(translateKeyEvent("keydown", key({ key: "c", code: "KeyC", metaKey: true }))).toEqual({
      type: "keyDown",
      key: "c",
      code: "KeyC",
      modifiers: ["Meta"],
    });
  });

  it("maps every modifier the guest understands", () => {
    expect(
      keyModifiers(
        key({ key: "a", code: "KeyA", altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }),
      ),
    ).toEqual(["Alt", "Control", "Meta", "Shift"]);
  });

  it("gives Enter and Tab their control characters", () => {
    expect(keyText(key({ key: "Enter", code: "Enter" }))).toBe("\r");
    expect(keyText(key({ key: "Tab", code: "Tab" }))).toBe("\t");
    expect(keyText(key({ key: "ArrowLeft", code: "ArrowLeft" }))).toBeUndefined();
  });

  it("stays quiet while an IME is composing", () => {
    expect(
      translateKeyEvent("keydown", { ...key({ key: "Process", code: "KeyA" }), isComposing: true }),
    ).toBeNull();
  });
});

describe("hidden textarea", () => {
  it("forwards typed text as insertText", () => {
    expect(translateBeforeInput({ inputType: "insertText", data: "hi" })).toEqual([
      { type: "insertText", text: "hi" },
    ]);
  });

  it("forwards a paste as insertText", () => {
    expect(translateBeforeInput({ inputType: "insertFromPaste", data: "pasted" })).toEqual([
      { type: "insertText", text: "pasted" },
    ]);
  });

  it("turns a backspace into a key press the guest can act on", () => {
    expect(translateBeforeInput({ inputType: "deleteContentBackward", data: null })).toEqual([
      { type: "keyDown", key: "Backspace", code: "Backspace", modifiers: [] },
      { type: "keyUp", key: "Backspace", code: "Backspace", modifiers: [] },
    ]);
  });

  it("turns a newline into Enter with its text", () => {
    expect(translateBeforeInput({ inputType: "insertLineBreak", data: null })).toEqual([
      { type: "keyDown", key: "Enter", code: "Enter", modifiers: [], text: "\r" },
      { type: "keyUp", key: "Enter", code: "Enter", modifiers: [] },
    ]);
  });

  it("waits for the commit while composing", () => {
    expect(
      translateBeforeInput({ inputType: "insertCompositionText", data: "に", isComposing: true }),
    ).toEqual([]);
    expect(translateCompositionEnd("日本")).toEqual([{ type: "compositionCommit", text: "日本" }]);
    expect(translateCompositionEnd("")).toEqual([]);
  });

  it("ignores edits it has no message for", () => {
    expect(translateBeforeInput({ inputType: "historyUndo", data: null })).toEqual([]);
    expect(translateBeforeInput({ inputType: "insertText", data: null })).toEqual([]);
  });
});

describe("native textarea editing events", () => {
  it("forwards Safari native text, paste and backspace once without reading React's textInput event", () => {
    const textarea = new EventTarget() as HTMLTextAreaElement;
    const send = vi.fn();
    const remove = listenForRemotePreviewBeforeInput(textarea, { canSendInput: () => true, send });
    for (const [inputType, data] of [
      ["insertText", "hola"],
      ["insertFromPaste", " mundo"],
      ["deleteContentBackward", null],
    ] as const) {
      textarea.dispatchEvent(Object.assign(new Event("beforeinput"), { inputType, data }));
      textarea.dispatchEvent(Object.assign(new Event("textInput"), { data }));
    }
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "insertText", text: "hola" },
      { type: "insertText", text: " mundo" },
      { type: "keyDown", key: "Backspace", code: "Backspace", modifiers: [] },
      { type: "keyUp", key: "Backspace", code: "Backspace", modifiers: [] },
    ]);
    remove();
    textarea.dispatchEvent(
      Object.assign(new Event("beforeinput"), { inputType: "insertText", data: "closed" }),
    );
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("waits for composition commit and rejects edits after control is released", () => {
    const textarea = new EventTarget() as HTMLTextAreaElement;
    const send = vi.fn();
    let controller = true;
    const remove = listenForRemotePreviewBeforeInput(textarea, {
      canSendInput: () => controller,
      send,
    });
    textarea.dispatchEvent(
      Object.assign(new Event("beforeinput"), {
        inputType: "insertCompositionText",
        data: "に",
        isComposing: true,
      }),
    );
    controller = false;
    textarea.dispatchEvent(
      Object.assign(new Event("beforeinput"), { inputType: "insertText", data: "hidden" }),
    );
    expect(send).not.toHaveBeenCalled();
    remove();
  });
});
