import { RequestId } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, test } from "vite-plus/test";

import { PromptPendingApprovalPanel } from "./PromptPendingApprovalPanel";

type Approval = ComponentProps<typeof PromptPendingApprovalPanel>["approval"];

const panel = (approval: Partial<Approval> & Pick<Approval, "detail" | "requestKind">) =>
  renderToStaticMarkup(
    <PromptPendingApprovalPanel
      pendingCount={1}
      approval={{
        requestId: RequestId.make("req-7"),
        createdAt: "2026-08-24T00:00:00.000Z",
        ...approval,
      }}
    />,
  );

describe("PromptPendingApprovalPanel", () => {
  test("an MCP access request shows the app and the full message, linked by aria-describedby", () => {
    const out = panel({
      requestKind: "mcp-elicitation",
      appName: "Safari",
      detail: "Allow ChatGPT to use Safari?",
    });
    expect(out).toContain('aria-label="App access approval"');
    const id = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}"`);
    for (const text of [">App access request<", ">Safari<", "Allow ChatGPT to use Safari?"]) {
      expect(out).toContain(text);
    }
  });

  test("an extremely long app name is truncated but the message stays complete", () => {
    const appName = "B".repeat(300);
    const detail = "Allow ChatGPT to access the selected application?";
    const out = panel({ requestKind: "mcp-elicitation", appName, detail });
    expect(out).toContain("max-w-32 shrink-0 truncate");
    expect(out).toContain(appName);
    expect(out).toContain('data-approval-detail="complete"');
    expect(out).toContain(detail);
  });

  test("an empty detail falls back to the request kind's name", () => {
    expect(panel({ requestKind: "file-read", detail: "" })).toContain("File read approval");
  });

  test("a long multi-line command stays fully readable in a scrollable, focusable row", () => {
    const detail = `bun run release -- ${"y".repeat(500)}\nsecond line`;
    const out = panel({ requestKind: "command", detail });
    for (const token of [
      'data-approval-detail="complete"',
      ">Command<",
      'role="group"',
      'tabindex="0"',
      detail,
      "max-h-20",
      "overflow-auto",
      "whitespace-pre",
      "[scrollbar-width:thin]",
      "[&amp;::-webkit-scrollbar]:h-1.5",
      "min-w-0",
    ]) {
      expect(out).toContain(token);
    }
    for (const token of [
      'aria-label="Command"',
      "truncate",
      "line-clamp",
      "Command approval requested",
    ]) {
      expect(out).not.toContain(token);
    }
  });
});
