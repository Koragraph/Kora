import { describe, expect, it } from "vite-plus/test";

import type { OutsideSetupWire } from "./outsideApi";
import {
  TOKEN_PLACEHOLDER,
  auditOutcome,
  lastUsedLabel,
  snippetFor,
  toolWords,
} from "./outsideModel";

const setup: OutsideSetupWire = {
  command: "/Users/me/.local/bin/kora",
  args: ["mcp", "--team"],
  serverName: "kora-team",
  limits: { callsPerMinute: 60, sendsPerMinute: 12 },
};

describe("config snippets", () => {
  it("Claude Desktop and Cursor get valid JSON with the token in env, not argv", () => {
    for (const k of ["claude-desktop", "cursor"] as const) {
      const j = JSON.parse(snippetFor(k, setup, "kbo_abc"));
      expect(j.mcpServers["kora-team"]).toEqual({
        command: setup.command,
        args: ["mcp", "--team"],
        env: { KORA_TEAM_TOKEN: "kbo_abc" },
      });
    }
  });
  it("Claude Code is one claude mcp add line", () => {
    expect(snippetFor("claude-code", setup, "kbo_abc")).toBe(
      "claude mcp add kora-team --env KORA_TEAM_TOKEN=kbo_abc -- /Users/me/.local/bin/kora mcp --team",
    );
  });
  it("shell-quotes paths with spaces", () => {
    expect(snippetFor("claude-code", { ...setup, command: "/Users/a b/kora" }, null)).toContain(
      "'/Users/a b/kora'",
    );
  });
  it("Codex gets TOML with the token on argv (Codex scrubs the environment)", () => {
    expect(snippetFor("codex", setup, "kbo_abc")).toBe(
      '[mcp_servers.kora-team]\ncommand = "/Users/me/.local/bin/kora"\nargs = ["mcp", "--team", "--token", "kbo_abc"]',
    );
  });
  it("uses a placeholder until a token exists, and the dev server name for Kora Dev", () => {
    expect(snippetFor("claude-desktop", setup, null)).toContain(TOKEN_PLACEHOLDER);
    expect(
      snippetFor(
        "cursor",
        {
          ...setup,
          serverName: "kora-dev-team",
          args: ["mcp", "--team", "--socket", "/x/kora.sock"],
        },
        "t",
      ),
    ).toContain('"kora-dev-team"');
  });
});

describe("words", () => {
  it("last used", () => {
    const now = 10_000_000_000;
    expect(lastUsedLabel(null, now)).toBe("Never used");
    expect(lastUsedLabel(now - 5_000, now)).toBe("Used just now");
    expect(lastUsedLabel(now - 10 * 60_000, now)).toBe("Used 10 min ago");
    expect(lastUsedLabel(now - 5 * 3_600_000, now)).toBe("Used 5 h ago");
    expect(lastUsedLabel(now - 3 * 86_400_000, now)).toBe("Used 3 d ago");
  });
  it("tools and outcomes", () => {
    expect(toolWords("send_message")).toBe("Sent a message");
    expect(toolWords("mystery")).toBe("mystery");
    const row = { id: "a", at: 1, tokenId: "t", client: "c", tool: "x", target: null };
    expect(auditOutcome({ ...row, ok: true, note: null })).toBe("Done");
    expect(auditOutcome({ ...row, ok: false, note: "rate limited" })).toBe("Rate limited");
    expect(auditOutcome({ ...row, ok: false, note: "revoked token" })).toBe("Token revoked");
    expect(auditOutcome({ ...row, ok: false, note: "unknown tool" })).toBe("Not allowed");
  });
});
