// Connected apps UI: the key field (validate -> save, never kept), the cap card, the grants editor, the Connect chip (connect ->
// allow for that blob), the not-connected card and the decision log. Fake API, react-test-renderer, no daemon.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
const openExternal = vi.fn(async () => {});
vi.mock("~/localApi", () => ({
  localApiOrThrow: () => ({ shell: { openExternal } }),
  readLocalApi: () => null,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn(), close: vi.fn() } }));
vi.mock("../../ui/toast", () => ({ toastManager: { add: vi.fn(), close: vi.fn() } }));
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
vi.mock("../../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    size: _s,
    ...rest
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    [k: string]: unknown;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...rest}
    />
  ),
}));
vi.mock("../../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    [k: string]: unknown;
  }) => (
    <button
      role="checkbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...rest}
    />
  ),
}));
vi.mock("../../ui/spinner", () => ({ Spinner: () => <span data-spinner /> }));
vi.mock("../../ui/dialog", () => {
  const P = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div data-dialog>{children}</div> : null,
    DialogPopup: P,
    DialogHeader: P,
    DialogTitle: P,
    DialogDescription: P,
    DialogPanel: P,
    DialogFooter: P,
  };
});
const blobsState = { blobs: [] as Array<Record<string, unknown>> };
const updateBlob = vi.fn(async (_id: string, patch: { toolGrants: unknown }) => ({
  ok: true as const,
  value: { ...blobsState.blobs[0]!, toolGrants: patch.toolGrants },
}));
vi.mock("../shell/blobsApi", () => ({
  useBlobsApi: () => ({ update: updateBlob }),
  useBlobsState: () => ({ hostId: "h", snapshot: { blobs: blobsState.blobs }, error: null }),
}));
vi.mock("../chat/blobSkin", () => ({
  useBlobSkin: () => ({ blobId: "b1", name: "Popo", title: "", outfit: {}, chief: false }),
}));

import { AppConnectCard } from "./AppConnectCard";
import { AppGrantsEditor } from "./AppGrantsEditor";
import { ByoKeyField } from "./ByoKeyField";
import { CapCard, UsageMeter } from "./CapCard";
import { ConnectChip } from "./ConnectChip";
import { DecisionLog } from "./DecisionLog";
import { AppsApiProvider, UNAVAILABLE_APPS_API, type AppsApi, type AppsStatus } from "./appsApi";
import { refreshAppsBrief, resetAppsBrief } from "./appsBrief";
import type { AppGrants } from "./appsModel";

function text(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c) => text(c as ReactTestInstance | string)).join("");
}
const byData = (r: ReactTestRenderer, attr: string) =>
  r.root.findAll((n) => typeof n.type === "string" && n.props[attr] !== undefined);
const click = async (n: ReactTestInstance) => {
  await act(async () => {
    n.props.onClick({ preventDefault() {} });
  });
};
async function render(ui: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(ui);
  });
  return r;
}
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

const status = (over: Partial<AppsStatus> = {}): AppsStatus => ({
  mode: "broker",
  byoKeySet: false,
  brokerConfigured: true,
  secretStore: "keychain",
  usage: {
    mode: "broker",
    used: 312,
    limit: 750,
    month: "2026-10",
    resetsAt: Date.UTC(2026, 10, 1),
    capReached: false,
  },
  error: null,
  errorCode: null,
  ...over,
});
const ok = <T,>(value: T) => ({ ok: true as const, value });
const api = (over: Partial<AppsApi> = {}): AppsApi => ({
  ...UNAVAILABLE_APPS_API,
  status: async () => ok(status()),
  accounts: async () => ok([]),
  ...over,
});
const wrap = (a: AppsApi, ui: React.ReactElement) => (
  <AppsApiProvider api={a}>{ui}</AppsApiProvider>
);

beforeEach(() => {
  navigate.mockReset();
  openExternal.mockClear();
  updateBlob.mockClear();
  resetAppsBrief();
  blobsState.blobs = [
    {
      id: "b1",
      name: "Popo",
      toolGrants: {
        apps: { mode: "none", allow: [] },
        mcp: [],
        computer: { browser: false, vm: false },
      },
    },
  ];
});

describe("ByoKeyField", () => {
  it("saves a valid key, never keeps it, and shows the no-limit state", async () => {
    const setKey = vi.fn(async (_k: string) => ok(status({ mode: "byo", byoKeySet: true })));
    const seen: AppsStatus[] = [];
    const r = await render(
      wrap(api({ setKey }), <ByoKeyField status={status()} onStatus={(s) => seen.push(s)} />),
    );
    const input = byData(r, "data-byo-input")[0]!;
    await act(async () => input.props.onChange({ target: { value: "ak_my_key_123" } }));
    await act(async () => byData(r, "data-byo-save")[0]!.props.onClick?.({ preventDefault() {} }));
    await act(async () => r.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(setKey).toHaveBeenCalledWith("ak_my_key_123");
    expect(seen.at(-1)!.byoKeySet).toBe(true);
    expect(input.props.value).toBe(""); // not kept in the field once saved
  });

  it("a wrong key keeps the old setup and says why (the daemon's own words)", async () => {
    const setKey = vi.fn(async () => ({
      ok: false as const,
      message: "Composio did not accept that key.",
      code: "bad_key",
    }));
    const seen: AppsStatus[] = [];
    const r = await render(
      wrap(api({ setKey }), <ByoKeyField status={status()} onStatus={(s) => seen.push(s)} />),
    );
    await act(async () =>
      byData(r, "data-byo-input")[0]!.props.onChange({ target: { value: "ak_typo" } }),
    );
    await act(async () => r.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(text(byData(r, "data-byo-error")[0]!)).toContain("Composio did not accept that key.");
    expect(seen).toEqual([]);
  });

  it("with a key set: says so and offers Remove", async () => {
    const clearKey = vi.fn(async () => ok(status()));
    const seen: AppsStatus[] = [];
    const r = await render(
      wrap(
        api({ clearKey }),
        <ByoKeyField
          status={status({ mode: "byo", byoKeySet: true })}
          onStatus={(s) => seen.push(s)}
        />,
      ),
    );
    expect(text(byData(r, "data-byo-state")[0]!)).toContain("Using your Composio key");
    await click(byData(r, "data-byo-clear")[0]!);
    expect(clearKey).toHaveBeenCalled();
    expect(seen.at(-1)!.byoKeySet).toBe(false);
  });
});

describe("cap card and meter", () => {
  it("meter: x of 750, resets date, near-the-end tone", async () => {
    const r = await render(<UsageMeter status={status()} />);
    expect(text(r.root)).toContain("312 of 750 free app calls used this month");
    expect(text(r.root)).toContain("Resets November 1");
    const near = await render(
      <UsageMeter
        status={status({
          usage: {
            mode: "broker",
            used: 700,
            limit: 750,
            month: "m",
            resetsAt: null,
            capReached: false,
          },
        })}
      />,
    );
    expect(byData(near, "data-usage")[0]!.props["data-usage"]).toBe("near");
  });
  it("the cap card is plain: used up, Kora Pro is coming, paste your own key", async () => {
    const onPasteKey = vi.fn();
    const capped = status({
      usage: {
        mode: "broker",
        used: 750,
        limit: 750,
        month: "2026-10",
        resetsAt: Date.UTC(2026, 10, 1),
        capReached: true,
      },
    });
    const r = await render(<CapCard status={capped} onPasteKey={onPasteKey} />);
    const t = text(r.root);
    expect(t).toContain("Free app calls used up for this month");
    expect(t).toContain("Kora Pro is coming");
    expect(t).toContain("November 1");
    await click(byData(r, "data-cap-byo")[0]!);
    expect(onPasteKey).toHaveBeenCalled();
  });
  it("on your own key the meter says no limit, never a number", async () => {
    const r = await render(
      <UsageMeter
        status={status({
          mode: "byo",
          byoKeySet: true,
          usage: {
            mode: "byo",
            used: 4000,
            limit: null,
            month: "m",
            resetsAt: null,
            capReached: false,
          },
        })}
      />,
    );
    expect(text(r.root)).toContain("No limit");
    expect(text(r.root)).not.toContain("4,000");
  });
});

describe("AppGrantsEditor", () => {
  const tools = [
    {
      slug: "GMAIL_FETCH_EMAILS",
      name: "Fetch emails",
      description: "",
      toolkit: "gmail",
      readOnly: true,
      outbound: false,
    },
    {
      slug: "GMAIL_SEND_EMAIL",
      name: "Send email",
      description: "",
      toolkit: "gmail",
      readOnly: null,
      outbound: true,
    },
  ];
  const connected = api({
    accounts: async () =>
      ok([
        { id: "a1", toolkit: "gmail", alias: null, status: "ACTIVE" },
        { id: "a2", toolkit: "slack", alias: "ops", status: "ACTIVE" },
      ]),
    tools: async () => ok(tools),
  });

  async function editor(grants: AppGrants, a: AppsApi = connected) {
    const seen: AppGrants[] = [];
    const ui = (g: AppGrants) =>
      wrap(a, <AppGrantsEditor blobName="Popo" grants={g} onChange={(n) => seen.push(n)} />);
    const r = await render(ui(grants));
    await act(async () => {
      await refreshAppsBrief(a);
    });
    await flush();
    return { r, seen, rerender: async (g: AppGrants) => act(async () => r.update(ui(g))) };
  }

  it("None is the default and says so; the three modes are radios", async () => {
    const { r } = await editor({ mode: "none", allow: [] });
    const radios = r.root.findAll(
      (n) => n.props["data-grant-mode"] !== undefined && n.props.role === "radio",
    );
    expect(radios.map((n) => n.props["data-grant-mode"])).toEqual(["none", "all", "list"]);
    expect(radios.find((n) => n.props["aria-checked"])!.props["data-grant-mode"]).toBe("none");
    expect(text(radios[0]!)).toContain("default");
    expect(byData(r, "data-grant-app")).toHaveLength(0);
  });

  it("Choose lists only connected apps; the app switch grants the whole app; picking all -> choose keeps what it had", async () => {
    const { r, seen } = await editor({ mode: "list", allow: [] });
    expect(byData(r, "data-grant-app").map((n) => n.props["data-grant-app"])).toEqual([
      "gmail",
      "slack",
    ]);
    await click(
      byData(r, "data-grant-whole").find((n) => n.props["data-grant-whole"] === "gmail")!,
    );
    expect(seen.at(-1)).toEqual({ mode: "list", allow: ["toolkit:gmail"] });
    await click(r.root.findAll((n) => n.props["data-grant-mode"] === "all")[0]!);
    expect(seen.at(-1)).toEqual({ mode: "all", allow: [] });
  });

  it("from All to Choose, every connected app stays allowed as a whole (narrowing starts from what it had)", async () => {
    const { r, seen } = await editor({ mode: "all", allow: [] });
    await click(r.root.findAll((n) => n.props["data-grant-mode"] === "list")[0]!);
    expect(seen.at(-1)).toEqual({ mode: "list", allow: ["toolkit:gmail", "toolkit:slack"] });
  });

  it("an app's tools load on expand, 'asks you first' is its own group, ticking one tool grants just that tool", async () => {
    const { r, seen } = await editor({ mode: "list", allow: [] });
    const toggle = r.root.findAll(
      (n) =>
        n.props["aria-expanded"] !== undefined &&
        /Show Gmail actions/.test(String(n.props["aria-label"])),
    )[0]!;
    await click(toggle);
    await flush();
    const panel = byData(r, "data-grant-tools")[0]!;
    expect(text(panel)).toContain("Reading and drafting");
    expect(text(panel)).toContain("Asks you first");
    await click(
      byData(r, "data-grant-tool").find(
        (n) => n.props["data-grant-tool"] === "GMAIL_FETCH_EMAILS",
      )!,
    );
    expect(seen.at(-1)).toEqual({ mode: "list", allow: ["GMAIL_FETCH_EMAILS"] });
  });

  it("not set up: says so with the way in, never an empty broken editor", async () => {
    const off = api({
      status: async () => ok(status({ mode: "unavailable", brokerConfigured: false, usage: null })),
    });
    const { r } = await editor({ mode: "none", allow: [] }, off);
    expect(byData(r, "data-grants-not-set-up")).toHaveLength(1);
  });
});

describe("ConnectChip", () => {
  it("not connected: Connect X; tap runs the connect flow and, inside a blob, allows the app for that blob when it lands", async () => {
    let linked = false;
    let polls = 0;
    const a = api({
      // nothing is connected until the link was handed out and the sign-in "finished" (the second poll after it)
      accounts: async () =>
        ok(
          linked && ++polls >= 2
            ? [{ id: "a1", toolkit: "gmail", alias: null, status: "ACTIVE" }]
            : [],
        ),
      connect: async () => {
        linked = true;
        return ok({ url: "https://connect.composio.dev/gmail", expiresAt: Date.now() + 600_000 });
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const r = await render(
      wrap(a, <ConnectChip app="gmail" label="Gmail" blobId="b1" blobName="Popo" />),
    );
    await act(async () => {
      await refreshAppsBrief(a);
    });
    expect(byData(r, "data-connect-chip")[0]!.props["data-chip-state"]).toBe("connect");
    await click(byData(r, "data-connect-chip")[0]!);
    expect(openExternal).toHaveBeenCalledWith("https://connect.composio.dev/gmail");
    expect(byData(r, "data-connect-link")[0]!.props.href).toBe(
      "https://connect.composio.dev/gmail",
    ); // the visible fallback
    for (let i = 0; i < 4; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
    expect(updateBlob).toHaveBeenCalledTimes(1);
    expect(updateBlob.mock.calls[0]![1].toolGrants).toMatchObject({
      apps: { mode: "list", allow: ["toolkit:gmail"] },
    });
    vi.useRealTimers();
  });

  it("connected but not allowed for this blob: an Allow chip, one tap, only that app", async () => {
    const a = api({
      accounts: async () => ok([{ id: "a1", toolkit: "gmail", alias: null, status: "ACTIVE" }]),
    });
    const r = await render(
      wrap(a, <ConnectChip app="gmail" label="Gmail" blobId="b1" blobName="Popo" />),
    );
    await act(async () => {
      await refreshAppsBrief(a);
    });
    const chip = byData(r, "data-connect-chip")[0]!;
    expect(chip.props["data-chip-state"]).toBe("allow");
    expect(text(chip)).toContain("Allow Gmail for Popo");
    await click(chip);
    expect(updateBlob.mock.calls[0]![1].toolGrants).toMatchObject({
      apps: { mode: "list", allow: ["toolkit:gmail"] },
    });
  });

  it("connected (and allowed or not blob-bound): a quiet 'connected' chip", async () => {
    const a = api({
      accounts: async () => ok([{ id: "a1", toolkit: "gmail", alias: null, status: "ACTIVE" }]),
    });
    const r = await render(wrap(a, <ConnectChip app="Gmail" />));
    await act(async () => {
      await refreshAppsBrief(a);
    });
    expect(text(byData(r, "data-connect-chip")[0]!)).toContain("Gmail connected");
  });

  it("apps not set up: the chip says so and leads to the Apps page instead of failing", async () => {
    const a = api({
      status: async () => ok(status({ mode: "unavailable", brokerConfigured: false, usage: null })),
    });
    const r = await render(wrap(a, <ConnectChip app="gmail" label="Gmail" />));
    await act(async () => {
      await refreshAppsBrief(a);
    });
    const chip = byData(r, "data-connect-chip")[0]!;
    expect(chip.props["data-chip-state"]).toBe("not-set-up");
    await click(chip);
    expect(navigate).toHaveBeenCalledWith({ to: "/apps" });
  });
});

describe("AppConnectCard", () => {
  it("names the blob and the app, and carries the chip for that blob", async () => {
    const a = api();
    const r = await render(
      wrap(a, <AppConnectCard toolkit="slack" reason="not_connected" blobId="b1" />),
    );
    await act(async () => {
      await refreshAppsBrief(a);
    });
    expect(text(byData(r, "data-app-connect-card")[0]!)).toContain(
      "Popo wanted to use Slack, but it isn’t connected yet.",
    );
    expect(byData(r, "data-connect-chip")[0]!.props["data-connect-chip"]).toBe("slack");
    const denied = await render(
      wrap(a, <AppConnectCard toolkit="gmail" reason="not_granted" blobId="b1" />),
    );
    expect(text(byData(denied, "data-app-connect-card")[0]!)).toContain(
      "isn’t allowed to use Gmail",
    );
  });
});

describe("DecisionLog", () => {
  const rows = [
    {
      at: Date.UTC(2026, 9, 9, 10, 5),
      kind: "decision" as const,
      blobId: "b1",
      threadId: "t",
      tool: "GMAIL_SEND_EMAIL",
      toolkit: "gmail",
      account: "work",
      decision: "deny" as const,
      reason: "user_denied",
      outbound: true,
      outcome: null,
    },
    {
      at: Date.UTC(2026, 9, 9, 10, 1),
      kind: "decision" as const,
      blobId: "b1",
      threadId: "t",
      tool: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
      account: null,
      decision: "allow" as const,
      reason: "granted",
      outbound: false,
      outcome: null,
    },
    {
      at: Date.UTC(2026, 9, 9, 10, 1),
      kind: "result" as const,
      blobId: "b1",
      threadId: "t",
      tool: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
      account: null,
      decision: "allow" as const,
      reason: "granted",
      outbound: false,
      outcome: "ok",
    },
  ];
  it("one row per decision, in words, with the reason; result rows do not repeat", async () => {
    const r = await render(
      wrap(
        api({ decisions: async () => ok(rows) }),
        <DecisionLog blobId="b1" now={Date.UTC(2026, 9, 9, 12)} />,
      ),
    );
    await flush();
    const items = byData(r, "data-decision");
    expect(items).toHaveLength(2);
    expect(text(items[0]!)).toContain("Send email on Gmail (work)");
    expect(text(items[0]!)).toContain("You said no");
    expect(text(items[0]!)).toContain("sends or changes something");
    expect(text(items[1]!)).toContain("Fetch emails on Gmail");
    expect(items[0]!.props["data-decision"]).toBe("deny");
  });
  it("empty and error states are sentences", async () => {
    const empty = await render(
      wrap(api({ decisions: async () => ok([]) }), <DecisionLog blobId="b1" />),
    );
    await flush();
    expect(byData(empty, "data-decisions-empty")).toHaveLength(1);
    const bad = await render(
      wrap(
        api({
          decisions: async () => ({
            ok: false,
            message: "Could not load the activity.",
            code: null,
          }),
        }),
        <DecisionLog blobId="b1" />,
      ),
    );
    await flush();
    expect(text(byData(bad, "data-decisions-error")[0]!)).toContain("Could not load the activity.");
  });
});
