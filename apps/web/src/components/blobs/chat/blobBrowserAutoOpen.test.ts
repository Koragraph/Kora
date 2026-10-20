import type { ChatThreadActivity } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decideBrowserAutoOpen,
  isBrowserToolName,
  latestBrowserSignalTurn,
} from "./blobBrowserAutoOpen";

let n = 0;
const act = (o: {
  kind: string;
  tone?: string;
  turn?: string | null;
  payload?: unknown;
}): ChatThreadActivity =>
  ({
    id: `e${++n}`,
    tone: o.tone ?? "tool",
    kind: o.kind,
    summary: "x",
    payload: o.payload ?? {},
    turnId: o.turn === undefined ? "t1" : o.turn,
    createdAt: `2026-10-09T00:00:${String(n).padStart(2, "0")}.000Z`,
  }) as unknown as ChatThreadActivity;
const tool = (toolName: string, turn = "t1") =>
  act({ kind: "mcp_tool_call", turn, payload: { itemId: `i${n}`, toolName, input: {} } });

describe("latestBrowserSignalTurn", () => {
  it("matches browser_* tools, bare or MCP-prefixed", () => {
    expect(isBrowserToolName("browser_navigate")).toBe(true);
    expect(isBrowserToolName("mcp__kora-blob__browser_click")).toBe(true);
    expect(isBrowserToolName("Bash")).toBe(false);
    expect(isBrowserToolName("my_browser_thing")).toBe(false);
  });
  it("opens on the real Claude blob shape (mcp__kora__browser_*, the driver's tool.started)", () => {
    expect(isBrowserToolName("mcp__kora__browser_navigate")).toBe(true);
    expect(
      latestBrowserSignalTurn([tool("mcp__kora__browser_navigate", "turn_mv0tcnug0002r0")]),
    ).toBe("turn_mv0tcnug0002r0");
  });
  it("is null without browser activity", () => {
    expect(latestBrowserSignalTurn([tool("Read")])).toBeNull();
  });
  it("returns the newest turn that used the browser", () => {
    expect(
      latestBrowserSignalTurn([tool("browser_navigate", "t1"), tool("browser_click", "t2")]),
    ).toBe("t2");
  });
  it("counts an unanswered browser approval, not an answered one", () => {
    const ask = act({
      kind: "approval.requested",
      tone: "approval",
      payload: {
        requestId: "r1",
        args: { kind: "app-action", appName: "Browser", tool: "browser" },
      },
    });
    expect(latestBrowserSignalTurn([ask])).toBe("t1");
    const done = act({
      kind: "approval.resolved",
      tone: "info",
      payload: { requestId: "r1", decision: "accept" },
    });
    expect(latestBrowserSignalTurn([ask, done])).toBeNull();
  });
  it("ignores non-browser approvals", () => {
    const ask = act({
      kind: "approval.requested",
      tone: "approval",
      payload: { requestId: "r2", args: { command: "ls" } },
    });
    expect(latestBrowserSignalTurn([ask])).toBeNull();
  });
});

describe("decideBrowserAutoOpen", () => {
  const go = (
    h: Map<string, Set<string>>,
    signalTurn: string | null,
    live: string | null = "t1",
    key = "th",
  ) => decideBrowserAutoOpen({ threadKey: key, signalTurn, liveTurnId: live, handled: h });

  it("opens once per turn, even if the user then closes the panel (no second open in that turn)", () => {
    const h = new Map<string, Set<string>>();
    expect(go(h, null)).toBe(false); // first sight, nothing yet
    expect(go(h, "t1")).toBe(true); // first browser_* call of the live turn
    expect(go(h, "t1")).toBe(false); // more calls, or the user closed it: left alone
    expect(go(h, "t1")).toBe(false);
  });
  it("opens again on the next turn", () => {
    const h = new Map<string, Set<string>>();
    go(h, null);
    expect(go(h, "t1")).toBe(true);
    expect(go(h, "t2", "t2")).toBe(true);
  });
  it("treats browsing in an already-finished turn as history on first sight", () => {
    const h = new Map<string, Set<string>>();
    expect(go(h, "t1", null)).toBe(false);
    expect(go(h, "t1", null)).toBe(false);
  });
  it("still opens for a turn already running when the thread is first seen", () => {
    expect(go(new Map(), "t1", "t1")).toBe(true);
  });
  it("tracks threads separately", () => {
    const h = new Map<string, Set<string>>();
    go(h, null, "t1", "a");
    go(h, null, "t1", "b");
    expect(go(h, "t1", "t1", "a")).toBe(true);
    expect(go(h, "t1", "t1", "b")).toBe(true);
  });
});

describe("real tool-event shapes", () => {
  it("fires on a plain browser tool call (payload toolName), an MCP-prefixed one, and an ACP title-only one", () => {
    expect(
      latestBrowserSignalTurn([
        act({ kind: "mcp_tool_call", payload: { toolName: "browser_navigate", input: {} } }),
      ]),
    ).toBe("t1");
    expect(
      latestBrowserSignalTurn([
        act({ kind: "mcp_tool_call", payload: { toolName: "mcp__kora-blobs__browser_click" } }),
      ]),
    ).toBe("t1");
    expect(isBrowserToolName("kora_blobs: browser_navigate")).toBe(true);
    expect(isBrowserToolName("kora_blobs: recall")).toBe(false);
    expect(
      latestBrowserSignalTurn([
        {
          ...act({ kind: "dynamic_tool_call", payload: {} }),
          summary: "kora_blobs: browser_open",
        } as ChatThreadActivity,
      ]),
    ).toBe("t1");
  });
  it("a tool RESULT row never counts", () => {
    expect(
      latestBrowserSignalTurn([
        {
          ...act({ kind: "tool_result", payload: { status: "done" } }),
          summary: "browser_navigate done",
        } as ChatThreadActivity,
      ]),
    ).toBe(null);
  });
});
