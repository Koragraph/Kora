import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { daemonConfig } from "./config.ts";
import { onAgentsChanged } from "./modelRefresh.ts";
import { applyHealthToAgents, claudeReadiness, codexReadiness } from "./agentReadinessInfo.ts";

const row = (id: string, status: string, detail: string, fix: string | null = null) => ({
  id,
  status,
  detail,
  fix,
});

const FRESH_MAC = [
  row(
    "claude-cli",
    "fail",
    "Claude Code is not installed (no `claude` command found).",
    "In Terminal, run `curl -fsSL https://claude.ai/install.sh | bash`.",
  ),
  row("claude-auth", "skip", "Not logged in. Install Claude Code first, then log in."),
  row("codex", "skip", "Not installed.", "Optional. Run `npm install -g @openai/codex`."),
];

NodeTest.test("a fresh Mac: Claude not installed + signed out, Codex unavailable", () => {
  const claude = claudeReadiness(FRESH_MAC)!;
  NodeAssert.equal(claude.installed, false);
  NodeAssert.equal(claude.version, null);
  NodeAssert.deepEqual(claude.auth, { status: "unauthenticated" });
  NodeAssert.match(claude.message ?? "", /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  NodeAssert.ok(!(claude.message ?? "").includes("`"));
  const codex = codexReadiness(FRESH_MAC)!;
  NodeAssert.equal(codex.installed, false);
  NodeAssert.equal(codex.status, "error");
});

NodeTest.test("a set-up Mac: real versions and signed in", () => {
  const rows = [
    row("claude-cli", "ok", "v2.1.286 at ~/.local/bin/claude"),
    row("claude-auth", "ok", "Logged in via claude.ai, max plan"),
    row("codex", "ok", "v0.155.1 at ~/.local/bin/codex; logged in using ChatGPT"),
  ];
  const claude = claudeReadiness(rows)!;
  NodeAssert.equal(claude.installed, true);
  NodeAssert.equal(claude.version, "2.1.286");
  NodeAssert.deepEqual(claude.auth, {
    status: "authenticated",
    type: "subscription",
    label: "claude.ai",
  });
  NodeAssert.equal("message" in claude, false);
  const codex = codexReadiness(rows)!;
  NodeAssert.equal(codex.version, "0.155.1");
  NodeAssert.equal(codex.status, "ready");
  NodeAssert.equal(codex.auth.status, "authenticated");
});

NodeTest.test("a timed-out probe is not a verdict: auth unknown, never signed out", () => {
  const rows = [
    row("claude-cli", "ok", "v2.1.286 at ~/.local/bin/claude"),
    row("claude-auth", "warn", "Timed out after 12 s."),
    row("codex", "warn", "Timed out after 12 s."),
  ];
  NodeAssert.equal(claudeReadiness(rows)!.auth.status, "unknown");
  NodeAssert.equal(claudeReadiness(rows)!.installed, true);
  const codex = codexReadiness(rows)!;
  NodeAssert.equal(codex.installed, true);
  NodeAssert.equal(codex.status, "ready");
  NodeAssert.equal(codex.auth.status, "unknown");
});

NodeTest.test(
  "applyHealthToAgents patches the entries, keeps Claude routable, and notifies once",
  () => {
    let frames = 0;
    const off = onAgentsChanged(() => frames++);
    try {
      NodeAssert.equal(applyHealthToAgents({ checks: FRESH_MAC }), true);
      const claude = daemonConfig.providers.find((p) => p.instanceId === "claude")!;
      const codex = daemonConfig.providers.find((p) => p.instanceId === "codex")!;
      NodeAssert.equal(claude.status, "ready");
      NodeAssert.equal(claude.installed, false);
      NodeAssert.equal(claude.auth.status, "unauthenticated");
      NodeAssert.equal(codex.status, "error");
      NodeAssert.equal(frames, 1);
      // The same answer again changes nothing and stays quiet.
      NodeAssert.equal(applyHealthToAgents({ checks: FRESH_MAC }), false);
      NodeAssert.equal(frames, 1);
      // A report about other checks leaves the providers alone.
      NodeAssert.equal(applyHealthToAgents({ checks: [row("disk", "ok", "50 GB free")] }), false);
      // Logging in clears the message (no stale "not installed" text left behind).
      applyHealthToAgents({
        checks: [
          row("claude-cli", "ok", "v2.1.286 at ~/.local/bin/claude"),
          row("claude-auth", "ok", "Logged in via claude.ai"),
        ],
      });
      NodeAssert.equal(claude.auth.status, "authenticated");
      NodeAssert.equal(claude.message, undefined);
      NodeAssert.equal(JSON.stringify(claude).includes("undefined"), false);
    } finally {
      off();
    }
  },
);
