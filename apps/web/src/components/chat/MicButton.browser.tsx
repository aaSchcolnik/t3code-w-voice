import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRoot } from "react-dom/client";

import { MicButton } from "./MicButton";
import type { VoiceDictationState } from "./useVoiceDictationSession";

async function mountMicButton(props?: {
  state?: VoiceDictationState;
  voiceEnabled?: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    <MicButton
      state={props?.state ?? "idle"}
      voiceEnabled={props?.voiceEnabled ?? true}
      disabled={props?.disabled ?? false}
      onToggle={props?.onToggle ?? vi.fn()}
    />,
  );
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const cleanup = async () => {
    root.unmount();
    host.remove();
  };

  return { host, [Symbol.asyncDispose]: cleanup, cleanup };
}

describe("MicButton", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders nothing when voice is disabled", async () => {
    await using mounted = await mountMicButton({ voiceEnabled: false });
    expect(mounted.host.querySelector("button")).toBeNull();
  });

  it("renders an idle dictate button when voice is enabled", async () => {
    await using mounted = await mountMicButton({ state: "idle" });

    const button = mounted.host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Dictate");
    expect(button?.getAttribute("aria-pressed")).toBe("false");
  });

  it("reflects the recording state with a stop affordance", async () => {
    await using mounted = await mountMicButton({ state: "recording" });

    const button = mounted.host.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Stop dictation");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
  });

  it("labels the transitional starting and stopping states", async () => {
    await using starting = await mountMicButton({ state: "starting" });
    expect(starting.host.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Starting dictation...",
    );
    await starting.cleanup();

    await using stopping = await mountMicButton({ state: "stopping" });
    expect(stopping.host.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Stopping dictation...",
    );
  });

  it("invokes onToggle when clicked while idle", async () => {
    const onToggle = vi.fn();
    await using _ = await mountMicButton({ state: "idle", onToggle });

    await page.getByLabelText("Dictate").click();

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("disables the button when disabled and not active", async () => {
    const onToggle = vi.fn();
    await using mounted = await mountMicButton({ state: "idle", disabled: true, onToggle });

    expect(mounted.host.querySelector("button")?.disabled).toBe(true);
  });

  it("stays interactive while active even when disabled is set", async () => {
    const onToggle = vi.fn();
    await using mounted = await mountMicButton({ state: "recording", disabled: true, onToggle });

    expect(mounted.host.querySelector("button")?.disabled).toBe(false);

    await page.getByLabelText("Stop dictation").click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
