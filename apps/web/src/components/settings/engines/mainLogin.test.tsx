// "Your main login" says whether it is signed in and how to sign in (live QA #4: a row with prose and no state).
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/atoms/hosts", () => ({
  usePrimaryHostId: () => "h",
  useHostHttpBaseUrl: () => "http://127.0.0.1:1",
}));
vi.mock("../../onboarding/ClaudeLoginButton", () => ({
  ClaudeLoginButton: () => <i data-login-button />,
}));
vi.mock("../../ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("../../ui/input", () => ({ Input: () => null }));
vi.mock("../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../prefs/prefsLayout", () => ({
  PrefsPageContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrefsSection: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrefsRow: ({
    title,
    description,
    control,
    children,
    ...rest
  }: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    control?: React.ReactNode;
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <div {...rest}>
      <h4>{title}</h4>
      <p data-description>{description}</p>
      {control}
      {children}
    </div>
  ),
}));
vi.mock("./enginesApi", () => ({ useEnginesApi: () => ({ view: null, run: vi.fn() }) }));

import { MainLoginRow } from "./EnginesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const text = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === "string" ? c : text(c))).join("");

const mount = async (check: unknown) => {
  let r!: ReturnType<typeof create>;
  await act(async () => {
    r = create(<MainLoginRow checkFor={async () => check as never} />);
  });
  return r;
};

describe("Your main login", () => {
  it("signed in: says so with the detail, no sign-in command", async () => {
    const r = await mount({
      id: "claude-auth",
      status: "ok",
      detail: "Signed in via claude.ai, Max plan",
      label: "Claude login",
      fix: null,
    });
    const row = r.root.findAll((n) => n.props["data-main-login"] !== undefined)[0]!;
    expect(row.props["data-main-login"]).toBe("signed-in");
    expect(text(r.root.findAll((n) => n.props["data-description"] !== undefined)[0]!)).toContain(
      "Signed in via claude.ai",
    );
    expect(r.root.findAll((n) => n.props["data-main-login-signin"] !== undefined)).toHaveLength(0);
  });

  it("signed out: says so and gives the in-app button (when the daemon can run it) and the Terminal command", async () => {
    const r = await mount({
      id: "claude-auth",
      status: "fail",
      detail: "Claude Code is not logged in.",
      label: "Claude login",
      fix: null,
      data: { login: "bundled" },
    });
    expect(
      r.root.findAll((n) => n.props["data-main-login"] !== undefined)[0]!.props["data-main-login"],
    ).toBe("signed-out");
    expect(text(r.root.findAll((n) => n.props["data-description"] !== undefined)[0]!)).toContain(
      "Not signed in",
    );
    expect(r.root.findAll((n) => n.props["data-login-button"] !== undefined)).toHaveLength(1);
    expect(text(r.root.findAll((n) => n.props["data-sign-in-command"] !== undefined)[0]!)).toBe(
      "claude auth login",
    );
  });

  it("when the check cannot be read it says so instead of pretending", async () => {
    const r = await mount(null);
    expect(
      r.root.findAll((n) => n.props["data-main-login"] !== undefined)[0]!.props["data-main-login"],
    ).toBe("unknown");
    expect(text(r.root.findAll((n) => n.props["data-description"] !== undefined)[0]!)).toContain(
      "could not check",
    );
  });
});
