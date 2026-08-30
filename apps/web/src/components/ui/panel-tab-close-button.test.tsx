import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PanelTabCloseButton } from "./panel-tab-close-button";

describe("PanelTabCloseButton", () => {
  it("shows the close action instead of the tab icon on coarse pointers", () => {
    const markup = renderToStaticMarkup(
      <PanelTabCloseButton label="Close preview" onClick={vi.fn()}>
        <span>Preview</span>
      </PanelTabCloseButton>,
    );

    expect(markup).toContain("any-pointer-coarse:hidden");
    expect(markup).toContain("any-pointer-coarse:block");
  });
});
