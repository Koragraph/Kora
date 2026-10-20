import { AgentId, AgentProfileId, type AgentStatus } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import {
  AgentStatusBanner,
  getAgentStatusBannerKey,
  getAgentStatusMessage,
  shouldShowAgentStatusBanner,
} from "./AgentStatusBanner";

const codexWarning: AgentStatus = {
  instanceId: AgentProfileId.make("codex"),
  driver: AgentId.make("codex"),
  displayName: "Codex",
  status: "warning",
  auth: { status: "authenticated" },
  version: "1.0.0",
  installed: true,
  enabled: true,
  message: "Provider is temporarily degraded.",
  checkedAt: "2026-07-23T12:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};
const variant = (over: Partial<AgentStatus>): AgentStatus => ({ ...codexWarning, ...over });
const antigravity = (over: Partial<AgentStatus> = {}) =>
  variant({ driver: AgentId.make("antigravity"), ...over });
const signedOut = { status: "error", auth: { status: "unauthenticated" }, message: "" } as const;

describe("getAgentStatusMessage", () => {
  test("a signed-out CLI agent keeps its command-line advice", () => {
    expect(getAgentStatusMessage(variant(signedOut))).toContain("`codex login`");
  });

  test("a signed-out Antigravity points at Google sign-in, with no CLI command", () => {
    expect(getAgentStatusMessage(antigravity(signedOut))).toBe(
      "Open agent setup to sign in with Google.",
    );
  });

  test("Antigravity that is not installed must be installed before anything else", () => {
    expect(
      getAgentStatusMessage(
        antigravity({ ...signedOut, installed: false, displayName: "Google work account" }),
      ),
    ).toMatch(/^Open agent setup to install Antigravity on /);
  });

  test("the environment's own authentication error wins when there is one", () => {
    const message = "SUBSCRIPTION_REQUIRED: This Google account cannot use Antigravity.";
    expect(getAgentStatusMessage(antigravity({ ...signedOut, message }))).toBe(message);
  });
});

describe("AgentStatusBanner", () => {
  test.each(["warning", "error"] as const)(
    "a %s banner has an alert role and a named dismiss button",
    (status) => {
      const out = renderToStaticMarkup(
        <AgentStatusBanner status={variant({ status })} onDismiss={() => {}} />,
      );
      expect(out).toContain('role="alert"');
      expect(out).toContain('aria-label="Dismiss Codex notice"');
    },
  );
});

describe("shouldShowAgentStatusBanner", () => {
  test("a dismissed notice stays dismissed until its content changes", () => {
    expect(shouldShowAgentStatusBanner(codexWarning, null)).toBe(true);
    expect(shouldShowAgentStatusBanner(codexWarning, getAgentStatusBannerKey(codexWarning))).toBe(
      false,
    );
    const changed = variant({ message: "Something else is wrong." });
    expect(shouldShowAgentStatusBanner(changed, getAgentStatusBannerKey(codexWarning))).toBe(true);
  });

  test("install and start-up failures of Antigravity show before its auth is known", () => {
    const base = antigravity({ auth: { status: "unknown" } });
    expect(shouldShowAgentStatusBanner({ ...base, installed: false }, null)).toBe(true);
    expect(shouldShowAgentStatusBanner({ ...base, status: "error" }, null)).toBe(true);
  });

  test("a plain Antigravity warning with unknown auth waits for the auth check", () => {
    const waiting = antigravity({
      instanceId: AgentProfileId.make("google_work"),
      auth: { status: "unknown" },
      message: "Antigravity is installed. Google account access is not checked yet.",
    });
    expect(shouldShowAgentStatusBanner(waiting, null)).toBe(false);
    expect(
      shouldShowAgentStatusBanner(
        {
          ...waiting,
          auth: { status: "unauthenticated" },
          message: "Sign in with Google to use Antigravity.",
        },
        null,
      ),
    ).toBe(true);
  });

  test("other drivers show a warning even when auth is unknown", () => {
    expect(shouldShowAgentStatusBanner(variant({ auth: { status: "unknown" } }), null)).toBe(true);
  });
});
