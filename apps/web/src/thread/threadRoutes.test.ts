import {
  threadPageTarget,
  resolveThreadPageRef,
  resolveThreadPageRenderState,
  threadPageParams,
  isThreadRouteDeadEnd,
} from "./threadRoutes";
import { ThreadId } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";
import { describe, expect, it } from "vite-plus/test";

describe("threadRoutes", () => {
  it("redirects deleted shell-only threads", () => {
    expect(
      resolveThreadPageRenderState({
        draftThreadExists: false,
        serverThreadDetailDeleted: true,
        serverThreadDetailExists: false,
        serverThreadShellExists: true,
        bootstrapComplete: true,
      }),
    ).toBe("missing");
  });

  it("distinguishes bootstrap loading from a missing thread", () => {
    expect(
      resolveThreadPageRenderState({
        draftThreadExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailExists: false,
        serverThreadShellExists: false,
        bootstrapComplete: false,
      }),
    ).toBe("loading");
    expect(
      resolveThreadPageRenderState({
        draftThreadExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailExists: false,
        serverThreadShellExists: false,
        bootstrapComplete: true,
      }),
    ).toBe("missing");
  });

  it("renders server details and local drafts when they are ready", () => {
    expect(
      resolveThreadPageRenderState({
        draftThreadExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailExists: true,
        serverThreadShellExists: true,
        bootstrapComplete: true,
      }),
    ).toBe("ready");
    expect(
      resolveThreadPageRenderState({
        draftThreadExists: true,
        serverThreadDetailDeleted: false,
        serverThreadDetailExists: false,
        serverThreadShellExists: false,
        bootstrapComplete: true,
      }),
    ).toBe("ready");
  });

  it("keeps shell-only server threads in the loading state", () => {
    expect(
      resolveThreadPageRenderState({
        draftThreadExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailExists: false,
        serverThreadShellExists: true,
        bootstrapComplete: true,
      }),
    ).toBe("loading");
  });

  it("resolves draft and server route targets", () => {
    expect(
      threadPageTarget({
        threadId: "thread-1",
        hostId: "env-1",
      }),
    ).toEqual({
      threadRef: {
        threadId: "thread-1",
        hostId: "env-1",
      },
      kind: "server",
    });

    expect(
      threadPageTarget({
        draftId: "draft-1",
      }),
    ).toEqual({
      draftId: "draft-1",
      kind: "draft",
    });
  });

  it("resolves a scoped ref only when both params are present", () => {
    expect(
      resolveThreadPageRef({
        threadId: "thread-1",
        hostId: "env-1",
      }),
    ).toEqual({
      threadId: "thread-1",
      hostId: "env-1",
    });

    expect(resolveThreadPageRef({ hostId: "env-1" })).toBeNull();
    expect(resolveThreadPageRef({ threadId: "thread-1" })).toBeNull();
  });
  it("builds canonical thread route params from a scoped ref", () => {
    const ref = hostThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(threadPageParams(ref)).toEqual({
      threadId: "thread-1",
      hostId: "env-1",
    });
  });
  it("treats an unknown host or a missing thread with no fallback as a dead end", () => {
    const base = {
      routeHostId: "kora-local",
      primaryHostId: "kora-local",
      renderState: "ready" as const,
      shellIsLive: true,
      hostHasAnyThreads: true,
    };
    expect(isThreadRouteDeadEnd(base)).toBe(false);
    expect(isThreadRouteDeadEnd({ ...base, routeHostId: "nope" })).toBe(true);
    expect(isThreadRouteDeadEnd({ ...base, primaryHostId: null, routeHostId: "nope" })).toBe(false);
    // Missing but the route redirects to a real thread.
    expect(isThreadRouteDeadEnd({ ...base, renderState: "missing" })).toBe(false);
    expect(
      isThreadRouteDeadEnd({ ...base, renderState: "missing", hostHasAnyThreads: false }),
    ).toBe(true);
    // A cached index cannot prove a thread missing.
    expect(
      isThreadRouteDeadEnd({
        ...base,
        renderState: "missing",
        hostHasAnyThreads: false,
        shellIsLive: false,
      }),
    ).toBe(false);
  });
});
