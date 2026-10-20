import { describe, expect, it } from "vite-plus/test";

import * as Http from "./hostHttp.ts";

const traceId = "tr-55";

// Clients drop the cause and show `message`; it has to say what went wrong.
describe("host HTTP error messages", () => {
  const cases: ReadonlyArray<readonly [string, { readonly message: string }]> = [
    [
      "invalid_command",
      new Http.HostRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
    ],
    [
      "missing_credential",
      new Http.HostAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
    ],
    [
      "terminal:operate",
      new Http.HostScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "terminal:operate",
        traceId,
      }),
    ],
    [
      "current_session_revoke_not_allowed",
      new Http.HostOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
    ],
    [
      "thread_not_found",
      new Http.HostResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
    ],
    [
      "chat_snapshot_failed",
      new Http.HostInternalError({
        code: "internal_error",
        reason: "chat_snapshot_failed",
        traceId,
      }),
    ],
  ];

  it.each(cases)("names %s", (detail, error) => {
    expect(error.message).toContain(detail);
  });
});
