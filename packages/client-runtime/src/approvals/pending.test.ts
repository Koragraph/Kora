import { EventId, type ChatThreadActivity } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { approvalDetailFromArgs, derivePendingRequests } from "./pending.ts";

let serial = 0;
const T = (second: number) => `2025-06-06T06:06:${String(second).padStart(2, "0")}.000Z`;

/** An activity row of `kind`; only kind and payload matter to the reducer, plus time for order. */
function act(
  kind: string,
  payload: Record<string, unknown>,
  at = T(0),
  extra: Partial<ChatThreadActivity> = {},
) {
  serial += 1;
  return {
    id: EventId.make(`row-${serial}`),
    kind,
    payload,
    createdAt: at,
    summary: kind,
    tone: "info",
    turnId: null,
    ...extra,
  } as ChatThreadActivity;
}

const pending = (...rows: ChatThreadActivity[]) => derivePendingRequests(rows);
const NONE = { approvals: [], userInputs: [] };

const askedFor = (requestId: string, payload: Record<string, unknown>, at?: string) =>
  act("approval.requested", { requestId, ...payload }, at);
const asked = (
  requestId: string,
  questions: unknown[],
  extra: Record<string, unknown> = {},
  at?: string,
) => act("user-input.requested", { requestId, questions, ...extra }, at);

const question = (overrides: Record<string, unknown> = {}) => ({
  id: "q1",
  header: "Pick",
  question: "Which branch?",
  options: [{ label: "trunk", description: "The main line" }],
  multiSelect: false,
  ...overrides,
});

describe("pending approvals", () => {
  it.each([{}, { requestType: "something_new" }])(
    "falls back to a command approval when no kind is recognised (%j)",
    (extra) => {
      const row = askedFor("legacy-1", { detail: "**", ...extra });
      expect(pending(row).approvals).toEqual([
        { requestId: "legacy-1", requestKind: "command", createdAt: row.createdAt, detail: "**" },
      ]);
    },
  );

  it.each(["tool_user_input", "auth_tokens_refresh"])("ignores %s requests", (requestType) => {
    expect(pending(askedFor("x", { requestType })).approvals).toEqual([]);
  });

  it("keeps open approvals and drops ones resolved even before they were requested", () => {
    const result = pending(
      askedFor("keep", { requestKind: "command", detail: "make test" }, T(1)),
      act("approval.resolved", { requestId: "gone" }, T(3)),
      askedFor("gone", { requestType: "something_new" }, T(2)),
    );
    expect(result.approvals).toEqual([
      { requestId: "keep", requestKind: "command", createdAt: T(1), detail: "make test" },
    ]);
  });

  it.each([
    ["command_execution_approval", "command", "ls -la"],
    ["dynamic_tool_call", "command", "Fetch a page"],
  ])("maps native type %s to %s", (requestType, requestKind, detail) => {
    expect(pending(askedFor("n-1", { requestType, detail }, T(4))).approvals).toEqual([
      { requestId: "n-1", requestKind, createdAt: T(4), detail },
    ]);
  });

  it("keeps the app name and the persistence options of an app access request", () => {
    const options = [
      { decision: "accept", label: "Allow once" },
      { decision: "acceptAlways", label: "Always allow Notes" },
      { decision: "decline", label: "Deny" },
    ];
    const result = pending(
      askedFor("app-1", {
        requestType: "mcp_elicitation_approval",
        detail: "Let the agent read Notes?",
        appName: "Notes",
        options,
      }),
    );
    expect(result.approvals).toEqual([
      {
        requestId: "app-1",
        requestKind: "mcp-elicitation",
        createdAt: T(0),
        detail: "Let the agent read Notes?",
        appName: "Notes",
        options,
      },
    ]);
  });

  it.each([
    ["an unknown request", "Unknown pending permission request: stale-1"],
    [
      "a request that did not survive a restart",
      "Stale pending approval request: stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
    ],
  ])("closes an approval when the reply fails for %s", (_label, detail) => {
    const result = pending(
      askedFor("stale-1", { requestKind: "command" }, T(1)),
      act("provider.approval.respond.failed", { requestId: "stale-1", detail }, T(2)),
    );
    expect(result.approvals).toEqual([]);
  });
});

describe("pending questions", () => {
  it("does not trim native answer keys and skips malformed options and questions", () => {
    const native = question({
      id: "\tWhich one?\n",
      header: "  Choice ",
      question: "\tWhich one?\n",
      options: [{ label: "  spaced  ", description: "", value: "\tkeep\n" }],
    });
    const row = asked("nat-1", [null, { ...native, options: [...native.options, { label: 7 }] }]);
    expect(pending(row).userInputs[0]?.questions).toEqual([native]);
  });

  it("keeps a free-text question with no suggestions, and async ones can be dismissed", () => {
    const freeText = question({
      id: "0",
      question: "Name for the module?",
      options: [],
      allowCustomAnswer: true,
    });
    const result = pending(asked("free-1", [freeText], { responseMode: "message" }));
    expect(result.userInputs[0]).toMatchObject({ questions: [freeText], dismissible: true });
  });

  it("does not let a native callback question be dismissed", () => {
    expect(pending(asked("nat-2", [question()])).userInputs[0]?.dismissible).toBe(false);
  });

  it("keeps native option values and a ban on custom answers", () => {
    const choice = question({
      id: "pick-result",
      options: [
        { value: "\talpha ", label: "Same label", description: "First" },
        { value: "beta", label: "Same label", description: "Second" },
      ],
      allowCustomAnswer: false,
    });
    expect(pending(asked("nat-3", [choice])).userInputs[0]?.questions).toEqual([choice]);
  });

  it("keeps open prompts, oldest first, and drops resolved ones", () => {
    const sandbox = question({
      id: "mode",
      header: "Mode",
      question: "Which mode?",
      multiSelect: true,
    });
    const result = pending(
      asked("open", [sandbox], {}, T(1)),
      act("user-input.resolved", { requestId: "done", answers: { mode: "trunk" } }, T(3)),
      asked("done", [question({ id: "go", question: "Go on?" })], {}, T(2)),
    );
    expect(result.userInputs).toEqual([
      { requestId: "open", createdAt: T(1), dismissible: false, questions: [sandbox] },
    ]);
  });

  it("closes a prompt the provider says it no longer knows", () => {
    const result = pending(
      asked("orphan", [question()], {}, T(1)),
      act(
        "provider.user-input.respond.failed",
        {
          requestId: "orphan",
          detail:
            "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: orphan",
        },
        T(2),
      ),
    );
    expect(result.userInputs).toEqual([]);
  });
});

describe.each(["approval", "user-input"])("closing a %s request", (family) => {
  const opened = act(
    `${family}.requested`,
    {
      requestId: "r-1",
      requestKind: "command",
      questions: [{ id: "a", header: "A", question: "Proceed?", options: [] }],
    },
    T(0),
    { sequence: 10 },
  );

  it.each([`${family}.resolved`, `provider.${family}.respond.failed`])(
    "%s stays final whatever the order and repeats",
    (kind) => {
      const close = act(
        kind,
        { requestId: "r-1", detail: `Unknown pending ${family} request: r-1` },
        T(1),
      );
      const replay = { ...opened, id: EventId.make("replay"), sequence: 11 };
      expect(pending(opened, close, replay)).toEqual(NONE);
      expect(pending(close, opened, replay)).toEqual(NONE);
    },
  );

  it("stays open after an ordinary reply failure until it is resolved", () => {
    const failure = act(`provider.${family}.respond.failed`, {
      requestId: "r-1",
      detail: "request timed out",
    });
    const stillOpen = pending(opened, failure);
    expect(
      [...stillOpen.approvals, ...stillOpen.userInputs].map(({ requestId }) => requestId),
    ).toEqual(["r-1"]);

    const resolved = act(`${family}.resolved`, { requestId: "r-1" });
    expect(pending(opened, failure, resolved, failure)).toEqual(NONE);
  });
});

describe("approval detail from tool arguments", () => {
  it("shows a command as-is", () => {
    expect(approvalDetailFromArgs({ command: "git push --force" })).toBe("git push --force");
  });

  it("shows a file edit with line counts and the changed lines", () => {
    const detail = approvalDetailFromArgs({
      file_path: "/src/util.js",
      old_string: "function sum(xs) {",
      new_string: "function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);",
    });
    expect(detail?.split("\n").slice(0, 4)).toEqual([
      "/src/util.js  (+2 -1)",
      "- function sum(xs) {",
      "+ function sum(xs) {",
      "+   return xs.reduce((a, b) => a + b, 0);",
    ]);
  });

  it("fills in an approval that arrived without a detail", () => {
    const row = askedFor("args-1", {
      requestKind: "file-change",
      args: { file_path: "notes.md", content: "todo" },
    });
    expect(pending(row).approvals[0]?.detail).toBe("notes.md  (+1 -0)\n+ todo");
  });

  it.each([{ unrelated: true }, null])("returns null for %j", (args) => {
    expect(approvalDetailFromArgs(args)).toBeNull();
  });
});
