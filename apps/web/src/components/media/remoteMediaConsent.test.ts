import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  approveRemoteMedia,
  isRemoteMediaApproved,
  remoteMediaHost,
  resetRemoteMediaApprovalsForTests,
} from "./remoteMediaConsent";

afterEach(() => resetRemoteMediaApprovalsForTests());

describe("remoteMediaHost", () => {
  it("names the host of remote web media", () => {
    expect(remoteMediaHost("https://evil.example/p.png?d=secret")).toBe("evil.example");
    expect(remoteMediaHost("http://203.0.113.9/x.gif")).toBe("203.0.113.9");
    expect(remoteMediaHost("//cdn.example.com/a.png")).toBe("cdn.example.com");
    expect(remoteMediaHost("HTTPS://Tracker.Example/x")).toBe("tracker.example");
  });

  it("needs no consent for inline, local and loopback media", () => {
    for (const src of [
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:kora://app/123",
      "http://127.0.0.1:8797/api/assets/abc",
      "http://localhost:5173/shot.png",
      "http://[::1]:3000/x.png",
      "http://app.localhost/x.png",
      "kora://app/icon.png",
      "",
      null,
      undefined,
      "not a url",
    ]) {
      expect(remoteMediaHost(src), String(src)).toBeNull();
    }
  });
});

describe("remote media approval", () => {
  it("holds remote media until the user loads that exact URL", () => {
    const src = "https://evil.example/p.png?d=secret";
    expect(isRemoteMediaApproved(src)).toBe(false);
    approveRemoteMedia(src);
    expect(isRemoteMediaApproved(src)).toBe(true);
    // Approval is per URL, not per host: a new query string is a new request.
    expect(isRemoteMediaApproved("https://evil.example/p.png?d=other")).toBe(false);
  });

  it("never holds back local media", () => {
    expect(isRemoteMediaApproved("data:image/png;base64,AAAA")).toBe(true);
    expect(isRemoteMediaApproved("http://127.0.0.1:8797/x.png")).toBe(true);
  });
});
