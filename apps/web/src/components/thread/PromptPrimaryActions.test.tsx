import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { PromptPrimaryActions } from "./PromptPrimaryActions";

type Props = ComponentProps<typeof PromptPrimaryActions>;

const IDLE: Props = {
  compact: true,
  isRunning: false,
  isConnecting: false,
  isSendBusy: false,
  isHostUnavailable: false,
  hasSendableContent: false,
  promptHasText: false,
  offerPlanFollowUp: false,
  sendDisabledReason: null,
  pendingAction: null,
  onInterrupt: () => {},
  onPreviousPendingQuestion: () => {},
  onImplementPlanInNewThread: () => {},
};

const html = (over: Partial<Props>) =>
  renderToStaticMarkup(<PromptPrimaryActions {...IDLE} {...over} />);

const STOP = 'aria-label="Stop generation"';
const QUEUE = 'aria-label="Queue message"';
const finishedQuestion = {
  isComplete: true,
  isResponding: false,
  canAdvance: true,
  isLastQuestion: true,
  questionIndex: 0,
};

describe("while a turn runs", () => {
  test("an empty composer shows only Stop", () => {
    const out = html({ isRunning: true });
    expect(out).toContain(STOP);
    expect(out).not.toContain(QUEUE);
  });

  test("a sendable draft adds a submit button to queue it next to Stop", () => {
    const out = html({ isRunning: true, hasSendableContent: true, promptHasText: true });
    expect(out).toContain(STOP);
    expect(out).toContain(QUEUE);
    expect(out).toContain('type="submit"');
  });
});

describe("with a pending question", () => {
  test.each([
    [true, true],
    [false, false],
  ])("isRunning=%s -> Stop shown: %s", (isRunning, shown) => {
    const out = html({ isRunning, pendingAction: finishedQuestion });
    expect(out.includes(STOP)).toBe(shown);
  });
});

describe("the send button", () => {
  test("is the neutral foreground-coloured circle", () => {
    expect(html({ hasSendableContent: true, promptHasText: true })).toContain("bg-foreground");
  });

  test("is disabled and carries the reason as its label", () => {
    const out = html({
      hasSendableContent: true,
      promptHasText: true,
      sendDisabledReason: "Sending feedback",
    });
    expect(out).toContain("disabled");
    expect(out).toContain('aria-label="Sending feedback"');
  });
});
