import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { RemoteBrowserHost } from "./browser/RemoteBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The browser hosts intentionally sit outside the
 * router so their webviews and video surfaces survive route transitions, but
 * they must share the same atom registry as routed UI. Exactly one of them
 * renders: Electron hosts the guest itself, everywhere else watches it.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <RemoteBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
