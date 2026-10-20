// The blob approval card: what it shows (the FULL command, the folder, the file, the app action), the three answers, the
// composer being someone else's business, and how a finished / stale request folds into one quiet line.
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BlobCardRef } from "../../../thread/timeline";

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../chat/blobSkin", () => ({
  useBlobSkin: () => ({ blobId: "b", name: "Popo", title: "Researcher", chief: false, outfit: {} }),
}));

import { ApprovalCard, BlobApprovalProvider, type BlobApprovalApi } from "./ApprovalCard";
import { outcomeLine, parseApproval, tildePath } from "./approvalModel";

const card = (payload: Record<string, unknown>): BlobCardRef => ({
  cardId: "approval:r1",
  version: 1,
  payload: { cardKind: "approval", requestId: "r1", state: "open", ...payload },
});
const OPTIONS = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptAlways", label: "Always for this blob" },
  { decision: "decline", label: "Deny" },
];
const command = (over: Record<string, unknown> = {}) =>
  card({
    requestKind: "command",
    toolName: "Bash",
    title: "Allow Bash?",
    args: { command: "cd ~/Documents && sleep 40 && echo done > scratch/pine.txt" },
    cwd: "/Users/me/Blobs/Popo",
    alwaysLabel: "Run sleep",
    options: OPTIONS,
    ...over,
  });

const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const buttonsOf = (root: ReactTestInstance) => root.findAll((n) => n.type === "button");
const action = (root: ReactTestInstance, decision: string) =>
  root.findAll((n) => n.props["data-approval-action"] === decision)[0];

function render(c: BlobCardRef, api: BlobApprovalApi | null) {
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(
      <BlobApprovalProvider value={api}>
        <ApprovalCard card={c} />
      </BlobApprovalProvider>,
    );
  });
  return r;
}
const api = (over: Partial<BlobApprovalApi> = {}): BlobApprovalApi => ({
  respond: vi.fn(async () => ({})),
  responding: [],
  live: true,
  ...over,
});

describe("parseApproval", () => {
  it("a shell command: heading, the whole command, the folder it runs in, and what Always would remember", () => {
    const v = parseApproval(command())!;
    expect(v).toMatchObject({
      kind: "command",
      heading: "Run a command",
      body: "cd ~/Documents && sleep 40 && echo done > scratch/pine.txt",
      cwd: "/Users/me/Blobs/Popo",
      alwaysLabel: "Run sleep",
      state: "open",
    });
  });
  it("a file edit / read and a web page name their target; an app action names the app and the summary", () => {
    expect(
      parseApproval(
        card({
          requestKind: "file-change",
          toolName: "Edit",
          args: { file_path: "/Users/me/Taxes/a.xlsx" },
          options: OPTIONS,
          alwaysLabel: "Files in ~/Taxes",
        }),
      ),
    ).toMatchObject({
      kind: "file-change",
      heading: "Edit a file",
      target: "/Users/me/Taxes/a.xlsx",
    });
    expect(
      parseApproval(
        card({
          requestKind: "file-read",
          toolName: "Read",
          args: { file_path: "/Users/me/x.txt" },
        }),
      ),
    ).toMatchObject({ kind: "file-read", heading: "Read a file", target: "/Users/me/x.txt" });
    expect(
      parseApproval(
        card({
          requestKind: "command",
          toolName: "WebFetch",
          args: { url: "https://example.com/p" },
        }),
      ),
    ).toMatchObject({ kind: "fetch", heading: "Open a web page", target: "https://example.com/p" });
    const app = parseApproval(
      card({
        requestKind: "mcp-elicitation",
        title: "Popo wants to: send an email with Gmail",
        appName: "Gmail",
        args: {
          kind: "app-action",
          appName: "Gmail",
          summary: "to: sam@acme.com\nsubject: Invoice",
        },
        options: OPTIONS,
        alwaysLabel: "Send an email with Gmail",
      }),
    )!;
    expect(app).toMatchObject({
      kind: "app",
      appName: "Gmail",
      heading: "send an email with Gmail",
      body: "to: sam@acme.com\nsubject: Invoice",
    });
  });
  it("an unknown tool still reads as 'Use <tool>' with its arguments; no Always unless the option is there; junk is null", () => {
    const v = parseApproval(
      card({ requestKind: "command", toolName: "Mystery", args: { a: 1, b: "two" } }),
    )!;
    expect(v).toMatchObject({
      kind: "other",
      heading: "Use Mystery",
      body: "a: 1\nb: two",
      alwaysLabel: null,
    });
    expect(
      parseApproval(
        command({
          options: [
            { decision: "accept", label: "Allow once" },
            { decision: "decline", label: "Deny" },
          ],
        }),
      )!.alwaysLabel,
    ).toBeNull();
    expect(parseApproval({ cardId: "x", version: 1, payload: { cardKind: "memory" } })).toBeNull();
    expect(parseApproval(card({ requestId: "" }))).toBeNull();
  });
  it("a sensitive read through a symlink shows where the link really goes (plv S3-6)", () => {
    const c = card({
      requestKind: "file-read",
      toolName: "Read",
      args: { file_path: "/Users/me/Blobs/Popo/files/link.txt" },
      linkTarget: "~/.ssh/id_rsa",
    });
    expect(parseApproval(c)).toMatchObject({
      target: "/Users/me/Blobs/Popo/files/link.txt",
      linkTarget: "~/.ssh/id_rsa",
    });
    const root = render(c, api()).root;
    const row = root.findAll((n) => n.props["data-approval-link-target"] !== undefined)[0]!;
    expect(text(row)).toBe("→ ~/.ssh/id_rsa");
    expect(parseApproval(command())!.linkTarget).toBeNull();
  });

  it("outcome lines and home shortening", () => {
    const v = parseApproval(command({ state: "always" }))!;
    expect(outcomeLine(v)).toBe(
      "Always allowed (Run sleep) · cd ~/Documents && sleep 40 && echo done > scratch/pine.txt",
    );
    expect(outcomeLine({ ...v, state: "denied" })).toMatch(/^Denied · /);
    expect(outcomeLine({ ...v, state: "cancelled" })).toMatch(/^Stopped before an answer · /);
    expect(outcomeLine({ ...v, state: "expired" })).toMatch(/^No longer waiting · /);
    expect(tildePath("/Users/me/Blobs/Popo", null)).toBe("~/Blobs/Popo");
    expect(tildePath("/Users/me/x", "/Users/me")).toBe("~/x");
    expect(tildePath("/var/tmp/x", null)).toBe("/var/tmp/x");
  });
});

describe("ApprovalCard", () => {
  it("shows the full command and folder with Allow once / Always for this blob / Deny, and each button answers once", async () => {
    const a = api();
    const r = render(command(), a);
    const root = r.root;
    expect(
      root.findAll((n) => n.props["data-approval-detail"] === "complete")[0]!.children.join(""),
    ).toContain("cd ~/Documents && sleep 40 && echo done > scratch/pine.txt");
    expect(text(root.findAll((n) => n.props["data-approval-cwd"] !== undefined)[0]!)).toBe(
      "~/Blobs/Popo",
    );
    expect(buttonsOf(root).map((b) => text(b).trim())).toEqual([
      "Allow once",
      "Always for this blob",
      "Deny",
    ]);
    expect(text(root)).toContain("Needs your OK");
    expect(text(root)).toContain("Popo wants to run a command");
    await act(async () => {
      action(root, "accept")!.props.onClick();
    });
    await act(async () => {
      action(root, "acceptAlways")!.props.onClick();
    });
    await act(async () => {
      action(root, "decline")!.props.onClick();
    });
    expect((a.respond as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual([
      "accept",
      "acceptAlways",
      "decline",
    ]);
    expect((a.respond as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("r1");
  });
  it("no Always button when no safe rule exists (an outbound command); buttons lock while an answer is in flight", () => {
    const noAlways = render(
      command({ alwaysLabel: undefined, options: [OPTIONS[0], OPTIONS[2]] }),
      api(),
    );
    expect(buttonsOf(noAlways.root).map((b) => text(b).trim())).toEqual(["Allow once", "Deny"]);
    const busy = render(command(), api({ responding: ["r1"] }));
    expect(buttonsOf(busy.root).every((b) => b.props.disabled === true)).toBe(true);
  });
  it("answered cards fold into one quiet line (no buttons); an open card nothing can answer any more reads 'No longer waiting'", () => {
    const done = render(command({ state: "allowed" }), api());
    expect(buttonsOf(done.root)).toHaveLength(0);
    expect(text(done.root)).toMatch(/^Allowed once · cd ~\/Documents/);
    const denied = render(command({ state: "denied" }), api());
    expect(text(denied.root)).toMatch(/^Denied · /);
    const stale = render(command(), api({ live: false }));
    expect(buttonsOf(stale.root)).toHaveLength(0);
    expect(text(stale.root)).toMatch(/^No longer waiting · /);
    expect(stale.root.findAll((n) => n.props["data-approval-state"] === "expired")).toHaveLength(1);
  });
  it("an answer that fails shows why and leaves the buttons usable", async () => {
    const a = api({
      respond: vi.fn(async () => {
        throw new Error("The daemon is not reachable.");
      }),
    });
    const r = render(command(), a);
    await act(async () => {
      action(r.root, "accept")!.props.onClick();
    });
    expect(text(r.root)).toContain("The daemon is not reachable.");
    expect(action(r.root, "accept")!.props.disabled).toBeFalsy();
  });
});

describe("an open approval card is brought into view", () => {
  it("scrolls itself above the composer when it appears, and not once it is answered", () => {
    const scrollIntoView = vi.fn();
    const mount = (c: BlobCardRef, live = true) => {
      let r!: ReturnType<typeof create>;
      act(() => {
        r = create(
          <BlobApprovalProvider value={api({ live })}>
            <ApprovalCard card={c} />
          </BlobApprovalProvider>,
          { createNodeMock: () => ({ scrollIntoView }) },
        );
      });
      return r;
    };
    const r = mount(command());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
    // the section keeps room for the composer when it scrolls
    expect(r.root.findAll((n) => n.type === "section")[0]!.props.className).toContain("scroll-mb-");
    scrollIntoView.mockClear();
    mount(command({ state: "allowed" }));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
