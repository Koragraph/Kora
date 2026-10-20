import { RouterProvider } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./wire/atomRegistry";
import { NativeBrowserHost } from "./webview/NativeBrowserHost";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot(props: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={props.router} />
      <NativeBrowserHost />
    </AppAtomRegistryProvider>
  );
}
