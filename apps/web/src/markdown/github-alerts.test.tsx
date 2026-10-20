import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, test } from "vite-plus/test";

import { remarkGithubAlerts } from "./github-alerts";

const toHtml = (md: string) =>
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkGithubAlerts]}>{md}</ReactMarkdown>,
  );

describe("remarkGithubAlerts", () => {
  test("a [!KIND] first line tags the quote and disappears from the text", () => {
    const out = toHtml("> [!NOTE]\n> Body of the note.");
    expect(out).toContain('data-alert="note"');
    expect(out).not.toContain("[!NOTE]");
    expect(out).toContain("Body of the note.");
  });

  test("the kind is matched without regard to case and emitted lowercase", () => {
    expect(toHtml("> [!Important]\n> Heads up.")).toContain('data-alert="important"');
    expect(toHtml("> [!TIP]\n> Heads up.")).toContain('data-alert="tip"');
  });

  test("a marker followed by inline markup still counts", () => {
    const out = toHtml("> [!NOTE]\n> **Risk** touches routing.");
    expect(out).toContain('data-alert="note"');
    expect(out).toContain("<strong>Risk</strong>");
    expect(out).not.toContain("[!NOTE]");
  });

  test("blocks after a marker-only paragraph are kept", () => {
    const out = toHtml("> [!WARNING]\n>\n> ### Title\n>\n> Then prose.");
    expect(out).toContain('data-alert="warning"');
    expect(out).toContain("Title");
    expect(out).toContain("Then prose.");
    expect(out).not.toContain("[!WARNING]");
  });

  test.each([
    ["an unknown kind", "> [!DANGER]\n> Nope.", "[!DANGER]"],
    ["text on the marker line", "> [!NOTE] inline text", "[!NOTE] inline text"],
    ["a marker that is not first", "> intro\n> [!NOTE]\n> later", "[!NOTE]"],
    ["no quote at all", "[!NOTE]\nplain", "[!NOTE]"],
  ])("%s is left as ordinary text", (_label, md, visible) => {
    const out = toHtml(md);
    expect(out).not.toContain("data-alert");
    expect(out).toContain(visible);
  });
});
