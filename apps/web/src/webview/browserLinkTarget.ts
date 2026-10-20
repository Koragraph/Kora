/**
 * Where a link clicked inside a thread should open.
 *
 * Settings → Integrations → Browser lets the user choose between the OS
 * default browser and a tab in the in-app browser. This module turns that
 * preference plus the click itself into one answer, so chat markdown and the
 * terminal drawer make the same decision and offer the same escape hatch.
 *
 * @module browserLinkTarget
 */
import type { LinkOpenTarget } from "@kora/contracts";

import { isWebSupportedInRuntime } from "~/stores/webStateStore";
import { ensureClientPrefsHydrated, getClientPrefs } from "~/hooks/usePrefs";

export interface ResolveLinkTargetInput {
  /** Cmd/Ctrl-click always goes to the system browser, whatever the default. */
  readonly event: { readonly metaKey: boolean; readonly ctrlKey: boolean };
  readonly preference: LinkOpenTarget;
  /** Whether this client has an in-app browser and a thread to open it beside. */
  readonly canOpenInApp: boolean;
  readonly url: string;
}

/**
 * The target a click resolves to. "app" only comes back when the preference
 * asks for it, the runtime can honour it, the URL is one the in-app browser
 * can load, and the click carried no modifier — the modifier is the one-gesture
 * way out when the default is in-app, mirroring how change-request links
 * already treat it.
 */
export function resolveLinkTarget(args: ResolveLinkTargetInput): LinkOpenTarget {
  if (args.event.metaKey || args.event.ctrlKey) return "system";
  if (args.preference !== "app") return "system";
  if (!args.canOpenInApp) return "system";
  if (!isWebUrl(args.url)) return "system";
  return "app";
}

/**
 * Only http(s) can load in the in-app browser. Anything else — mailto:,
 * vscode://, a bare fragment — belongs to the shell whatever the preference.
 */
export function isWebUrl(address: string): boolean {
  try {
    const { protocol } = new URL(address);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The configured default, once client settings have actually loaded. Before
 * hydration the snapshot is the schema default ("system"), so a link clicked
 * in the first moments after launch would ignore a persisted "app" — opening
 * is asynchronous anyway, so waiting costs nothing the user can see.
 * Read failures reject rather than choosing a browser without the saved preference.
 */
export async function resolveBrowserLinkTargetPreference(): Promise<LinkOpenTarget> {
  await ensureClientPrefsHydrated();
  return getClientPrefs().browserLinkTarget;
}

/** Whether the in-app target is available at all in this client. */
export function canOpenLinksInApp(hasThread: boolean): boolean {
  return hasThread && isWebSupportedInRuntime();
}
