import { describe, expect, it } from "vite-plus/test";

import { collectNeedsYou, needsYouLabel, type NeedsYouThread } from "./needsYou";

const t = (id: string, over: Partial<NeedsYouThread> = {}): NeedsYouThread => ({
  hostId: "h",
  id,
  projectId: "p",
  title: id,
  updatedAt: "2026-10-13T10:00:00Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...over,
});

describe("collectNeedsYou", () => {
  it("counts approvals and questions, newest first, and nothing else", () => {
    const list = collectNeedsYou([
      t("quiet"),
      t("old", { hasPendingApprovals: true, updatedAt: "2026-10-13T09:00:00Z" }),
      t("new", { hasPendingUserInput: true, updatedAt: "2026-10-13T11:00:00Z" }),
      t("working", { session: { status: "running" } }),
    ]);
    expect(list.map((e) => [e.thread.id, e.reason])).toEqual([
      ["new", "input"],
      ["old", "approval"],
    ]);
  });

  it("skips archived threads and ones outside the surface", () => {
    const list = collectNeedsYou(
      [
        t("a", { hasPendingApprovals: true, archivedAt: "2026-10-12T00:00:00Z" }),
        t("b", { hasPendingApprovals: true, projectId: "blob" }),
        t("c", { hasPendingApprovals: true }),
      ],
      (x) => x.projectId === "p",
    );
    expect(list.map((e) => e.thread.id)).toEqual(["c"]);
  });

  it("words the count", () => {
    expect(needsYouLabel(1)).toBe("1 chat needs you");
    expect(needsYouLabel(3)).toBe("3 chats need you");
  });
});
