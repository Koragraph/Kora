import { createFileRoute, redirect } from "@tanstack/react-router";

import { AppsPage } from "../components/blobs/apps/AppsPage";
import { KoraSurfaceGate } from "../components/kora/KoraSurfaceOnly";

/** Connected apps are Kora's: while Kora is coming soon the page is the coming-soon page. */
function AppsRoute() {
  return (
    <KoraSurfaceGate>
      <AppsPage />
    </KoraSurfaceGate>
  );
}

export const Route = createFileRoute("/apps")({
  beforeLoad: async ({ context }) => {
    // Not authenticated = the local Kora service is not reachable; Diagnostics says why and how to fix it.
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/settings/diagnostics", replace: true });
    }
  },
  component: AppsRoute,
});
