import { RequestId } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { PendingQuestion } from "../../thread/timeline";
import { PromptPendingUserInputPanel } from "./PromptPendingUserInputPanel";

const question = {
  id: "q-deploy",
  header: "Rollout",
  question: "How should we roll out the change?",
  multiSelect: false,
  options: [
    { label: "Canary first", description: "Ship to a slice of traffic" },
    { label: "All at once", description: "Ship to everyone together" },
  ],
};

const asking = (dismissible: boolean): PendingQuestion => ({
  questions: [question],
  dismissible,
  requestId: RequestId.make("req-9"),
  createdAt: "2026-09-01T08:00:00.000Z",
});

const panel = (dismissible = true) =>
  renderToStaticMarkup(
    <PromptPendingUserInputPanel
      pendingUserInputs={[asking(dismissible)]}
      questionIndex={0}
      answers={{}}
      respondingRequestIds={[]}
      onDismiss={() => {}}
      onAdvance={() => {}}
      onToggleOption={() => {}}
    />,
  );

describe("PromptPendingUserInputPanel", () => {
  it("opens expanded, showing the header, the question and every option", () => {
    const markup = panel();
    for (const text of [
      question.header,
      question.question,
      ...question.options.map(({ label }) => label),
    ]) {
      expect(markup).toContain(text);
    }
  });

  it("can only be dismissed when the question allows it", () => {
    expect(panel(true)).toContain("data-pending-user-input-dismiss");
    expect(panel(false)).not.toContain("data-pending-user-input-dismiss");
  });

  it("uses the header as an accessible disclosure button for the body", () => {
    const markup = panel();
    const button = /<button[^>]*data-pending-user-input-toggle=[^>]*>/.exec(markup)?.[0] ?? "";
    for (const attribute of [
      'data-pending-user-input-toggle="expanded"',
      'aria-expanded="true"',
      'type="button"',
    ]) {
      expect(button).toContain(attribute);
    }
    const target = /aria-controls="([^"]+)"/.exec(button)?.[1];
    expect(target).toBeTruthy();
    expect(markup).toContain(` id="${target}"`);
  });
});
