import { describe, expect, it } from "vite-plus/test";

import { canLogInFromApp, claudeLoginAction, parseClaudeLoginState } from "./claudeLogin";
import type { HealthCheck } from "./healthCheck";

const row = (o: Partial<HealthCheck>): HealthCheck => ({
  id: "claude-auth",
  label: "Claude login",
  status: "fail",
  detail: "Claude Code is not logged in",
  fix: null,
  ...o,
});

describe("claudeLogin", () => {
  it("offers the button only on a failed login row the daemon can run itself", () => {
    expect(canLogInFromApp(row({ data: { login: "bundled" } }))).toBe(true);
    expect(canLogInFromApp(row({ data: { login: "cli" } }))).toBe(true);
    expect(canLogInFromApp(row({}))).toBe(false); // an older daemon: no data, no button
    expect(canLogInFromApp(row({ status: "ok", data: { login: "cli" } }))).toBe(false);
    expect(canLogInFromApp(row({ id: "codex", data: { login: "cli" } }))).toBe(false);
  });

  it("reads the state defensively and only keeps an https sign-in URL", () => {
    expect(
      parseClaudeLoginState({ phase: "waiting", url: "https://claude.com/x", via: "bundled" }),
    ).toEqual({
      phase: "waiting",
      url: "https://claude.com/x",
      message: null,
      via: "bundled",
    });
    expect(parseClaudeLoginState({ phase: "waiting", url: "javascript:alert(1)" })?.url).toBeNull();
    expect(parseClaudeLoginState({ phase: "bogus" })).toBeNull();
    expect(parseClaudeLoginState(null)).toBeNull();
  });

  it("posts JSON actions and explains an older daemon", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ok = async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({ phase: "waiting", url: null, message: null, via: "cli" }),
      );
    };
    const state = await claudeLoginAction("http://127.0.0.1:8797", { action: "start" }, ok);
    expect(state.phase).toBe("waiting");
    expect(calls[0]?.url).toBe("http://127.0.0.1:8797/api/claude/login");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    await expect(
      claudeLoginAction(
        "http://x",
        { action: "start" },
        async () => new Response("", { status: 404 }),
      ),
    ).rejects.toThrow(/Update Kora/);
  });
});
