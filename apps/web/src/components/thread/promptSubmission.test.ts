import {
  AGENT_SEND_TURN_MAX_INPUT_CHARS as LIMIT,
  HostId,
  ItemId,
  REPLY_FOOTNOTE_MAX_TEXT_LENGTH,
  ThreadId,
} from "@kora/contracts";
import {
  expandAssistantFootnotesForAgent as expand,
  serializeReplyFootnote,
} from "@kora/shared/assistantFootnotes";
import { describe, expect, it, vi } from "vite-plus/test";

import { getPromptLengthValidationMessage, submitPromptDraft } from "./promptSubmission";

const x = (count: number) => "x".repeat(count);
const overBy = (count: number) =>
  `Prompt is ${count} ${count === 1 ? "character" : "characters"} over the 120,000-character limit. Shorten or split it before sending.`;

/** A canonical citation token; `text` sets how long its expansion is. */
const citation = (text = "Use the shared parser.") =>
  serializeReplyFootnote({
    version: 1,
    hostId: HostId.make("h-src"),
    threadId: ThreadId.make("t-src"),
    messageId: ItemId.make("m-src"),
    text,
    start: 0,
    end: text.length,
    prefix: "",
    suffix: "",
  });

type Target = "provider-turn" | "pending-user-input";

/** Submits with spies; `send` decides what the send boundary returns. */
function submit(
  prompt: string,
  target: Target = "provider-turn",
  extra: { providerInput?: string; send?: () => boolean | void } = {},
) {
  const preventDefault = vi.fn();
  const onSend = vi.fn(extra.send ?? (() => undefined));
  const result = submitPromptDraft({
    prompt,
    submissionTarget: target,
    event: { preventDefault },
    onSend,
    ...(extra.providerInput === undefined ? {} : { providerInput: extra.providerInput }),
  });
  return { result, onSend, preventDefault };
}

describe("prompt length limit", () => {
  it("sends a prompt exactly at the limit and leaves the event alone", () => {
    const { result, onSend, preventDefault } = submit(x(LIMIT));
    expect(result).toEqual({ didDispatch: true, validationMessage: null });
    expect(onSend).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not count surrounding whitespace, which the turn contract trims", () => {
    expect(submit(`\n ${x(LIMIT)}  `).result.didDispatch).toBe(true);
  });

  it("blocks one character over, keeps the draft, and sends once it is fixed", () => {
    const blocked = submit(x(LIMIT + 1));
    expect(blocked.result).toEqual({ didDispatch: false, validationMessage: overBy(1) });
    expect(blocked.onSend).not.toHaveBeenCalled();
    expect(blocked.preventDefault).toHaveBeenCalledOnce();

    expect(submit("Shorter now").result).toEqual({ didDispatch: true, validationMessage: null });
  });

  it("measures the composed provider input when there is one", () => {
    expect(submit("tiny", "provider-turn", { providerInput: x(LIMIT) }).result.didDispatch).toBe(
      true,
    );

    const withContext = submit(x(LIMIT), "provider-turn", {
      providerInput: `${x(LIMIT)}\n\nterminal output`,
    });
    expect(withContext.result.validationMessage).toBe(overBy(17));

    const planFollowUp = submit("", "provider-turn", {
      providerInput: `IMPLEMENT THE PLAN:\n${x(LIMIT)}`,
    });
    expect(planFollowUp.result.didDispatch).toBe(false);
    expect(planFollowUp.result.validationMessage).toContain("over the 120,000-character limit");
  });

  it("formats large overruns with thousands separators", () => {
    expect(getPromptLengthValidationMessage(x(LIMIT + 1_234))).toBe(
      overBy(1_234).replace("1234", "1,234"),
    );
  });
});

describe("citations and the limit", () => {
  it("counts a citation by its expansion when that is longer", () => {
    const token = citation();
    const sendable = ` ${x(LIMIT - expand(token).length)}${token}\n`;
    const sent = submit(sendable);
    expect(sent.result.didDispatch).toBe(true);
    // The canonical token goes out; expansion is the server's job.
    expect(sent.onSend).toHaveBeenCalledOnce();

    const tooLong = `${x(LIMIT - expand(token).length + 1)}${token}`;
    expect(tooLong.length).toBeLessThan(LIMIT);
    expect(submit(tooLong).result.validationMessage).toBe(overBy(1));
  });

  it("counts the raw text when the expansion is shorter", () => {
    const token = citation("ü".repeat(REPLY_FOOTNOTE_MAX_TEXT_LENGTH));
    const draft = `${x(LIMIT - token.length + 1)}${token}`;
    expect(expand(draft).length).toBeLessThan(LIMIT);
    expect(submit(draft).result.validationMessage).toBe(overBy(1));
  });

  it("applies the expansion rule to composed provider input too", () => {
    const followUp = `About ${citation()}\n\ncontext`;
    const input = `${x(LIMIT - expand(followUp).length + 1)}${followUp}`;
    const { result, preventDefault } = submit("About the quote", "provider-turn", {
      providerInput: input,
    });
    expect(result.validationMessage).toBe(overBy(1));
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("answers to pending questions", () => {
  it("skip the provider-turn limit entirely", () => {
    const token = citation();
    for (const answer of [x(LIMIT + 1), `${x(LIMIT - token.length)}${token}`]) {
      const { result, onSend, preventDefault } = submit(answer, "pending-user-input");
      expect(result).toEqual({ didDispatch: true, validationMessage: null });
      expect(onSend).toHaveBeenCalledOnce();
      expect(preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe("send boundary refusal", () => {
  it("reports no dispatch and cancels the event when the sender says no", () => {
    const { result, preventDefault } = submit("fine text", "provider-turn", { send: () => false });
    expect(result).toEqual({ didDispatch: false, validationMessage: null });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
