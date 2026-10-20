// Renders its children only while the Kora surface is on (koraSurface.ts). Root-level blob UI (the hire fly-in, the blob
// browser's mini-window) sits inside it so nothing of Kora mounts while it is coming soon.
import type { ReactNode } from "react";

import { useKoraSurfaceOn } from "../../koraSurface";
import { KoraComingSoon } from "./KoraComingSoon";

export function KoraSurfaceOnly(props: { readonly children: ReactNode }) {
  return useKoraSurfaceOn() ? <>{props.children}</> : null;
}

/** A Kora page (/blobs, /blobs/<id>, /apps): the page itself while Kora is on, else the coming-soon page. */
export function KoraSurfaceGate(props: { readonly children: ReactNode }) {
  return useKoraSurfaceOn() ? <>{props.children}</> : <KoraComingSoon />;
}
