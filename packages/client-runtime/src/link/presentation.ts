import type { DaemonConfig } from "@kora/contracts";

import type { LinkCatalogEntry } from "./catalog.ts";
import type { SupervisorLinkState } from "./model.ts";

export type HostLinkPhase =
  | "error"
  | "connected"
  | "reconnecting"
  | "connecting"
  | "offline"
  | "available";

export interface HostLinkPresentation {
  readonly phase: HostLinkPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

export interface HostPresentation {
  readonly entry: LinkCatalogEntry;
  readonly connection: HostLinkPresentation;
  readonly daemonConfig: DaemonConfig | null;
}

const quiet = (phase: HostLinkPhase): HostLinkPresentation => ({
  phase,
  error: null,
  traceId: null,
});

const failed = (phase: HostLinkPhase, state: SupervisorLinkState): HostLinkPresentation => ({
  phase,
  error: state.lastFailure?.message ?? null,
  traceId: state.lastFailure?.traceId ?? null,
});

export function presentLinkState(state: SupervisorLinkState): HostLinkPresentation {
  switch (state.phase) {
    case "available":
    case "offline":
    case "connected":
      return quiet(state.phase);
    case "connecting":
      // The first attempt, with nothing having gone wrong, is plain "connecting".
      return state.attempt <= 1 && state.lastFailure === null
        ? quiet("connecting")
        : failed("reconnecting", state);
    case "backoff":
      return failed("reconnecting", state);
    case "blocked":
      return failed("error", state);
  }
}

const PLAIN_STATUS_TEXT = {
  available: "Available",
  offline: "Offline",
  connecting: "Connecting...",
  connected: "Connected",
} as const;

export function linkStatusText(connection: HostLinkPresentation): string {
  const { phase, error } = connection;
  if (phase === "reconnecting") {
    return error ? "Failed to connect. Reconnecting... Reason: " + error : "Reconnecting...";
  }
  if (phase === "error") {
    return error ? "Connection failed. Reason: " + error : "Connection failed";
  }
  return PLAIN_STATUS_TEXT[phase];
}

export function linkCatalogDisplayUrl(entry: LinkCatalogEntry): string | null {
  return entry.target.httpBaseUrl;
}
