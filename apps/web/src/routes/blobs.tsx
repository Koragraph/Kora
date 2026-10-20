import { Outlet, createFileRoute, redirect, useChildMatches } from "@tanstack/react-router";

import { BlobLanding } from "../components/blobs/shell/BlobLanding";
import { KoraSurfaceGate } from "../components/kora/KoraSurfaceOnly";

// `/blobs` is the parent of `/blobs/$blobId` (file-route nesting): render the child when there is one, else the
// roster landing. Kora is coming soon (koraSurface.ts): /blobs and every /blobs/<id> below it show the coming-soon page.
function BlobsIndexRoute() {
  const hasChild = useChildMatches({ select: (matches) => matches.length > 0 });
  return <KoraSurfaceGate>{hasChild ? <Outlet /> : <BlobLanding blobId={null} />}</KoraSurfaceGate>;
}

export const Route = createFileRoute("/blobs")({
  beforeLoad: async ({ context }) => {
    // Not authenticated = the local Kora service is not reachable; Diagnostics says why and how to fix it.
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/settings/diagnostics", replace: true });
    }
  },
  component: BlobsIndexRoute,
});
