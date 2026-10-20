import { describe, expect, it } from "vite-plus/test";

import { formatDocumentTitle } from "./appTitle";

describe("formatDocumentTitle", () => {
  it("uses the thread title on a thread route", () => {
    expect(
      formatDocumentTitle({
        appDisplayName: "Kora (Dev)",
        pathname: "/h1/t1",
        threadTitle: "Fix the login bug",
      }),
    ).toBe("Fix the login bug · Kora (Dev)");
  });

  it("names Settings on every settings page", () => {
    for (const pathname of ["/settings", "/settings/general", "/settings/swarm"]) {
      expect(formatDocumentTitle({ appDisplayName: "Kora", pathname, threadTitle: null })).toBe(
        "Settings · Kora",
      );
    }
  });

  it("is just the app name on the draft landing, keeping the stage suffix", () => {
    expect(
      formatDocumentTitle({ appDisplayName: "Kora (Dev)", pathname: "/", threadTitle: null }),
    ).toBe("Kora (Dev)");
    expect(
      formatDocumentTitle({ appDisplayName: "Kora", pathname: "/draft/d1", threadTitle: "  " }),
    ).toBe("Kora");
  });
});
