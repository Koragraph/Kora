import { shouldShowWebEmptyState } from "./webEmptyStateLogic";
import { describe, expect, it } from "vite-plus/test";
import type { WebSessionSnapshot } from "@kora/contracts";

const snapshot = (navStatus: WebSessionSnapshot["navStatus"]): WebSessionSnapshot => ({
  updatedAt: "2026-06-12T20:00:00.000Z",
  canGoForward: false,
  canGoBack: false,
  navStatus,
  tabId: "tab-1",
  threadId: "thread-1",
});

describe("shouldShowWebEmptyState", () => {
  it("shows browser content once navigation starts", () => {
    expect(
      shouldShowWebEmptyState(
        snapshot({ _tag: "Loading", url: "http://localhost:5173", title: "" }),
      ),
    ).toBe(false);
  });
  it("shows quick-open options for a new idle browser tab", () => {
    expect(shouldShowWebEmptyState(snapshot({ _tag: "Idle" }))).toBe(true);
  });
});
