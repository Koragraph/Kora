import { HostId } from "@kora/contracts";
import * as Schema from "effect/Schema";

/** The local daemon. */
export class LocalLinkTarget extends Schema.TaggedClass<LocalLinkTarget>()("LocalLinkTarget", {
  hostId: HostId,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  label: Schema.String,
}) {}

// Kora talks to exactly one daemon, so a target is always the local one.
export const LinkTarget = LocalLinkTarget;
export type LinkTarget = LocalLinkTarget;
export type LinkTargetKind = LinkTarget["_tag"];

export type NetworkStatus = "unknown" | "offline" | "online";

export const LinkTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
]);
export type LinkTransientReason = typeof LinkTransientReason.Type;

export const LinkBlockedReason = Schema.Literals([
  ...(["authentication", "configuration"] as const),
  ...(["permission", "unsupported"] as const),
]);
export type LinkBlockedReason = (typeof LinkBlockedReason)["Type"];

// `traceId` is optionalKey so it is omitted rather than undefined on the JSON wire.
export class LinkTransientError extends Schema.TaggedError<LinkTransientError>()(
  "LinkTransientError",
  {
    reason: LinkTransientReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return this.detail;
  }
}

export class LinkBlockedError extends Schema.TaggedError<LinkBlockedError>()("LinkBlockedError", {
  reason: LinkBlockedReason,
  detail: Schema.String,
  traceId: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return this.detail;
  }
}

export type LinkAttemptError = LinkTransientError | LinkBlockedError;

export interface PreparedHttpAuthorization {
  readonly _tag: "Bearer";
  readonly token: string;
}

export interface PreparedLink {
  readonly hostId: HostId;
  readonly target: LinkTarget;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly socketUrl: string;
  readonly httpBaseUrl: string;
  readonly label: string;
}

export type SupervisorLinkPhase =
  | "blocked"
  | "connected"
  | "backoff"
  | "connecting"
  | "offline"
  | "available";

export type LinkAttemptStage = "preparing" | "opening" | "synchronizing";

export interface SupervisorLinkState {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorLinkPhase;
  readonly stage: LinkAttemptStage | null;
  readonly attempt: number;
  /** Advances only for attempts that actually connected; durable streams key on it. */
  readonly generation: number;
  readonly lastFailure: LinkAttemptError | null;
  readonly retryAt: number | null;
}

export type LinkProjectionPhase = "disconnected" | "synchronizing" | "ready";

export function linkProjectionPhase(state: SupervisorLinkState): LinkProjectionPhase {
  const { phase } = state;
  if (phase === "connected") return "ready";
  return phase === "connecting" ? "synchronizing" : "disconnected";
}

export const AVAILABLE_LINK_STATE: SupervisorLinkState = Object.freeze({
  retryAt: null,
  lastFailure: null,
  generation: 0,
  attempt: 0,
  stage: null,
  phase: "available",
  network: "unknown",
  desired: false,
});
