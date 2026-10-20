import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hosts/primary/shellAuth", () => ({
  fetchPrimaryHost: vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "t1" }) })),
}));
vi.mock("~/hosts/primary/target", () => ({
  resolvePrimaryHostHttpUrl: (path: string, q?: Record<string, string>) =>
    `http://127.0.0.1:5000${path}${q ? `?${new URLSearchParams(q)}` : ""}`,
}));

import { CONNECT_TIMEOUT_MS, connectLive } from "./liveConnection";

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = "";
  closed = false;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor(public url: URL) {
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
  send() {}
}

describe("connectLive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("an open socket is left alone, and closing it by hand reports nothing", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const c = connectLive("blob_a", { onOpen, onText() {}, onFrame() {}, onClose });
    await vi.advanceTimersByTimeAsync(5);
    FakeSocket.last!.readyState = 1;
    FakeSocket.last!.onopen!();
    expect(onOpen).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(onClose).not.toHaveBeenCalled();
    c.close();
    expect(FakeSocket.last!.closed).toBe(true);
  });

  it("a socket that never opens (a proxy swallowed the upgrade) is given up on, as a failed attempt", async () => {
    const onClose = vi.fn();
    connectLive("blob_a", { onOpen() {}, onText() {}, onFrame() {}, onClose });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 100);
    expect(onClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onClose).toHaveBeenCalledWith({ code: 1006, wasOpen: false });
    expect(FakeSocket.last!.closed).toBe(true);
  });

  it("uses a ticket in the query of a ws:// URL for the blob's live path", async () => {
    connectLive("blob_a", { onOpen() {}, onText() {}, onFrame() {}, onClose() {} });
    await vi.advanceTimersByTimeAsync(5);
    expect(FakeSocket.last!.url.protocol).toBe("ws:");
    expect(FakeSocket.last!.url.pathname).toBe("/blob-browser/blob_a/live");
    expect(FakeSocket.last!.url.searchParams.get("wsTicket")).toBe("t1");
  });
});
