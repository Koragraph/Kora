import { HostId, ThreadId } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("./WebFaviconIcon", () => ({ WebFaviconIcon: () => <span data-favicon-icon /> }));

import { WebEmptyState } from "./WebEmptyState";

type Entry = { url: string; lastVisitedAt: number; title?: string };

const page = (recentEntries: Entry[]) =>
  renderToStaticMarkup(
    <WebEmptyState
      threadRef={{ hostId: HostId.make("h1"), threadId: ThreadId.make("t1") }}
      recentEntries={recentEntries}
      onRemoveRecent={() => undefined}
      onOpenUrl={() => undefined}
    />,
  );

describe("WebEmptyState", () => {
  test("with no history it says so and suggests the common dev port", () => {
    const out = page([]);
    expect(out).toContain("Nothing loaded");
    expect(out).toContain("localhost:5173");
  });

  test("recent pages are listed with their titles under a resume heading", () => {
    const now = Date.now();
    const out = page([
      { url: "https://app.test/admin#users", lastVisitedAt: now, title: "Admin" },
      { url: "http://localhost:5173/", lastVisitedAt: now, title: "Recent Local" },
    ]);
    for (const text of [
      "Pick up where you left off",
      "app.test/admin#users",
      "Admin",
      "Recent Local",
    ]) {
      expect(out).toContain(text);
    }
  });

  test("an absurd visit timestamp does not break rendering", () => {
    let out = "";
    expect(() => {
      out = page([{ url: "https://app.test/", lastVisitedAt: 1e20 }]);
    }).not.toThrow();
    expect(out).toContain("app.test");
    expect(out).toContain("Remove");
  });
});
