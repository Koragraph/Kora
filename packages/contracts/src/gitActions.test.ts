import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Git from "./gitActions.ts";

describe("stacked git actions", () => {
  it("take a client-chosen action id with the action", () => {
    const input = Schema.decodeUnknownSync(Git.GitRunStackedActionInput)({
      cwd: "/src/app",
      action: "create_pr",
      actionId: "act-7",
    });
    expect([input.actionId, input.action]).toEqual(["act-7", "create_pr"]);
  });

  it("return a toast written by the server, with a follow-up action", () => {
    const branch = "topic/toast";
    const result = Schema.decodeUnknownSync(Git.GitRunStackedActionResult)({
      action: "commit_push",
      pr: { status: "skipped_not_requested" },
      branch: { name: branch, status: "created" },
      commit: { subject: "fix: tidy the toast", commitSha: "0123456789abcdef", status: "created" },
      push: { status: "pushed", branch, trackingBranch: `origin/${branch}` },
      toast: {
        title: `Pushed 0123456 to origin/${branch}`,
        description: "fix: tidy the toast",
        cta: { kind: "run_action", label: "Create PR", action: { kind: "create_pr" } },
      },
    });
    const { cta } = result.toast;
    expect(cta.kind).toBe("run_action");
    expect(cta.kind === "run_action" && cta.action.kind).toBe("create_pr");
  });
});
