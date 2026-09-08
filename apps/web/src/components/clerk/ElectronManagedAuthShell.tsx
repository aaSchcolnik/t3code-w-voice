import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import { ClerkUI } from "@clerk/ui/entry";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

// Electron 0.0.37 does not expose React's ui prop. Its loader checks this
// constructor before requesting a CDN script, so register the bundled UI here.
// This module stays lazy and desktop-only.
window.__internal_ClerkUICtor = ClerkUI;

/**
 * Electron half of the managed-auth boundary. The Electron provider statically
 * bundles the full clerk-js runtime, so this module must only ever load
 * lazily, and only inside the desktop shell — importing it eagerly would put
 * clerk-js back into every client's startup graph. The UI is bundled here too,
 * so a failed CDN script download cannot leave desktop sign-in disabled.
 */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey} passkeys={passkeys}>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
