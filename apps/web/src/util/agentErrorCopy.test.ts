import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_NOT_SIGNED_IN_COPY,
  CLAUDE_UNREACHABLE_COPY,
  CODEX_NOT_SIGNED_IN_COPY,
  friendlyAgentErrorCopy,
  GEMINI_NOT_SIGNED_IN_COPY,
  inlineAgentErrorMessageId,
} from "./agentErrorCopy";

describe("friendlyAgentErrorCopy", () => {
  it("maps the Claude SDK's signed-out error to actionable copy", () => {
    expect(friendlyAgentErrorCopy("Not logged in · Please run /login")).toBe(
      CLAUDE_NOT_SIGNED_IN_COPY,
    );
    expect(CLAUDE_NOT_SIGNED_IN_COPY).not.toContain("/login");
    expect(CLAUDE_NOT_SIGNED_IN_COPY).toContain("claude auth login");
  });

  it("translates a signed-out Codex's raw 401 into the codex login fix", () => {
    expect(
      friendlyAgentErrorCopy(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses",
      ),
    ).toBe(CODEX_NOT_SIGNED_IN_COPY);
    expect(CODEX_NOT_SIGNED_IN_COPY).toContain("codex login");
  });

  it("turns Gemini CLI's raw API_KEY_INVALID JSON into one plain sentence", () => {
    const raw =
      '{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 400,\\n \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\\n \\"details\\": [{\\"reason\\": \\"API_KEY_INVALID\\"}]}}"}}';
    expect(friendlyAgentErrorCopy(raw)).toBe(GEMINI_NOT_SIGNED_IN_COPY);
  });

  it("leaves other errors alone", () => {
    expect(friendlyAgentErrorCopy("Provider crashed")).toBeNull();
    expect(friendlyAgentErrorCopy("The user is not logged in to GitHub")).toBeNull();
    expect(friendlyAgentErrorCopy(null)).toBeNull();
  });
});

// B7 (night 2026-10-04): recorded from the bundled Claude Code with no network — the reply and the result both carry it.
const OFFLINE_REPLY =
  "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)";

describe("Claude unreachable", () => {
  it("turns Claude Code's give-up line into calm copy with the fix", () => {
    expect(friendlyAgentErrorCopy(OFFLINE_REPLY)).toBe(CLAUDE_UNREACHABLE_COPY);
    expect(friendlyAgentErrorCopy("API Error: Connection error.")).toBe(CLAUDE_UNREACHABLE_COPY);
    expect(friendlyAgentErrorCopy("API Error: Request timed out.")).toBe(CLAUDE_UNREACHABLE_COPY);
    expect(CLAUDE_UNREACHABLE_COPY).toMatch(/internet connection/);
    expect(CLAUDE_UNREACHABLE_COPY).toMatch(/Retry/);
  });

  it("never rewrites an ordinary reply that only mentions a network error", () => {
    expect(
      friendlyAgentErrorCopy(
        "Your server fails with ECONNREFUSED because nothing listens on 5432.",
      ),
    ).toBeNull();
    expect(friendlyAgentErrorCopy("API Error: 400 invalid model")).toBeNull();
  });
});

// B3 (night 2026-10-04): a signed-out / offline turn showed its error twice — a banner AND the reply below it.
describe("inlineAgentErrorMessageId", () => {
  const user = { id: "u1", role: "user", text: "say hi" };
  it("finds the reply that already shows the thread's error (raw or calm copy)", () => {
    const reply = { id: "a1", role: "assistant", text: "Not logged in · Please run /login" };
    expect(inlineAgentErrorMessageId([user, reply], "Not logged in · Please run /login")).toBe(
      "a1",
    );
    const offline = { id: "a2", role: "assistant", text: OFFLINE_REPLY };
    expect(inlineAgentErrorMessageId([user, offline], `${OFFLINE_REPLY}\n`)).toBe("a2");
  });

  it("is null when the error is not the latest reply (a failure the daemon reported, an old turn, streaming)", () => {
    expect(inlineAgentErrorMessageId([user], "spawn ENOTDIR")).toBeNull();
    const oldReply = { id: "a1", role: "assistant", text: "Not logged in · Please run /login" };
    const later = { id: "u2", role: "user", text: "again" };
    expect(
      inlineAgentErrorMessageId([user, oldReply, later], "Not logged in · Please run /login"),
    ).toBeNull();
    const ok = { id: "a3", role: "assistant", text: "hi" };
    expect(inlineAgentErrorMessageId([user, ok], "Not logged in · Please run /login")).toBeNull();
    const streaming = { ...oldReply, streaming: true };
    expect(inlineAgentErrorMessageId([user, streaming], oldReply.text)).toBeNull();
    expect(inlineAgentErrorMessageId([user, oldReply], null)).toBeNull();
  });
});
