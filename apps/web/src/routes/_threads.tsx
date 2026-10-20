import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { GraphExplorerOverlay } from "../components/graph/GraphExplorerOverlay";

function ChatRouteLayout() {
  return (
    <>
      <Outlet />
      <GraphExplorerOverlay />
    </>
  );
}

export const Route = createFileRoute("/_threads")({
  beforeLoad: async ({ context }) => {
    // Not authenticated = the local Kora service is not reachable; Diagnostics says why and how to fix it.
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/settings/diagnostics", replace: true });
    }
  },
  component: ChatRouteLayout,
});
