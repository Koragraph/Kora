import { RequestId, type AgentApprovalOption } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ApprovalButtons } from "./ApprovalButtons";

const render = (choices?: ReadonlyArray<AgentApprovalOption>) =>
  renderToStaticMarkup(
    <ApprovalButtons
      requestId={RequestId.make("approval-7")}
      busy={false}
      choices={choices}
      onDecide={async () => undefined}
    />,
  );

describe("ApprovalButtons", () => {
  it("falls back to stop / decline / allow for the session / approve, Approve filled, all micro-sized", () => {
    const html = render();
    expect(html.match(/data-approval-action="(\w+)"/g)).toEqual([
      'data-approval-action="cancel"',
      'data-approval-action="decline"',
      'data-approval-action="acceptForSession"',
      'data-approval-action="accept"',
    ]);
    expect(html).toContain(">Always allow this session<");
    expect(html).toContain("bg-primary");
    expect(html).toContain("h-5");
    expect(html).toContain("sm:text-[11px]");
    expect(html).not.toContain("sm:h-6");
  });

  it("shows only the choices a provider sends", () => {
    const html = render([
      { decision: "decline", label: "No" },
      { decision: "acceptAlways", label: "Always allow Finder" },
    ]);
    expect(html).toContain(">Always allow Finder<");
    expect(html).not.toContain("Stop turn");
    expect(html).not.toContain(">Approve<");
  });

  it("truncates a long label instead of widening the row", () => {
    const label = "Let it through ".repeat(12).trim();
    const html = render([{ decision: "acceptAlways", label }]);
    expect(html).toContain(`<span class="max-w-40 truncate">${label}</span>`);
  });

  it("marks a choice that carries a warning, for sight and for screen readers", () => {
    const warning = "Anything in this folder could trigger this again unasked.";
    const html = render([
      { decision: "accept", label: "Once" },
      { decision: "acceptForSession", label: "For this thread", warning },
    ]);
    expect(html).toContain(`aria-description="${warning}"`);
    expect(html).toContain("text-warning");
  });
});
