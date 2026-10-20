import { createFileRoute, redirect } from "@tanstack/react-router";

import { GroupLanding } from "../components/blobs/groups/GroupLanding";
import { BlobLanding } from "../components/blobs/shell/BlobLanding";
import { KoraSurfaceGate } from "../components/kora/KoraSurfaceOnly";

function BlobRoute() {
  const { blobId } = Route.useParams();
  // Keyed so switching blobs from the sidebar re-runs the landing for the new one. A group id lands on the group's chat.
  return (
    <KoraSurfaceGate>
      {blobId.startsWith("group_") ? (
        <GroupLanding key={blobId} groupId={blobId} />
      ) : (
        <BlobLanding key={blobId} blobId={blobId} />
      )}
    </KoraSurfaceGate>
  );
}

export const Route = createFileRoute("/blobs/$blobId")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/settings/diagnostics", replace: true });
    }
  },
  component: BlobRoute,
});
