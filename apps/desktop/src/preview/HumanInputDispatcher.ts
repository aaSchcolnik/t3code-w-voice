import type {
  RemotePreviewInputMessage,
  RemotePreviewModifier,
  RemotePreviewPointerButton,
  RemotePreviewSourceMetadata,
} from "@t3tools/contracts";

import { makePreviewAutomationKeySequence } from "./PreviewKeyboard.ts";

export type HumanInputSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface HumanInputDispatcherOptions {
  readonly send: HumanInputSend;
  readonly onTouchStart?: (x: number, y: number) => Promise<void>;
  readonly onFirstInput: () => Promise<void>;
  readonly focus: () => Promise<void>;
  readonly insertTextBeforeActivation: (text: string) => Promise<void>;
  readonly isMac?: boolean;
}

interface HeldPointer {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly button: RemotePreviewPointerButton;
  readonly modifiers: ReadonlyArray<RemotePreviewModifier>;
}

interface HeldKey {
  readonly key: string;
  readonly code: string;
  readonly modifiers: ReadonlyArray<RemotePreviewModifier>;
}

const modifierMask = (modifiers: ReadonlyArray<RemotePreviewModifier>): number =>
  modifiers.reduce((mask, modifier) => {
    switch (modifier) {
      case "Alt":
        return mask | 1;
      case "Control":
        return mask | 2;
      case "Meta":
        return mask | 4;
      case "Shift":
        return mask | 8;
    }
  }, 0);

const buttonMask = (button: RemotePreviewPointerButton): number => {
  switch (button) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
    case "back":
      return 8;
    case "forward":
      return 16;
    case "none":
      return 0;
  }
};

const pointerButton = (button: RemotePreviewPointerButton): string =>
  button === "none" ? "none" : button;

const isPointMessage = (
  message: RemotePreviewInputMessage,
): message is Extract<RemotePreviewInputMessage, { readonly x: number; readonly y: number }> =>
  "x" in message && "y" in message;

const isActualInput = (message: RemotePreviewInputMessage): boolean =>
  message.type !== "releaseAll" && message.type !== "viewportAck";

const touchPoint = (pointer: HeldPointer) => ({
  x: pointer.x,
  y: pointer.y,
  id: pointer.pointerId,
  radiusX: 1,
  radiusY: 1,
  force: 1,
});

/**
 * Serializes human input independently from the agent automation semaphore.
 * The first real input in a controller lifetime interrupts agent work before
 * the corresponding CDP command is sent.
 */
export class HumanInputDispatcher {
  private readonly options: HumanInputDispatcherOptions;
  private activated = false;
  private inputStarted = false;
  private touchEmulationEnabled = false;
  private lastMetadataGeneration: RemotePreviewSourceMetadata["generation"] | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly heldMousePointers = new Map<number, HeldPointer>();
  private readonly heldTouchPointers = new Map<number, HeldPointer>();
  private readonly heldKeys = new Map<string, HeldKey>();
  private readonly lastMotionSequence = new Map<number, number>();

  constructor(options: HumanInputDispatcherOptions) {
    this.options = options;
  }

  dispatch(
    message: RemotePreviewInputMessage,
    metadata: RemotePreviewSourceMetadata,
  ): Promise<boolean> {
    let accepted = false;
    const operation = this.tail.then(async () => {
      accepted = await this.dispatchNow(message, metadata);
    });
    this.tail = operation.catch(() => undefined);
    return operation.then(() => accepted);
  }

  private async dispatchNow(
    message: RemotePreviewInputMessage,
    metadata: RemotePreviewSourceMetadata,
  ): Promise<boolean> {
    if (message.generation !== metadata.generation) return false;
    if (this.lastMetadataGeneration !== metadata.generation) {
      this.lastMetadataGeneration = metadata.generation;
      this.lastMotionSequence.clear();
    }
    if (
      isPointMessage(message) &&
      (message.x < 0 ||
        message.y < 0 ||
        message.x > metadata.cssWidth ||
        message.y > metadata.cssHeight)
    ) {
      return false;
    }
    if (
      (message.type === "pointerMove" || message.type === "touchMove") &&
      message.pointerType === "touch" &&
      !this.heldTouchPointers.has(message.pointerId)
    ) {
      return false;
    }
    if ("sequence" in message) {
      const previous = this.lastMotionSequence.get(message.pointerId);
      if (previous !== undefined && message.sequence <= previous) return false;
      this.lastMotionSequence.set(message.pointerId, message.sequence);
    }
    if (isActualInput(message) && !this.inputStarted) {
      await this.options.onFirstInput();
      this.inputStarted = true;
    }

    switch (message.type) {
      case "pointerDown":
        await this.pointerDown(message);
        return true;
      case "pointerUp":
        await this.pointerUp(message);
        return true;
      case "tap":
        await this.tap(message);
        return true;
      case "touchStart":
        await this.touchStart(message);
        return true;
      case "touchEnd":
        await this.touchEnd(message.pointerId, message.modifiers);
        return true;
      case "pointerMove":
      case "touchMove":
        await this.pointerMove(message);
        return true;
      case "wheel":
        await this.options.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: message.x,
          y: message.y,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          modifiers: modifierMask(message.modifiers),
        });
        return true;
      case "keyDown":
        await this.keyDown(message);
        return true;
      case "keyUp":
        await this.keyUp(message);
        return true;
      case "insertText":
      case "compositionCommit":
        if (this.activated) {
          await this.options.send("Input.insertText", { text: message.text });
        } else {
          await this.options.insertTextBeforeActivation(message.text);
        }
        return true;
      case "focusRequest":
        await this.options.focus();
        return true;
      case "releaseAll":
        await this.releaseAll();
        return true;
      case "viewportAck":
        return true;
    }
  }

  private async pointerDown(
    message: Extract<RemotePreviewInputMessage, { readonly type: "pointerDown" }>,
  ): Promise<void> {
    if (message.pointerType === "touch") {
      await this.touchStart(message);
      return;
    }
    const pointer: HeldPointer = {
      ...message,
      button: message.button === "none" ? "left" : message.button,
    };
    this.heldMousePointers.set(message.pointerId, pointer);
    await this.options.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: message.x,
      y: message.y,
      button: pointerButton(pointer.button),
      buttons: this.heldMouseButtons(),
      clickCount: 1,
      modifiers: modifierMask(message.modifiers),
      pointerType: message.pointerType,
    });
    this.activated = true;
  }

  private async pointerUp(
    message: Extract<RemotePreviewInputMessage, { readonly type: "pointerUp" }>,
  ): Promise<void> {
    if (message.pointerType === "touch") {
      await this.touchEnd(message.pointerId, message.modifiers);
      return;
    }
    const held = this.heldMousePointers.get(message.pointerId);
    this.heldMousePointers.delete(message.pointerId);
    const button = message.button === "none" ? (held?.button ?? "left") : message.button;
    await this.options.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: message.x,
      y: message.y,
      button: pointerButton(button),
      buttons: this.heldMouseButtons(),
      clickCount: 1,
      modifiers: modifierMask(message.modifiers),
      pointerType: message.pointerType,
    });
    this.activated = true;
  }

  private async tap(
    message: Extract<RemotePreviewInputMessage, { readonly type: "tap" }>,
  ): Promise<void> {
    if (message.pointerType === "touch") {
      await this.touchStart(message);
      await this.touchEnd(message.pointerId, message.modifiers);
      return;
    }
    await this.pointerDown({ ...message, type: "pointerDown" });
    await this.pointerUp({ ...message, type: "pointerUp" });
  }

  private async touchStart(
    message: Extract<
      RemotePreviewInputMessage,
      { readonly type: "touchStart" | "pointerDown" | "tap" }
    >,
  ): Promise<void> {
    if (!this.touchEmulationEnabled) {
      await this.options.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      this.touchEmulationEnabled = true;
    }
    const pointer: HeldPointer = { ...message, button: "none" };
    this.heldTouchPointers.set(message.pointerId, pointer);
    await this.options.onTouchStart?.(message.x, message.y);
    await this.options.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: Array.from(this.heldTouchPointers.values(), touchPoint),
      modifiers: modifierMask(message.modifiers),
    });
    this.activated = true;
  }

  private async touchEnd(
    pointerId: number,
    modifiers: ReadonlyArray<RemotePreviewModifier>,
  ): Promise<void> {
    this.heldTouchPointers.delete(pointerId);
    await this.options.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: Array.from(this.heldTouchPointers.values(), touchPoint),
      modifiers: modifierMask(modifiers),
    });
    this.activated = true;
  }

  private async pointerMove(
    message: Extract<RemotePreviewInputMessage, { readonly type: "pointerMove" | "touchMove" }>,
  ): Promise<void> {
    if (message.pointerType === "touch") {
      if (!this.heldTouchPointers.has(message.pointerId)) return;
      const previous = this.heldTouchPointers.get(message.pointerId)!;
      this.heldTouchPointers.set(message.pointerId, {
        ...previous,
        x: message.x,
        y: message.y,
        modifiers: message.modifiers,
      });
      await this.options.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: Array.from(this.heldTouchPointers.values(), touchPoint),
        modifiers: modifierMask(message.modifiers),
      });
      return;
    }
    const held = this.heldMousePointers.get(message.pointerId);
    if (held) {
      this.heldMousePointers.set(message.pointerId, {
        ...held,
        x: message.x,
        y: message.y,
        modifiers: message.modifiers,
      });
    }
    await this.options.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: message.x,
      y: message.y,
      button: pointerButton("button" in message ? message.button : (held?.button ?? "none")),
      buttons: this.heldMouseButtons(),
      modifiers: modifierMask(message.modifiers),
      pointerType: message.pointerType,
    });
  }

  private normalizeKey(message: Pick<HeldKey, "key" | "code" | "modifiers">): HeldKey {
    // iPad Command arrives as `metaKey` on the viewer; older or hardware
    // keyboards can still label the key "Command" / "OS".
    if (message.key !== "Command" && message.key !== "OS") {
      return { key: message.key, code: message.code, modifiers: message.modifiers };
    }
    return {
      key: "Meta",
      code: message.code === "MetaRight" || message.code === "OSRight" ? "MetaRight" : "MetaLeft",
      modifiers: message.modifiers,
    };
  }

  private keySequence(message: Pick<HeldKey, "key" | "code" | "modifiers">, text?: string) {
    const normalized = this.normalizeKey(message);
    const sequence = makePreviewAutomationKeySequence(
      { key: normalized.key, modifiers: [...normalized.modifiers] },
      { isMac: this.options.isMac === true },
    );
    return {
      keyDown: {
        ...sequence.keyDown,
        code: normalized.code || sequence.keyDown.code,
        nativeVirtualKeyCode: sequence.keyDown.windowsVirtualKeyCode,
        ...(text === undefined ? {} : { text, unmodifiedText: text }),
      },
      keyUp: {
        ...sequence.keyUp,
        code: normalized.code || sequence.keyUp.code,
        nativeVirtualKeyCode: sequence.keyUp.windowsVirtualKeyCode,
      },
    };
  }

  private async keyDown(
    message: Extract<RemotePreviewInputMessage, { readonly type: "keyDown" }>,
  ): Promise<void> {
    const normalized = this.normalizeKey(message);
    this.heldKeys.set(normalized.code, normalized);
    await this.options.send(
      "Input.dispatchKeyEvent",
      this.keySequence(normalized, message.text).keyDown,
    );
  }

  private async keyUp(
    message: Extract<RemotePreviewInputMessage, { readonly type: "keyUp" }>,
  ): Promise<void> {
    const normalized = this.normalizeKey(message);
    this.heldKeys.delete(normalized.code);
    await this.options.send(
      "Input.dispatchKeyEvent",
      this.keySequence(normalized, message.text).keyUp,
    );
  }

  private heldMouseButtons(): number {
    let buttons = 0;
    for (const pointer of this.heldMousePointers.values()) buttons |= buttonMask(pointer.button);
    return buttons;
  }

  private async releaseAll(): Promise<void> {
    for (const pointer of this.heldMousePointers.values()) {
      await this.options.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: pointer.x,
        y: pointer.y,
        button: pointerButton(pointer.button),
        buttons: 0,
        clickCount: 1,
        modifiers: modifierMask(pointer.modifiers),
      });
    }
    if (this.heldTouchPointers.size > 0) {
      await this.options.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    }
    if (this.touchEmulationEnabled) {
      await this.options.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    for (const key of this.heldKeys.values()) {
      await this.options.send("Input.dispatchKeyEvent", this.keySequence(key).keyUp);
    }
    this.heldMousePointers.clear();
    this.heldTouchPointers.clear();
    this.heldKeys.clear();
    this.lastMotionSequence.clear();
    this.touchEmulationEnabled = false;
    this.activated = false;
    this.inputStarted = false;
  }
}
