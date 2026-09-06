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

describe("iPad editing sequences", () => {
  it("lets software keys reach native editing and sends rapid inputs once", () => {
    const textarea = new EventTarget() as HTMLTextAreaElement;
    const send = vi.fn();
    const remove = listenForRemotePreviewBeforeInput(textarea, { canSendInput: () => true, send });
    for (const data of "hello") {
      const down = Object.assign(
        new Event("keydown", { cancelable: true }),
        key({ key: "Unidentified", code: "" }),
      );
      textarea.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(false);
      textarea.dispatchEvent(
        Object.assign(new Event("beforeinput"), { inputType: "insertText", data }),
      );
      textarea.dispatchEvent(Object.assign(new Event("input"), { inputType: "insertText", data }));
    }
    expect(send.mock.calls.map(([message]) => message.text).join("")).toBe("hello");
    expect(send).toHaveBeenCalledTimes(5);
    expect(textarea.value).toBe("\u200b");
    remove();
  });

  it.each(["insertFromComposition", "insertText"])(
    "preserves composition and deduplicates the final %s event",
    (inputType) => {
      const textarea = new EventTarget() as HTMLTextAreaElement;
      const send = vi.fn();
      const remove = listenForRemotePreviewBeforeInput(textarea, {
        canSendInput: () => true,
        send,
      });
      textarea.dispatchEvent(new Event("compositionstart"));
      textarea.value = "に";
      textarea.dispatchEvent(
        Object.assign(new Event("input"), {
          inputType: "insertCompositionText",
          data: "に",
          isComposing: true,
        }),
      );
      expect(textarea.value).toBe("に");
      textarea.dispatchEvent(Object.assign(new Event("compositionend"), { data: "日本" }));
      for (const type of ["beforeinput", "input"])
        textarea.dispatchEvent(Object.assign(new Event(type), { inputType, data: "日本" }));
      expect(send.mock.calls.map(([message]) => message)).toEqual([
        { type: "compositionCommit", text: "日本" },
      ]);
      remove();
    },
  );
});
