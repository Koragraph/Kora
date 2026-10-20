import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";

import { DiffCommentAnnotation } from "./DiffComment";

const handlers = () => ({
  onDelete: vi.fn(),
  onComment: vi.fn(),
  onCancel: vi.fn(),
  onTextChange: vi.fn(),
});
const html = (props: Partial<Parameters<typeof DiffCommentAnnotation>[0]>) =>
  renderToStaticMarkup(
    <DiffCommentAnnotation
      {...handlers()}
      kind="draft"
      rangeLabel="+78"
      text=""
      {...(props as object)}
    />,
  );
const buttonWith = (markup: string, label: string, disabled: boolean) =>
  new RegExp(`<button[^>]*${disabled ? "disabled" : ""}[^>]*>${label}</button>`).test(markup);

describe("DiffCommentAnnotation draft", () => {
  test("shows the draft text it is given", () => {
    expect(html({ text: "Unsent thought" })).toContain("Unsent thought");
  });

  test("is the shared composer: sans font, focused, text cursor, no glass or range chatter", () => {
    const out = html({});
    expect(out).toContain("font-sans");
    expect(out).toContain("Add a comment…");
    expect(out).toContain(">Comment</button>");
    expect(out).toContain("autofocus");
    expect(out).toContain("cursor-text");
    for (const absent of [
      "chat-composer-glass",
      "font-mono",
      "Local comment",
      "on +78",
      "Enter to send",
    ]) {
      expect(out).not.toContain(absent);
    }
    const control = out.match(/<span[^>]*data-slot="textarea-control"[^>]*>/)?.[0];
    expect(control).toBeDefined();
    expect(control).not.toContain("ring-ring");
  });

  test("a pull-request diff can relabel the submit and add a secondary action; both start disabled when empty", () => {
    const out = html({
      rangeLabel: "src/app.ts:4",
      submitLabel: "Add to review",
      secondaryAction: { label: "Add to agent", onAction: vi.fn() },
    });
    expect(out).toContain(">Add to review</button>");
    expect(buttonWith(out, "Add to review", true)).toBe(true);
    expect(buttonWith(out, "Add to agent", true)).toBe(true);
  });
});

describe("DiffCommentAnnotation saved comment", () => {
  test("is a flat quoted block with a delete button and no range label", () => {
    const out = html({ kind: "comment", text: "Keep this branch explicit." });
    expect(out).toContain("Keep this branch explicit.");
    expect(out).toContain('aria-label="Delete comment"');
    for (const token of [
      "font-sans",
      "border-s-2",
      "bg-primary/[0.045]",
      "lucide-message-circle",
    ]) {
      expect(out).toContain(token);
    }
    expect(out).not.toContain("chat-composer-glass");
    expect(out).not.toContain("on +78");
  });
});
