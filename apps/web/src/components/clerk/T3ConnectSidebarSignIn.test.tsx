import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const authState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: false,
}));

vi.mock("@clerk/react", () => ({
  UserButton: Object.assign(() => null, { UserProfilePage: () => null }),
  useAuth: () => authState,
}));

vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => true,
}));

vi.mock("../ui/sidebar", () => ({
  SidebarMenu: ({ children }: PropsWithChildren) => <div>{children}</div>,
  SidebarMenuButton: (props: ComponentProps<"button">) => <button {...props} />,
  SidebarMenuItem: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

vi.mock("./useT3ConnectAuthPrompt", () => ({
  useT3ConnectAuthPrompt: () => ({ authPrompt: null, openAuthPrompt: vi.fn() }),
}));

import { T3ConnectSidebarSignIn } from "./T3ConnectSidebarSignIn";

describe("T3ConnectSidebarSignIn", () => {
  it("shows an enabled sign-in control when Clerk is ready", () => {
    authState.isLoaded = true;
    authState.isSignedIn = false;

    const markup = renderToStaticMarkup(<T3ConnectSidebarSignIn />);

    expect(markup).toContain("Sign in to T3 Connect");
    expect(markup).not.toContain("disabled");
  });

  it("keeps the sign-in surface visible while Clerk loads", () => {
    authState.isLoaded = false;
    authState.isSignedIn = false;

    const markup = renderToStaticMarkup(<T3ConnectSidebarSignIn />);

    expect(markup).toContain("Sign in to T3 Connect");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-busy="true"');
  });

  it("hides the sign-in control for authenticated users", () => {
    authState.isLoaded = true;
    authState.isSignedIn = true;

    expect(renderToStaticMarkup(<T3ConnectSidebarSignIn />)).toBe("");
  });
});
