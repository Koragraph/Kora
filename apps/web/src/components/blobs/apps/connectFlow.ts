// The connect flow, with no React in it: get a link, hand it to the browser, then poll the account list until the
// OAuth round trip produced a new ACTIVE account (or the link / the wait runs out). The hook (`useConnectApp`) renders
// each phase; this file is what the tests drive with a fake API and a fake clock.
import type { AppAccountWire, AppsApi } from "./appsApi";
import { isActive } from "./appsModel";

export type ConnectPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "starting"; readonly toolkit: string }
  /** The browser was asked to open `url`; it is also shown as a link in case the browser did not come up. */
  | {
      readonly phase: "waiting";
      readonly toolkit: string;
      readonly url: string;
      readonly expiresAt: number;
    }
  | { readonly phase: "connected"; readonly toolkit: string; readonly account: AppAccountWire }
  | {
      readonly phase: "error";
      readonly toolkit: string;
      readonly code: string | null;
      readonly message: string;
    };

export interface ConnectDeps {
  readonly api: AppsApi;
  /** Open a URL in the user's browser. May throw / do nothing: the waiting phase always shows the link too. */
  readonly open: (url: string) => Promise<void> | void;
  readonly onPhase: (p: ConnectPhase) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  /** How long to wait for the sign-in to finish. Default 2 minutes. */
  readonly timeoutMs?: number;
  readonly cancelled?: () => boolean;
}

const POLL_MS = 2000;
const WAIT_MS = 120_000;

/** Runs one connect to its end. Resolves with the final phase (also reported through `onPhase`). */
export async function runConnect(
  toolkit: string,
  alias: string | null,
  d: ConnectDeps,
): Promise<ConnectPhase> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const done = (p: ConnectPhase): ConnectPhase => {
    d.onPhase(p);
    return p;
  };
  d.onPhase({ phase: "starting", toolkit });

  // What is connected now, so the new account is recognised by what it adds.
  const beforeRes = await d.api.accounts(toolkit);
  const before = new Set((beforeRes.ok ? beforeRes.value : []).map((a) => a.id));

  const link = await d.api.connect(toolkit, alias?.trim() ? alias.trim() : null);
  if (!link.ok) return done({ phase: "error", toolkit, code: link.code, message: link.message });
  if (link.value.expiresAt <= now()) {
    return done({
      phase: "error",
      toolkit,
      code: "link_expired",
      message: "That connect link has expired. Start again to get a new one.",
    });
  }
  d.onPhase({ phase: "waiting", toolkit, url: link.value.url, expiresAt: link.value.expiresAt });
  try {
    await d.open(link.value.url);
  } catch {
    /* the visible link is the fallback */
  }

  const end = Math.min(now() + (d.timeoutMs ?? WAIT_MS), link.value.expiresAt);
  for (;;) {
    if (d.cancelled?.()) return { phase: "idle" };
    await sleep(d.pollMs ?? POLL_MS);
    if (d.cancelled?.()) return { phase: "idle" };
    const r = await d.api.accounts(toolkit);
    if (r.ok) {
      const hit = r.value.find((a) => !before.has(a.id) && isActive(a));
      if (hit) return done({ phase: "connected", toolkit, account: hit });
    }
    if (now() >= end) {
      return done({
        phase: "error",
        toolkit,
        code: "link_expired",
        message:
          "The sign-in did not finish. If you closed the page, start again to get a fresh link.",
      });
    }
  }
}
