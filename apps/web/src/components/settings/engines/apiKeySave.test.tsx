// An API key is stored only after it passes Test (live QA #4: a wrong key was saved first and found out later).
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/atoms/hosts", () => ({ usePrimaryHostId: () => "h", useHostHttpBaseUrl: () => null }));
vi.mock("../../onboarding/ClaudeLoginButton", () => ({ ClaudeLoginButton: () => null }));
vi.mock("../../ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("../../ui/input", () => ({ Input: (p: Record<string, unknown>) => <input {...p} /> }));
vi.mock("../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../prefs/prefsLayout", () => ({
  PrefsPageContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrefsSection: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrefsRow: ({ children, control }: { children?: React.ReactNode; control?: React.ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));
vi.mock("./enginesApi", () => ({ useEnginesApi: () => ({ view: null, run: vi.fn() }) }));

import { ApiRow } from "./EnginesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const text = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const attr = (r: ReturnType<typeof create>, a: string) =>
  r.root.findAll((n) => n.props[a] !== undefined && typeof n.type === "string");

const endpoint = {
  id: "fake-ai",
  label: "Fake AI",
  baseUrl: "https://x/v1",
  hasKey: false,
  requiresKey: true,
  status: "needs-key",
} as never;

async function setup(testOutcome: { ok: boolean; kind?: string; message?: string }) {
  const calls: string[] = [];
  const api = {
    view: null,
    run: vi.fn(async (op: { op: string }) => {
      calls.push(op.op);
      if (op.op === "api.test")
        return {
          ok: true as const,
          value: {
            test: {
              kind: testOutcome.ok ? "ok" : "rejected",
              message: testOutcome.message ?? "",
              ...testOutcome,
            },
          },
        };
      return { ok: true as const, value: {} };
    }),
  };
  let r!: ReturnType<typeof create>;
  await act(async () => {
    r = create(<ApiRow api={api as never} endpoint={endpoint} />);
  });
  await act(async () =>
    attr(r, "data-api-key")[0]!.props.onChange({ target: { value: "sk-test" } }),
  );
  return { r, calls };
}

describe("API key: test before save", () => {
  it("a key that works is tested, then saved", async () => {
    const { r, calls } = await setup({
      ok: true,
      message: "Connected. 2 models available.",
      kind: "ok",
    });
    await act(async () => attr(r, "data-api-key-save")[0]!.props.onClick());
    expect(calls).toEqual(["api.test", "api.setKey"]);
    expect(text(attr(r, "data-api-result")[0]!)).toContain("Key checked and saved");
  });

  it("a key that is rejected is NOT stored; the person can still save it anyway, marked unverified", async () => {
    const { r, calls } = await setup({
      ok: false,
      kind: "rejected",
      message: "The endpoint rejected the API key.",
    });
    await act(async () => attr(r, "data-api-key-save")[0]!.props.onClick());
    expect(calls).toEqual(["api.test"]);
    expect(text(attr(r, "data-api-result")[0]!)).toContain("not saved");
    expect(attr(r, "data-api-key-save-anyway")).toHaveLength(1);
    await act(async () => attr(r, "data-api-key-save-anyway")[0]!.props.onClick());
    expect(calls).toEqual(["api.test", "api.setKey"]);
    expect(text(attr(r, "data-api-result")[0]!)).toContain("not verified");
  });
});
