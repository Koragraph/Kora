import type { ShellAppBranding } from "@kora/contracts";
import { formatAppDisplayName } from "./appTitle";

function readInjectedShellAppBranding(): ShellAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.shellBridge?.getAppBranding?.() ?? null;
}

const injectedShellAppBranding = readInjectedShellAppBranding();
export const APP_BASE_NAME = injectedShellAppBranding?.baseName ?? "Kora";
export const APP_STAGE_LABEL =
  injectedShellAppBranding?.stageLabel ?? (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedShellAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";

/**
 * Which Kora this build is. The free edition ships today; Kora Pro (Koragent workers and the rest of the paid layer)
 * comes later. Plan-usage visibility (the composer's usage sign, the context ring's plan rows, Settings › Usage) is in
 * every edition. Pro-only UI stays in the tree and is hidden behind IS_PRO_EDITION. The daemon enforces the same split
 * (packages/runtime/src/edition.ts) — keep the two in step.
 */
const KORA_EDITION: "free" | "pro" = "free";
export const IS_PRO_EDITION = (KORA_EDITION as "free" | "pro") === "pro";

/**
 * The Kora surface (blobs: assistants with memory, routines, a browser; Kora the Chief). The first launch ships Kora
 * Code only, so every build says "coming-soon": the Kora tab shows the coming-soon screen and no blob UI mounts. The
 * blob code stays in the tree. The daemon has the twin switch (packages/runtime/src/edition.ts KORA_SURFACE — keep the
 * two in step) and a developer override (KORA_SURFACE=on or <KORA_HOME>/kora-surface); the client follows the daemon's
 * answer on the blobs snapshot (koraSurface.ts), so a dev daemon with the override shows the real Kora.
 */
export const KORA_SURFACE: "coming-soon" | "on" = "coming-soon";
