// Mounts Kora's first-run canvas over her empty thread (ThreadView) and over an empty /blobs (BlobLanding). It shows
// until the user dismisses it ("Maybe later"), asks Kora to build a blob, or the thread has messages. The galleryDismissed
// flag lives on the daemon, so it stays gone across restarts.
import { CHIEF_BLOB_ID } from "@kora/contracts";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useBlobsApi, useBlobsState } from "../shell/blobsApi";
import { KoraFirstRunHost } from "./KoraFirstRun";

export const BUILD_ME_A_BLOB_TEXT = "Build me a blob that ";

/**
 * Whether Kora's welcome shows, and how to put it away. `active` = the host's own conditions (this is Kora's thread, it is
 * empty, nothing is loading). The host reads `visible` too: while the welcome shows, the composer stays docked at the bottom
 * (never the centred "new chat" hero beneath it) - the welcome is a message, and you can answer it by typing.
 */
export function useKoraWelcome(active: boolean): {
  readonly visible: boolean;
  readonly dismiss: () => void;
} {
  const { snapshot } = useBlobsState();
  const api = useBlobsApi();
  const [hidden, setHidden] = useState(false);
  const dismissed = snapshot?.flags.galleryDismissed ?? true; // unknown yet: stay out of the way
  return {
    visible: active && !hidden && !dismissed,
    dismiss: () => {
      setHidden(true);
      void api.setFlag("galleryDismissed", true);
    },
  };
}

/** Kora's welcome over her empty transcript. It fills the transcript area only: the composer is never underneath it. */
export function KoraFirstRunGate(props: {
  readonly visible: boolean;
  readonly dismiss: () => void;
  /** Space the docked composer takes at the bottom (the welcome scrolls clear of it). */
  readonly bottomInset?: number;
  /** "Build me a blob": put the starter text in the composer and focus it. */
  readonly onBuild: () => void;
}) {
  const router = useRouter();
  if (!props.visible) return null;
  return (
    <div
      className="absolute inset-0 z-10 overflow-y-auto bg-background"
      style={props.bottomInset ? { paddingBottom: props.bottomInset } : undefined}
      data-kora-first-run-gate
    >
      <KoraFirstRunHost
        onBuild={() => {
          props.dismiss();
          props.onBuild();
        }}
        onFirstTask={(blob) => {
          props.dismiss();
          void router.navigate({ to: "/blobs/$blobId", params: { blobId: blob.id } });
        }}
        onDismiss={props.dismiss}
      />
    </div>
  );
}

export const isKoraThread = (blobId: string | null): boolean => blobId === CHIEF_BLOB_ID;
