// The Kora surface gate, ui-server side. The daemon owns the switch (packages/runtime/src/edition.ts, `UiHost.koraSurface`);
// a host that does not say (an older daemon, a test double) is coming soon, like every build. While coming soon every
// `blobs.*` RPC except the roster stream answers a typed "Kora is coming soon" (handlers.ts), the roster stream sends an
// empty snapshot that tells the client (`koraSurface`), and boot creates no Kora, runs no Chat -> Kora migration and
// starts no blob work (index.ts).
import { BlobError } from "@kora/contracts";

import { host } from "./host.ts";

export type KoraSurface = "coming-soon" | "on";

const KORA_COMING_SOON_MESSAGE = "Kora is coming soon. This build ships Kora Code only.";

export function koraSurface(): KoraSurface {
  try {
    return host().koraSurface?.() === "on" ? "on" : "coming-soon";
  } catch {
    return "coming-soon";
  }
}

export const koraSurfaceOn = (): boolean => koraSurface() === "on";

export function koraComingSoonError(operation: string): BlobError {
  return new BlobError({ operation, message: KORA_COMING_SOON_MESSAGE, code: "coming-soon" });
}
