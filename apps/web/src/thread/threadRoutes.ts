import type { HostId, HostThreadRef, ThreadId } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";

import type { DraftId } from "../stores/promptDraftStore";

export type ThreadPageTarget =
  | {
      draftId: DraftId;
      kind: "draft";
    }
  | {
      threadRef: HostThreadRef;
      kind: "server";
    };

export type ThreadPageRenderState = "loading" | "ready" | "missing";

export function resolveThreadPageRenderState(args: {
  bootstrapComplete: boolean;
  serverThreadShellExists: boolean;
  serverThreadDetailExists: boolean;
  serverThreadDetailDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadPageRenderState {
  if (!args.bootstrapComplete) {
    return "loading";
  }
  if (args.serverThreadDetailExists || args.draftThreadExists) {
    return "ready";
  }
  if (args.serverThreadDetailDeleted) {
    return "missing";
  }
  return args.serverThreadShellExists ? "loading" : "missing";
}

/**
 * A thread address that will never render: a host this client does not know (any two-segment path such as
 * `/nope/really` matches the thread route), or a thread the live index lacks with no thread to fall back to.
 */
export function isThreadRouteDeadEnd(args: {
  routeHostId: string;
  primaryHostId: string | null;
  renderState: ThreadPageRenderState;
  shellIsLive: boolean;
  hostHasAnyThreads: boolean;
}): boolean {
  if (args.primaryHostId !== null && args.routeHostId !== args.primaryHostId) return true;
  return args.renderState === "missing" && args.shellIsLive && !args.hostHasAnyThreads;
}

export function threadPageParams(handle: HostThreadRef): {
  hostId: HostId;
  threadId: ThreadId;
} {
  return {
    hostId: handle.hostId,
    threadId: handle.threadId,
  };
}

export function resolveThreadPageRef(
  routeParams: Partial<Record<"hostId" | "threadId", string | undefined>>,
): HostThreadRef | null {
  if (!routeParams.hostId || !routeParams.threadId) {
    return null;
  }

  return hostThreadRef(routeParams.hostId as HostId, routeParams.threadId as ThreadId);
}

export function threadPageTarget(
  routeParams: Partial<Record<"hostId" | "threadId" | "draftId", string | undefined>>,
): ThreadPageTarget | null {
  if (routeParams.hostId && routeParams.threadId) {
    return {
      kind: "server",
      threadRef: hostThreadRef(routeParams.hostId as HostId, routeParams.threadId as ThreadId),
    };
  }

  if (!routeParams.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: routeParams.draftId as DraftId,
  };
}
