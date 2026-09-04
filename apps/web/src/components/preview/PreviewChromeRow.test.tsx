import { type RemotePreviewSessionId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewChromeRow } from "./PreviewChromeRow";

const defaultProps = {
  url: "https://example.com",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  refreshDisabled: false,
  onBack: vi.fn(),
  onForward: vi.fn(),
  onRefresh: vi.fn(),
  onSubmit: vi.fn(),
};

describe("PreviewChromeRow", () => {
  it("does not render remote host indicator when absent or zero viewers", () => {
    const withoutIndicator = renderToStaticMarkup(<PreviewChromeRow {...defaultProps} />);
    expect(withoutIndicator).not.toContain('data-testid="remote-host-indicator"');

    const zeroViewers = renderToStaticMarkup(
      <PreviewChromeRow {...defaultProps} remoteHostIndicator={{ viewerCount: 0 }} />,
    );
    expect(zeroViewers).not.toContain('data-testid="remote-host-indicator"');
  });

  it("renders remote host indicator with 1 viewer", () => {
    const markup = renderToStaticMarkup(
      <PreviewChromeRow {...defaultProps} remoteHostIndicator={{ viewerCount: 1 }} />,
    );
    expect(markup).toContain('data-testid="remote-host-indicator"');
    expect(markup).toContain("Remote: 1 viewer");
  });

  it("renders remote host indicator with multiple viewers and controller label", () => {
    const markup = renderToStaticMarkup(
      <PreviewChromeRow
        {...defaultProps}
        remoteHostIndicator={{
          viewerCount: 2,
          controller: {
            sessionId: "sess-1" as RemotePreviewSessionId,
            label: "iPad",
          },
        }}
      />,
    );
    expect(markup).toContain('data-testid="remote-host-indicator"');
    expect(markup).toContain("Remote: 2 viewers, controlled by iPad");
  });

  it("renders remote viewer controls when remoteViewer is provided", () => {
    const markup = renderToStaticMarkup(
      <PreviewChromeRow
        {...defaultProps}
        remoteViewer={{
          controlling: false,
          keyboardOpen: false,
          fullscreen: false,
          controlDisabled: false,
          onRequestControl: vi.fn(),
          onReleaseControl: vi.fn(),
          onShowKeyboard: vi.fn(),
          onToggleFullscreen: vi.fn(),
        }}
      />,
    );
    expect(markup).toContain("Take control");
    expect(markup).toContain("Show keyboard");
    expect(markup).toContain("Full screen");
  });
});
