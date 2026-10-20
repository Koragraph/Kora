// Settings > Outside access: create (token shown once), snippets fill in, revoke, the activity log and its paging.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const toastAdd = vi.fn();
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...a: unknown[]) => toastAdd(...a), close: vi.fn() },
}));
vi.mock("../../ui/button", () => ({
  Button: ({
    children,
    variant: _v,
    size: _s,
    ...rest
  }: {
    children?: React.ReactNode;
    [k: string]: unknown;
  }) => <button {...rest}>{children}</button>,
}));
vi.mock("../../ui/input", () => ({
  Input: ({ nativeInput: _n, size: _s, ...rest }: { [k: string]: unknown }) => <input {...rest} />,
}));
vi.mock("../../prefs/prefsLayout", () => ({
  PrefsPageContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrefsSection: ({
    children,
    title,
    headerAction,
    ...rest
  }: {
    children?: React.ReactNode;
    title: string;
    headerAction?: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <section {...rest}>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  PrefsRow: ({
    children,
    title,
    description,
  }: {
    children?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  ),
}));

import { OutsideAccessSettings } from "./OutsideAccessSettings";
import {
  OutsideApiProvider,
  type OutsideApi,
  type OutsideAuditWire,
  type OutsideTokenWire,
} from "./outsideApi";

const NOW = Date.UTC(2026, 9, 12, 15, 0);
const tok = (id: string, name: string, over: Partial<OutsideTokenWire> = {}): OutsideTokenWire => ({
  id,
  name,
  createdAt: NOW - 86_400_000,
  lastUsedAt: null,
  revokedAt: null,
  suffix: "a1b2",
  ...over,
});
const row = (i: number, over: Partial<OutsideAuditWire> = {}): OutsideAuditWire => ({
  id: `r${i}`,
  at: NOW - i * 1000,
  tokenId: "t1",
  client: "Claude Desktop",
  tool: "list_blobs",
  target: null,
  ok: true,
  note: null,
  ...over,
});

function text(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c) => text(c as ReactTestInstance | string)).join("");
}
const byAttr = (r: ReactTestRenderer, attr: string) =>
  r.root.findAll((n) => typeof n.type === "string" && n.props[attr] !== undefined);
const one = (r: ReactTestRenderer, attr: string) => byAttr(r, attr)[0]!;

async function render(api: OutsideApi): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <OutsideApiProvider api={api}>
        <OutsideAccessSettings pollMs={0} now={() => NOW} />
      </OutsideApiProvider>,
    );
  });
  return r;
}

function fakeApi(over: Partial<OutsideApi> = {}) {
  let tokens: OutsideTokenWire[] = [
    tok("t1", "Claude Desktop", { lastUsedAt: NOW - 120_000 }),
    tok("t0", "Old laptop", { revokedAt: NOW - 3_600_000 }),
  ];
  const api: OutsideApi = {
    setup: async () => ({
      ok: true,
      value: {
        command: "/Users/me/.local/bin/kora",
        args: ["mcp", "--team"],
        serverName: "kora-team",
        limits: { callsPerMinute: 60, sendsPerMinute: 12 },
      },
    }),
    tokens: async () => ({ ok: true, value: tokens }),
    create: async (name) => {
      if (tokens.some((t) => t.revokedAt === null && t.name.toLowerCase() === name.toLowerCase()))
        return { ok: false, message: `A token named "${name}" already exists.` };
      const t = tok(`t${tokens.length + 5}`, name, { suffix: "zz99" });
      tokens = [t, ...tokens];
      return { ok: true, value: { token: t, secret: "kbo_SECRETSECRETSECRET_zz99" } };
    },
    revoke: async (id) => {
      tokens = tokens.map((t) => (t.id === id ? { ...t, revokedAt: NOW } : t));
      return { ok: true, value: true };
    },
    audit: async (before) =>
      before === null
        ? {
            ok: true,
            value: {
              rows: [
                row(1, { tool: "send_message", target: "Popo" }),
                row(2, { ok: false, tool: "list_blobs", note: "revoked token" }),
              ],
              next: NOW - 2000,
            },
          }
        : { ok: true, value: { rows: [row(3)], next: null } },
    ...over,
  };
  return api;
}

describe("Outside access page", () => {
  it("lists active tokens (with last use) and revoked ones separately", async () => {
    const r = await render(fakeApi());
    expect(text(one(r, "data-token"))).toContain("Claude Desktop");
    expect(text(one(r, "data-token"))).toContain("Used 2 min ago");
    expect(text(one(r, "data-token"))).toContain("kbo_...a1b2");
    expect(text(one(r, "data-token-revoked"))).toContain("Old laptop");
  });

  it("create shows the token once, fills the snippet, then discards it", async () => {
    const r = await render(fakeApi());
    expect(text(one(r, "data-snippet"))).toContain("PASTE_YOUR_TOKEN_HERE");
    await act(async () => {
      one(r, "data-token-name").props.onChange({ target: { value: "Cursor" } });
    });
    await act(async () => {
      await one(r, "data-token-create").props.onClick?.();
      r.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(text(one(r, "data-token-value"))).toBe("kbo_SECRETSECRETSECRET_zz99");
    expect(text(one(r, "data-snippet"))).toContain("kbo_SECRETSECRETSECRET_zz99");
    expect(
      JSON.parse(text(one(r, "data-snippet"))).mcpServers["kora-team"].env.KORA_TEAM_TOKEN,
    ).toBe("kbo_SECRETSECRET" + "SECRET_zz99");
    await act(async () => {
      one(r, "data-token-done").props.onClick();
    });
    expect(byAttr(r, "data-token-reveal")).toHaveLength(0);
    expect(text(one(r, "data-snippet"))).not.toContain("SECRETSECRET");
    expect(JSON.stringify(r.toJSON())).not.toContain("kbo_SECRETSECRET");
  });

  it("refuses an empty or duplicate name with the reason", async () => {
    const r = await render(fakeApi());
    await act(async () => {
      r.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(text(one(r, "data-token-error"))).toMatch(/Give this client a name/);
    await act(async () => {
      one(r, "data-token-name").props.onChange({ target: { value: "claude desktop" } });
    });
    await act(async () => {
      r.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(text(one(r, "data-token-error"))).toMatch(/already exists/);
    expect(byAttr(r, "data-token-reveal")).toHaveLength(0);
  });

  it("revoke needs a second click, then moves the token to revoked", async () => {
    const api = fakeApi();
    const spy = vi.spyOn(api, "revoke");
    const r = await render(api);
    await act(async () => {
      one(r, "data-revoke").props.onClick();
    });
    expect(spy).not.toHaveBeenCalled();
    await act(async () => {
      await one(r, "data-revoke-confirm").props.onClick();
    });
    expect(spy).toHaveBeenCalledWith("t1");
    expect(byAttr(r, "data-token")).toHaveLength(0);
    expect(byAttr(r, "data-token-revoked")).toHaveLength(2);
    expect(byAttr(r, "data-token-empty")).toHaveLength(1);
  });

  it("each client tab shows its own config", async () => {
    const r = await render(fakeApi());
    for (const [kind, needle] of [
      ["cursor", '"mcpServers"'],
      ["claude-code", "claude mcp add kora-team"],
      ["codex", "[mcp_servers.kora-team]"],
      ["claude-desktop", '"command"'],
    ] as const) {
      await act(async () => {
        byAttr(r, "data-client-tab")
          .find((n) => n.props["data-client-tab"] === kind)!
          .props.onClick();
      });
      expect(text(one(r, "data-snippet"))).toContain(needle);
    }
  });

  it("activity shows who did what, marks refusals, and pages", async () => {
    const r = await render(fakeApi());
    const rows = byAttr(r, "data-audit-row");
    expect(rows).toHaveLength(2);
    expect(text(rows[0]!)).toContain("Sent a message");
    expect(text(rows[0]!)).toContain("Popo");
    expect(text(rows[0]!)).toContain("Claude Desktop");
    expect(text(rows[1]!)).toContain("Token revoked");
    expect(rows[1]!.props["data-audit-ok"]).toBe(false);
    await act(async () => {
      await one(r, "data-audit-more").props.onClick();
    });
    expect(byAttr(r, "data-audit-row")).toHaveLength(3);
    expect(byAttr(r, "data-audit-more")).toHaveLength(0);
  });

  it("empty states and an unconnected daemon are explained, not blank", async () => {
    const r = await render(
      fakeApi({
        tokens: async () => ({ ok: true, value: [] }),
        audit: async () => ({ ok: true, value: { rows: [], next: null } }),
      }),
    );
    expect(byAttr(r, "data-token-empty")).toHaveLength(1);
    expect(byAttr(r, "data-audit-empty")).toHaveLength(1);
    const bad = await render(
      fakeApi({
        tokens: async () => ({ ok: false, message: "Outside access is not connected yet." }),
      }),
    );
    // One miss is not a verdict (the daemon link may still be coming up): the error shows after the 2 s retry misses too.
    expect(text(bad.root)).not.toContain("not connected yet");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
    });
    expect(text(bad.root)).toContain("not connected yet");
  });
});
