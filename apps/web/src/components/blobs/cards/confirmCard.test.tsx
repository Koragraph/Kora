import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));

import type { BlobCardRef } from "../../../thread/timeline";
import { ConfirmCard, type ConfirmActions } from "./ConfirmCard";
import { parseConfirm } from "./confirmModel";
import { parseBlobCard } from "./parseCard";

const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const byAttr = (root: ReactTestInstance, attr: string) =>
  root.findAll((n) => typeof n.type === "string" && attr in n.props);

const card = (version: number, over: Record<string, unknown> = {}): BlobCardRef => ({
  cardId: "conf_1",
  version,
  payload: {
    cardKind: "confirm",
    cardId: "conf_1",
    version,
    action: "edit",
    blobId: "blob_popo",
    blobName: "Popo",
    summary: "Update Popo",
    details: ["Title: Researcher -> Lead", "Soul rewritten (240 characters)"],
    state: "open",
    result: null,
    ...over,
  },
});

const actions = (over: Partial<ConfirmActions> = {}): ConfirmActions => ({
  resolve: vi.fn(async () => ({
    ok: true as const,
    value: { ok: true, message: "Popo updated." },
  })),
  ...over,
});

describe("confirm card", () => {
  it("parses defensively; an empty summary is unknown", () => {
    expect(parseConfirm(card(1))).toMatchObject({
      action: "edit",
      state: "open",
      details: expect.any(Array),
    });
    expect(parseConfirm(card(1, { summary: "  " }))).toBeNull();
    expect(parseConfirm({ cardId: "x", version: 1, payload: { cardKind: "job" } })).toBeNull();
    expect(parseConfirm(card(1, { state: "weird", action: "weird" }))).toMatchObject({
      state: "open",
      action: "edit",
    });
    expect(parseBlobCard(card(1))).toEqual({ kind: "confirm", summary: "Update Popo" });
    expect(parseBlobCard(card(1, { summary: "" })).kind).toBe("unknown");
  });

  it("shows what will change, the details and Confirm / Not now while open", async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ConfirmCard card={card(1)} actions={actions()} />);
    });
    const t = text(r.root);
    expect(t).toContain("Update Popo");
    expect(t).toContain("Title: Researcher -> Lead");
    expect(t).toContain("Soul rewritten");
    expect(byAttr(r.root, "data-confirm-yes")).toHaveLength(1);
    expect(byAttr(r.root, "data-confirm-no")).toHaveLength(1);
  });

  it("Confirm resolves with accept=true, then collapses to a quiet receipt with the result", async () => {
    const a = actions();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ConfirmCard card={card(1)} actions={a} />);
    });
    await act(async () => {
      await byAttr(r.root, "data-confirm-yes")[0]!.props.onClick();
    });
    expect(a.resolve).toHaveBeenCalledWith("conf_1", true);
    expect(byAttr(r.root, "data-confirm-yes")).toHaveLength(0);
    expect(text(r.root)).toContain("Done");
    expect(text(r.root)).toContain("Popo updated.");
  });

  it("Not now resolves with accept=false", async () => {
    const a = actions({
      resolve: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true, message: "Not done." },
      })),
    });
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ConfirmCard card={card(1)} actions={a} />);
    });
    await act(async () => {
      await byAttr(r.root, "data-confirm-no")[0]!.props.onClick();
    });
    expect(a.resolve).toHaveBeenCalledWith("conf_1", false);
    expect(text(r.root)).toContain("Not done");
  });

  it("a failed RPC keeps the card open and says why; a failed action shows 'Did not work'", async () => {
    const fail = actions({
      resolve: vi.fn(async () => ({ ok: false as const, message: "Kora is not connected." })),
    });
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ConfirmCard card={card(1)} actions={fail} />);
    });
    await act(async () => {
      await byAttr(r.root, "data-confirm-yes")[0]!.props.onClick();
    });
    expect(byAttr(r.root, "data-confirm-yes")).toHaveLength(1);
    expect(text(r.root)).toContain("Kora is not connected.");
    const bad = actions({
      resolve: vi.fn(async () => ({
        ok: true as const,
        value: { ok: false, message: "That blob no longer exists." },
      })),
    });
    await act(async () => {
      r = create(<ConfirmCard card={card(1)} actions={bad} />);
    });
    await act(async () => {
      await byAttr(r.root, "data-confirm-yes")[0]!.props.onClick();
    });
    expect(text(r.root)).toContain("Did not work");
  });

  it("latest version wins: a resolved card is never reopened by an older frame; retire says Retire", async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <ConfirmCard
          card={card(2, { state: "confirmed", result: "Popo updated." })}
          actions={actions()}
        />,
      );
    });
    expect(byAttr(r.root, "data-confirm-yes")).toHaveLength(0);
    await act(async () => r.update(<ConfirmCard card={card(1)} actions={actions()} />));
    expect(byAttr(r.root, "data-confirm-yes")).toHaveLength(0);
    expect(text(r.root)).toContain("Popo updated.");
    await act(async () => {
      r = create(
        <ConfirmCard
          card={card(1, { action: "retire", summary: "Retire Popo" })}
          actions={actions()}
        />,
      );
    });
    expect(text(byAttr(r.root, "data-confirm-yes")[0]!)).toBe("Retire");
  });
});
