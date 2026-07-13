import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ProviderDriverKind } from "@t3tools/contracts";

vi.mock("./providerIconUtils", () => ({
  PROVIDER_ICON_BY_PROVIDER: {},
}));

import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

describe("ProviderInstanceIcon", () => {
  it("shows provider initials inside a configured accent badge", () => {
    const html = renderToStaticMarkup(
      <ProviderInstanceIcon
        driverKind={"codex" as ProviderDriverKind}
        displayName="Codex"
        accentColor="#0066ff"
        showBadge
      />,
    );

    expect(html).toContain("--provider-accent:#0066ff");
    expect(html).toContain(">CO</span>");
  });
});
