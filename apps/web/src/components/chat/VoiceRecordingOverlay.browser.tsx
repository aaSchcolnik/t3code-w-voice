import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRoot } from "react-dom/client";

import { VoiceRecordingOverlay } from "./VoiceRecordingOverlay";

async function mountOverlay(props?: {
  waveform?: ReadonlyArray<number>;
  stopShortcutLabel?: string;
  onStop?: () => void;
  onCancel?: () => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    <VoiceRecordingOverlay
      waveform={props?.waveform ?? []}
      stopShortcutLabel={props?.stopShortcutLabel ?? "alt+shift+r"}
      onStop={props?.onStop ?? vi.fn()}
      onCancel={props?.onCancel ?? vi.fn()}
    />,
  );
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const cleanup = async () => {
    root.unmount();
    host.remove();
  };

  return { host, [Symbol.asyncDispose]: cleanup, cleanup };
}

describe("VoiceRecordingOverlay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the voice-to-text label with stop and cancel actions", async () => {
    await using mounted = await mountOverlay();

    const text = mounted.host.textContent ?? "";
    expect(text).toContain("Voice to text");
    expect(text).toContain("Stop");
    expect(text).toContain("Cancel");
  });

  it("renders the stop shortcut as keycaps", async () => {
    await using mounted = await mountOverlay({ stopShortcutLabel: "alt+shift+r" });

    const shortcut = mounted.host.querySelector('[aria-label="alt+shift+r"]');
    expect(shortcut).not.toBeNull();
    const shortcutText = shortcut?.textContent ?? "";
    expect(shortcutText).toContain("alt");
    expect(shortcutText).toContain("shift");
    expect(shortcutText).toContain("r");
  });

  it("invokes onStop when the stop button is clicked", async () => {
    const onStop = vi.fn();
    await using _ = await mountOverlay({ onStop });

    await page.getByRole("button", { name: /stop/i }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("invokes onCancel when the cancel button is clicked", async () => {
    const onCancel = vi.fn();
    await using _ = await mountOverlay({ onCancel });

    await page.getByRole("button", { name: /cancel/i }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders a waveform of bars", async () => {
    await using mounted = await mountOverlay({ waveform: [0.1, 0.5, 0.9] });

    // The overlay renders a fixed-width waveform (96 bars) regardless of sample count.
    const bars = mounted.host.querySelectorAll("span[style*='height']");
    expect(bars.length).toBe(96);
  });
});
