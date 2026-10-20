import { replyFootnoteFromLocation, replyFootnoteNavigation } from "./replyFootnoteNavigation";
import { describe, expect, it } from "vite-plus/test";
import {
  createRouter,
  createRoute,
  createRootRoute,
  createMemoryHistory,
} from "@tanstack/react-router";
import { HostId, ItemId, ThreadId, type ReplyFootnote } from "@kora/contracts";

const citation: ReplyFootnote = {
  suffix: "\nAfter.",
  prefix: "Before:\n",
  end: 59,
  start: 12,
  text: "first line\n\tsecond line (with a #hash & spaces) 🚀",
  messageId: ItemId.make("assistant-one"),
  threadId: ThreadId.make("thread-one"),
  hostId: HostId.make("environment-one"),
  version: 1,
};

function createFootnoteRouter(initialEntry = "/environment-one/thread-one") {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "/$hostId/$threadId" });
  return createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: root.addChildren([thread]),
  });
}

describe("assistant citation navigation", () => {
  it("ignores non-citation fragments and missing fragments", () => {
    expect(replyFootnoteFromLocation("/environment-one/thread-one")).toBeNull();
    expect(replyFootnoteFromLocation("/environment-one/thread-one#ordinary-heading")).toBeNull();
    expect(replyFootnoteFromLocation("/a/b#assistant-citation=%invalid")).toBeNull();
    expect(replyFootnoteFromLocation(`/a/b#assistant-citation=${"a".repeat(140_000)}`)).toBeNull();
  });

  it("reactivates an identical citation instead of deduplicating its navigation", async () => {
    const router = createFootnoteRouter();
    await router.navigate(replyFootnoteNavigation(citation));
    const previous = router.state.location;
    await router.navigate(replyFootnoteNavigation(citation));

    expect(router.state.location.href).toBe(previous.href);
    expect(router.state.location.state.assistantCitationActivation).not.toBe(
      previous.state.assistantCitationActivation,
    );
    expect(router.history.length).toBe(3);
    expect(replyFootnoteFromLocation(router.state.location.href)).toEqual(citation);
  });
  it("preserves encoded quote whitespace through router navigation and reload", async () => {
    const router = createFootnoteRouter();
    await router.navigate(replyFootnoteNavigation(citation));

    expect(replyFootnoteFromLocation(router.state.location.href)).toEqual(citation);
    let href = router.history.location.href;
    for (let reload = 0; reload < 3; reload++) {
      const reloaded = createFootnoteRouter(href);
      await reloaded.load();
      // Route normalization rebuilds the current location from its decoded hash.
      await reloaded.navigate({
        replace: true,
        hash: true,
        params: { hostId: citation.hostId, threadId: citation.threadId },
        to: "/$hostId/$threadId",
      });
      href = reloaded.history.location.href;
      expect(replyFootnoteFromLocation(href)).toEqual(citation);
    }
  });
});
