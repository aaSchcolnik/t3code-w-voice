import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { FirstRunVoiceConsentDialog } from "./FirstRunVoiceConsentDialog";

describe("FirstRunVoiceConsentDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("explains the download and confirms explicit local consent", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onAccept = vi.fn();
    await act(async () => {
      root.render(
        <FirstRunVoiceConsentDialog
          request={{
            model: {
              id: "parakeet",
              displayName: "Parakeet",
              description: "Speech model",
              featured: true,
              capabilities: {
                languages: ["en"],
                supportsLanguageDetect: false,
                supportsInitialPrompt: false,
                supportsStreaming: false,
              },
              quantizations: [],
            },
            quantizationId: "Q8_0",
            sizeBytes: 740_000_000,
            canUseServerWhileDownloading: true,
          }}
          onAccept={onAccept}
          onDecline={vi.fn()}
        />,
      );
    });

    expect(document.body.textContent).toContain("740 MB");
    expect(document.body.textContent).toContain("configured server");
    await page.getByRole("button", { name: /download and continue/i }).click();
    expect(onAccept).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    host.remove();
  });
});
