// The connected-apps client API (blobs.apps.*). Components receive it as a value (a context), so tests and the scratch
// renderer pass a fake; the app mounts the RPC-backed one (`BlobsApiProviders`). Every call answers
// `{ ok, value } | { ok: false, message, code }`: `code` is the daemon's stable error code (cap_reached, broker_down,
// alias_required, account_limit, link_expired, bad_key, registration_closed, not_configured, ...), so the UI can branch.
import type {
  AppAccountWire,
  AppDecisionWire,
  AppToolWire,
  AppToolkitWire,
  AppsStatus,
  AppsUsage,
} from "@kora/contracts";
import { createContext, createElement, useContext, type ReactNode } from "react";

export type { AppAccountWire, AppDecisionWire, AppToolWire, AppToolkitWire, AppsStatus, AppsUsage };

export type AppsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly code: string | null };

export interface ConnectLinkWire {
  readonly url: string;
  readonly expiresAt: number;
}

export interface AppsApi {
  status: () => Promise<AppsResult<AppsStatus>>;
  /** Validates the key against Composio before saving; answers the new status. The key is never echoed back. */
  setKey: (key: string) => Promise<AppsResult<AppsStatus>>;
  clearKey: () => Promise<AppsResult<AppsStatus>>;
  /** Forget this install's broker identity (linked accounts are lost). */
  resetBroker: () => Promise<AppsResult<AppsStatus>>;
  toolkits: (
    search: string | null,
    cursor: string | null,
  ) => Promise<AppsResult<{ toolkits: ReadonlyArray<AppToolkitWire>; nextCursor: string | null }>>;
  accounts: (toolkit: string | null) => Promise<AppsResult<ReadonlyArray<AppAccountWire>>>;
  /** A one-time link to open in the browser. Never store or log it. */
  connect: (toolkit: string, alias: string | null) => Promise<AppsResult<ConnectLinkWire>>;
  disconnect: (accountId: string) => Promise<AppsResult<{ removed: number }>>;
  /** Every tool of an app, for the per-blob grants editor (the owner's view, with "asks first" flags). */
  tools: (toolkit: string) => Promise<AppsResult<ReadonlyArray<AppToolWire>>>;
  decisions: (
    blobId: string | null,
    limit: number,
  ) => Promise<AppsResult<ReadonlyArray<AppDecisionWire>>>;
}

const unavailable = async (): Promise<AppsResult<never>> => ({
  ok: false,
  message: "Connected apps are not connected yet.",
  code: "unavailable",
});

export const UNAVAILABLE_APPS_API: AppsApi = {
  status: unavailable,
  setKey: unavailable,
  clearKey: unavailable,
  resetBroker: unavailable,
  toolkits: unavailable,
  accounts: unavailable,
  connect: unavailable,
  disconnect: unavailable,
  tools: unavailable,
  decisions: unavailable,
};

const Ctx = createContext<AppsApi>(UNAVAILABLE_APPS_API);

export function AppsApiProvider(props: { readonly api: AppsApi; readonly children: ReactNode }) {
  return createElement(Ctx.Provider, { value: props.api }, props.children);
}

export function useAppsApi(): AppsApi {
  return useContext(Ctx);
}
