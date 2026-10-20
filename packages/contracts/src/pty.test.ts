import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentProfileId } from "./agentProfile.ts";
import * as Pty from "./pty.ts";

/** Does `input` decode against `schema`? */
const valid = (schema: Schema.Top, input: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(schema as never)(input));

const TH = "th-pty";

describe("terminal agent env error", () => {
  it("survives encode/decode with its cause, which never reaches the message", () => {
    const cause = { operation: "vault-read", detail: "vault sealed by policy" };
    const original = new Pty.TerminalAgentEnvError({
      providerInstanceId: AgentProfileId.make("claude_proxy"),
      cause,
    });
    const back = Schema.decodeUnknownSync(Pty.PtyError)(
      Schema.encodeUnknownSync(Pty.PtyError)(original),
    );
    expect(back).toMatchObject({
      _tag: "TerminalAgentEnvError",
      providerInstanceId: "claude_proxy",
      cause,
    });
    expect(back.message).toBe(
      "Could not prepare the terminal environment for provider instance: claude_proxy",
    );
    expect(back.message.includes("vault sealed")).toBe(false);
  });
});

describe("pty inputs", () => {
  const size = { rows: 40, cols: 120 };

  it("open needs a client-chosen terminal id and env keys that are valid names", () => {
    expect(valid(Pty.PtyOpenInput, { threadId: TH, cwd: "/srv", ...size })).toBe(false);
    expect(
      valid(Pty.PtyOpenInput, { threadId: TH, cwd: "/srv", ...size, env: { "NOT-OK": "1" } }),
    ).toBe(false);
  });

  it("write and resize need a terminal id too", () => {
    expect(valid(Pty.PtyWriteInput, { threadId: TH, data: "ls\n" })).toBe(false);
    expect(valid(Pty.PtyResizeInput, { threadId: TH, ...size })).toBe(false);
  });

  it("close may ask to delete history", () => {
    expect(valid(Pty.PtyCloseInput, { deleteHistory: true, threadId: TH })).toBe(true);
  });

  it("thread input trims the id", () => {
    expect(Schema.decodeUnknownSync(Pty.PtyThreadInput)({ threadId: `  ${TH}\t` }).threadId).toBe(
      TH,
    );
  });
});
