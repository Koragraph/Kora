import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import * as Banner from "./ThreadErrorBanner";

const { ThreadErrorBanner } = Banner;
const noop = () => {};

describe("ThreadErrorBanner rendering", () => {
  it("renders nothing without an error", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} />)).toBe("");
    expect(renderToStaticMarkup(<ThreadErrorBanner error="" />)).toBe("");
  });

  it("always offers copying; retry and dismiss only when wired", () => {
    const bare = renderToStaticMarkup(<ThreadErrorBanner error="exit 2" />);
    expect(bare).toContain('aria-label="Copy error details"');
    expect(bare).not.toContain("Put prompt back");
    expect(bare).not.toContain('aria-label="Dismiss error"');

    const full = renderToStaticMarkup(
      <ThreadErrorBanner error="exit 2" onRetry={noop} onDismiss={noop} />,
    );
    expect(full).toContain("Put prompt back");
    expect(full).toContain('aria-label="Dismiss error"');
  });

  it("swaps a raw sign-in error for calm copy", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Not logged in · Please run /login" />,
    );
    expect(markup).toContain("Claude isn&#x27;t signed in.");
    expect(markup).not.toContain("Please run /login");
  });

  it("is an alert whose icons line up with the first line of a long error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={"line one\nline two"} onDismiss={noop} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("controlAlignment");
    for (const layout of [
      "flex gap-2 items-start",
      "min-h-7 pt-1 sm:min-h-6 sm:pt-0.5",
      "h-lh w-4",
      "h-lh self-start",
    ]) {
      expect(markup).toContain(layout);
    }
  });
});

describe("banner dismissal", () => {
  /** Whether the banner shows for this thread and error, given what was dismissed this session. */
  const visible = (thread: string, error: string | null) =>
    Banner.shouldShowThreadErrorBanner(
      thread,
      error,
      Banner.isThreadErrorBannerDismissedForSession(Banner.getThreadErrorBannerKey(thread, error)),
    );
  const dismiss = (thread: string, error: string) =>
    Banner.dismissThreadErrorBannerForSession(Banner.getThreadErrorBannerKey(thread, error));

  it("keys a banner by thread and message, and has no key without an error", () => {
    expect(Banner.getThreadErrorBannerKey("h:t1", "Oops")).toBe("h:t1\u0000Oops");
    expect(Banner.getThreadErrorBannerKey("h:t1", null)).toBeNull();
    expect(Banner.isThreadErrorBannerDismissedForSession(null)).toBe(false);
    Banner.dismissThreadErrorBannerForSession(null);
  });

  it("hides a dismissed error for the rest of the session", () => {
    expect(visible("h:t1", "Stopped")).toBe(true);
    dismiss("h:t1", "Stopped");
    expect(visible("h:t1", "Stopped")).toBe(false);
    // Passing through a thread with no error does not bring it back.
    expect(visible("h:t1", null)).toBe(false);
    expect(visible("h:t1", "Stopped")).toBe(false);
  });

  it("still shows the same message on another thread, or a new message on this one", () => {
    dismiss("h:t2", "Stopped");
    expect(visible("h:t9", "Stopped")).toBe(true);
    expect(visible("h:t2", "Crashed")).toBe(true);
  });

  it("respects an explicit dismissed flag", () => {
    expect(Banner.shouldShowThreadErrorBanner("h:t4", "Boom", true)).toBe(false);
  });
});
