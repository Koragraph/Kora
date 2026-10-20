import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("../../ui/textarea", () => ({
  Textarea: (p: { [k: string]: unknown }) => <textarea {...p} />,
}));
vi.mock("../../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../../ui/dialog", () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogPopup: ({ children, ...r }: { children?: React.ReactNode; [k: string]: unknown }) => (
      <div {...r}>{children}</div>
    ),
    DialogHeader: Box,
    DialogTitle: Box,
    DialogDescription: Box,
    DialogFooter: Box,
  };
});

import { ExportTeamDialog } from "./ExportTeamDialog";
import { ImportTeamDialog } from "./ImportTeamDialog";
import {
  bytesLabel,
  groupKeeps,
  importButtonLabel,
  importCounts,
  defaultImportSkips,
  initialSelection,
  looksLikeUrl,
  toggleId,
  type ExportBlobOption,
  type ExportGroupOption,
  type ExportReportWire,
  type ImportPlanWire,
  type TeamExportApi,
  type TeamImportApi,
} from "./teamfileModel";

const text = (n: ReactTestInstance | string): string =>
  typeof n === "string" ? n : n.children.map(text).join("");
const byAttr = (root: ReactTestInstance, attr: string, value?: string) =>
  root.findAll(
    (n) =>
      typeof n.type === "string" &&
      (value === undefined ? attr in n.props : n.props[attr] === value),
  );
const render = (el: React.ReactElement) => {
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(el);
  });
  return r;
};
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

const blobs: ExportBlobOption[] = [
  {
    id: "p",
    name: "Popo",
    title: "Researcher",
    outfit: { head: "beanie" },
    skills: 2,
    routines: 1,
  },
  { id: "q", name: "Junip", title: "Analyst", outfit: {}, skills: 0, routines: 0 },
];
const groups: ExportGroupOption[] = [
  { id: "g1", name: "launch-week", memberIds: ["blob_kora", "p", "q"] },
  { id: "g2", name: "pair", memberIds: ["p", "q"] },
];

describe("export model", () => {
  it("starts with everything ticked, or only one blob when opened from it", () => {
    const all = initialSelection(blobs, groups);
    expect(all).toMatchObject({
      blobIds: ["p", "q"],
      groupIds: ["g1", "g2"],
      chief: true,
      routines: true,
      skills: true,
    });
    const one = initialSelection(blobs, groups, { blobId: "p" });
    expect(one).toMatchObject({ blobIds: ["p"], groupIds: [], chief: false, name: "Popo" });
  });
  it("a group needs two ticked members; Kora always counts", () => {
    const sel = { ...initialSelection(blobs, groups), blobIds: ["p"] };
    expect(groupKeeps(groups[0]!, sel, "blob_kora")).toEqual({ kept: 2, ok: true });
    expect(groupKeeps(groups[1]!, sel, "blob_kora")).toEqual({ kept: 1, ok: false });
  });
  it("small helpers", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
    expect(bytesLabel(900)).toBe("900 B");
    expect(bytesLabel(2048)).toBe("2.0 KB");
    expect(bytesLabel(54_000)).toBe("53 KB");
    expect(looksLikeUrl("https://example.com/a.md")).toBe(true);
    expect(looksLikeUrl("http://example.com")).toBe(false);
    expect(looksLikeUrl("not a url")).toBe(false);
  });
});

describe("ExportTeamDialog", () => {
  const report = (over: Partial<ExportReportWire> = {}): ExportReportWire => ({
    blobs: [
      {
        id: "p",
        name: "Popo",
        title: "Researcher",
        soulChars: 900,
        skills: 2,
        routines: 1,
        removed: 2,
      },
      {
        id: "q",
        name: "Junip",
        title: "Analyst",
        soulChars: 300,
        skills: 0,
        routines: 0,
        removed: 0,
      },
    ],
    groups: [],
    chief: true,
    findings: [{ kind: "api-key", count: 2 }],
    scrubNote: "2 API keys removed",
    neverIncluded: ["Chats and memory", "API keys and secrets"],
    bytes: 4300,
    ...over,
  });
  const mk = () => {
    const api: TeamExportApi = {
      preview: vi.fn(async () => ({ ok: true as const, value: report() })),
      save: vi.fn(async () => ({
        ok: true as const,
        value: { path: "/tmp/my-team.kora-team.md" },
      })),
      copy: vi.fn(async () => ({ ok: true as const, value: {} })),
    };
    return api;
  };

  it("lists blobs, groups, Kora, options; shows the scrub note, the never-included list and the size", async () => {
    const api = mk();
    const r = render(
      <ExportTeamDialog
        open
        onOpenChange={vi.fn()}
        blobs={blobs}
        groups={groups}
        koraId="blob_kora"
        api={api}
        debounceMs={0}
      />,
    );
    await flush();
    expect(byAttr(r.root, "data-export-row")).toHaveLength(2 + 2 + 3);
    expect(text(r.root)).toContain("2 API keys removed");
    expect(text(byAttr(r.root, "data-export-never")[0]!)).toContain("Chats and memory");
    expect(text(byAttr(r.root, "data-export-summary")[0]!)).toContain("2 blobs and 2 groups");
    expect(text(byAttr(r.root, "data-export-summary")[0]!)).toContain("4.2 KB");
    expect(byAttr(r.root, "data-export-removed")).toHaveLength(1);
    // "Never in the file" sits above the rows, so it is on screen without scrolling
    const shown = text(r.root);
    expect(shown.indexOf("Never in the file")).toBeGreaterThan(-1);
    expect(shown.indexOf("Never in the file")).toBeLessThan(shown.indexOf("Describe Kora"));
  });

  it("unticking re-previews with the new selection; no blob disables Save and Copy", async () => {
    const api = mk();
    const r = render(
      <ExportTeamDialog
        open
        onOpenChange={vi.fn()}
        blobs={blobs}
        groups={groups}
        koraId="blob_kora"
        api={api}
        debounceMs={0}
      />,
    );
    await flush();
    act(() => byAttr(r.root, "data-export-row", "q")[0]?.props.onClick());
    await flush();
    expect((api.preview as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
      blobIds: ["p"],
    });
    // group "pair" lost a member: shown but disabled
    expect(byAttr(r.root, "data-export-row", "g2")[0]?.props["aria-disabled"]).toBe(true);
    act(() => byAttr(r.root, "data-export-row", "p")[0]?.props.onClick());
    await flush();
    expect(byAttr(r.root, "data-export-save")[0]?.props.disabled).toBe(true);
    expect(text(byAttr(r.root, "data-export-summary")[0]!)).toContain("Tick at least one blob");
  });

  it("opened from one blob: only it is ticked; Save and Copy call the api with the selection", async () => {
    const api = mk();
    const r = render(
      <ExportTeamDialog
        open
        onOpenChange={vi.fn()}
        blobs={blobs}
        groups={groups}
        koraId="blob_kora"
        onlyBlobId="p"
        api={api}
        debounceMs={0}
      />,
    );
    await flush();
    expect(text(r.root)).toContain("Share Popo");
    await act(async () => byAttr(r.root, "data-export-save")[0]?.props.onClick());
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({ blobIds: ["p"], groupIds: [] }),
    );
    expect(text(byAttr(r.root, "data-export-summary")[0]!)).toContain("Saved.");
    await act(async () => byAttr(r.root, "data-export-copy")[0]?.props.onClick());
    expect(api.copy).toHaveBeenCalled();
  });

  it("a roster that arrives after the dialog opened is ticked, not left on 'Tick at least one blob'", async () => {
    const api = mk();
    const el = (list: typeof blobs) => (
      <ExportTeamDialog
        open
        onOpenChange={vi.fn()}
        blobs={list}
        groups={[]}
        koraId={null}
        api={api}
        debounceMs={0}
      />
    );
    const r = render(el([]));
    await flush();
    expect(text(byAttr(r.root, "data-export-summary")[0]!)).toContain("Tick at least one blob");
    await act(async () => r.update(el(blobs)));
    await flush();
    expect((api.preview as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
      blobIds: ["p", "q"],
    });
    expect(text(byAttr(r.root, "data-export-summary")[0]!)).not.toContain("Tick at least one blob");
  });

  it("shows an api failure", async () => {
    const api = mk();
    (api.preview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      message: "Daemon offline.",
    });
    const r = render(
      <ExportTeamDialog
        open
        onOpenChange={vi.fn()}
        blobs={blobs}
        groups={groups}
        koraId={null}
        api={api}
        debounceMs={0}
      />,
    );
    await flush();
    expect(text(byAttr(r.root, "data-export-error")[0]!)).toBe("Daemon offline.");
  });
});

// ── import ───────────────────────────────────────────────────────────────────────────────────────
const plan = (over: Partial<ImportPlanWire> = {}): ImportPlanWire => ({
  planId: "plan1",
  title: "Launch crew",
  description: "A small crew.",
  blobs: [
    {
      fileName: "Popo",
      name: "Popo 2",
      renamed: true,
      title: "Researcher",
      soul: "You are Popo.",
      outfit: { head: "beanie", face: null, neck: null },
      skills: [{ name: "web-research", description: "" }],
      routines: [{ title: "Morning brief", cadence: "Weekdays at 9:00", prompt: "x" }],
      flags: [
        { kind: "link", text: "Mentions a link" },
        { kind: "commands", text: "Mentions running shell commands" },
        { kind: "secrets-removed", text: "1 secret-looking thing removed" },
      ],
    },
    {
      fileName: "Junip",
      name: "Junip",
      renamed: false,
      title: "Analyst",
      soul: "Numbers.",
      outfit: null,
      skills: [],
      routines: [],
      flags: [],
    },
  ],
  groups: [
    {
      fileName: "launch-week",
      name: "launch-week",
      renamed: false,
      members: ["Kora", "Popo 2", "Junip"],
      lead: "Kora",
      rule: "auto",
      instructions: "",
    },
  ],
  skipped: [{ what: "kora", why: "Kora is yours already. An import never replaces her." }],
  notes: ["Kora stays exactly as she is."],
  warnings: [],
  removedSecrets: 1,
  ...over,
});

describe("import model", () => {
  it("counts what pressing Import creates after unticks; a group without two members is dropped", () => {
    const p = plan();
    expect(importCounts(p, { blobs: [], groups: [] })).toMatchObject({
      blobs: 2,
      groups: 1,
      routines: 1,
      skills: 1,
      droppedGroups: [],
    });
    const c = importCounts(p, { blobs: ["Popo 2", "Junip"], groups: [] });
    expect(c).toMatchObject({ blobs: 0, groups: 0, droppedGroups: ["launch-week"] });
    expect(importCounts(p, { blobs: ["Junip"], groups: [] }).groups).toBe(1); // Kora + Popo 2 still make two
    expect(importCounts(p, { blobs: [], groups: ["launch-week"] }).groups).toBe(0);
  });
  it("button label", () => {
    expect(importButtonLabel({ blobs: 3, groups: 1 })).toBe("Import 3 blobs and 1 group");
    expect(importButtonLabel({ blobs: 1, groups: 0 })).toBe("Import 1 blob");
    expect(importButtonLabel({ blobs: 0, groups: 0 })).toBe("Nothing to import");
  });
});

describe("ImportTeamDialog", () => {
  const mkApi = (over: Partial<TeamImportApi> = {}): TeamImportApi => ({
    fromText: vi.fn(async () => ({ ok: true as const, value: plan() })),
    fromUrl: vi.fn(async () => ({ ok: true as const, value: plan() })),
    apply: vi.fn(async () => ({
      ok: true as const,
      value: {
        blobs: [
          { id: "n1", name: "Popo 2" },
          { id: "n2", name: "Junip" },
        ],
        groups: [{ id: "g", name: "launch-week" }],
        errors: [],
      },
    })),
    ...over,
  });

  it("starts at the source step: choose a file, paste a link (https only), or paste text", async () => {
    const api = mkApi();
    const r = render(<ImportTeamDialog open onOpenChange={vi.fn()} api={api} />);
    expect(byAttr(r.root, "data-import-choose")).toHaveLength(1);
    expect(byAttr(r.root, "data-import-fetch")[0]?.props.disabled).toBe(true);
    act(() =>
      byAttr(r.root, "data-import-url")[0]?.props.onChange({
        target: { value: "http://x.com/a.md" },
      }),
    );
    expect(byAttr(r.root, "data-import-fetch")[0]?.props.disabled).toBe(true);
    act(() =>
      byAttr(r.root, "data-import-url")[0]?.props.onChange({
        target: { value: "https://example.com/crew.kora-team.md" },
      }),
    );
    expect(byAttr(r.root, "data-import-fetch")[0]?.props.disabled).toBe(false);
    await act(async () => byAttr(r.root, "data-import-fetch")[0]?.props.onClick());
    expect(api.fromUrl).toHaveBeenCalledWith("https://example.com/crew.kora-team.md");
    expect(text(r.root)).toContain("Review before importing");
  });

  it("a rejected file stays on the source step with the reason", async () => {
    const api = mkApi({
      fromUrl: vi.fn(async () => ({
        ok: false as const,
        message: "Only https links can be imported.",
      })),
    });
    const r = render(<ImportTeamDialog open onOpenChange={vi.fn()} api={api} />);
    act(() =>
      byAttr(r.root, "data-import-url")[0]?.props.onChange({
        target: { value: "https://example.com/x.md" },
      }),
    );
    await act(async () => byAttr(r.root, "data-import-fetch")[0]?.props.onClick());
    expect(text(byAttr(r.root, "data-import-error")[0]!)).toBe("Only https links can be imported.");
    expect(byAttr(r.root, "data-import-apply")).toHaveLength(0);
  });

  it("the review lists exactly what will be created, with the guarantees, final names, flags and skipped items", () => {
    const r = render(
      <ImportTeamDialog open onOpenChange={vi.fn()} api={mkApi()} initialPlan={plan()} />,
    );
    const g = text(byAttr(r.root, "data-import-guarantees")[0]!);
    for (const t of ["Apps off", "Routines paused", "Skills off", "Kora untouched"])
      expect(g).toContain(t);
    expect(byAttr(r.root, "data-import-blob")).toHaveLength(2);
    expect(text(byAttr(r.root, "data-import-blob", "Popo 2")[0]!)).toContain("was Popo");
    expect(text(byAttr(r.root, "data-import-blob", "Popo 2")[0]!)).toContain("1 skill (off)");
    expect(text(byAttr(r.root, "data-import-blob", "Popo 2")[0]!)).toContain("1 routine (paused)");
    expect(byAttr(r.root, "data-flag").map((n) => n.props["data-flag"])).toEqual([
      "link",
      "commands",
      "secrets-removed",
    ]);
    expect(text(byAttr(r.root, "data-import-group", "launch-week")[0]!)).toContain(
      "Kora, Popo 2, Junip",
    );
    expect(text(byAttr(r.root, "data-import-skipped")[0]!)).toContain("never replaces her");
    expect(text(byAttr(r.root, "data-import-apply")[0]!)).toBe("Import 2 blobs and 1 group");
  });

  it("unticking a blob changes the count; Import sends only the plan id and the skips, then shows the result", async () => {
    const api = mkApi();
    const onImported = vi.fn();
    const r = render(
      <ImportTeamDialog
        open
        onOpenChange={vi.fn()}
        api={api}
        initialPlan={plan()}
        onImported={onImported}
      />,
    );
    act(() => byAttr(r.root, "aria-label", "Import Junip")[0]?.props.onClick());
    expect(text(byAttr(r.root, "data-import-apply")[0]!)).toBe("Import 1 blob and 1 group");
    await act(async () => byAttr(r.root, "data-import-apply")[0]?.props.onClick());
    expect(api.apply).toHaveBeenCalledWith("plan1", { blobs: ["Junip"], groups: [], replace: [] });
    expect(onImported).toHaveBeenCalled();
    expect(text(r.root)).toContain("Imported");
    expect(byAttr(r.root, "data-import-close")).toHaveLength(1);
  });

  it("nothing left ticked disables Import; a failed apply returns to the review with the error", async () => {
    const api = mkApi({
      apply: vi.fn(async () => ({ ok: false as const, message: "Disk full." })),
    });
    const r = render(
      <ImportTeamDialog open onOpenChange={vi.fn()} api={api} initialPlan={plan()} />,
    );
    act(() => byAttr(r.root, "aria-label", "Import Popo 2")[0]?.props.onClick());
    act(() => byAttr(r.root, "aria-label", "Import Junip")[0]?.props.onClick());
    expect(byAttr(r.root, "data-import-apply")[0]?.props.disabled).toBe(true);
    act(() => byAttr(r.root, "aria-label", "Import Junip")[0]?.props.onClick());
    await act(async () => byAttr(r.root, "data-import-apply")[0]?.props.onClick());
    expect(text(byAttr(r.root, "data-import-error")[0]!)).toBe("Disk full.");
    expect(byAttr(r.root, "data-import-apply")).toHaveLength(1);
  });

  it("a SOUL is readable before import (expand), and per-item errors are shown after", async () => {
    const api = mkApi({
      apply: vi.fn(async () => ({
        ok: true as const,
        value: { blobs: [], groups: [], errors: [{ what: "Popo 2", error: "disk full" }] },
      })),
    });
    const r = render(
      <ImportTeamDialog open onOpenChange={vi.fn()} api={api} initialPlan={plan()} />,
    );
    act(() => byAttr(r.root, "aria-label", "Read Popo 2's personality")[0]?.props.onClick());
    expect(text(byAttr(r.root, "data-import-detail")[0]!)).toContain("You are Popo.");
    await act(async () => byAttr(r.root, "data-import-apply")[0]?.props.onClick());
    expect(text(byAttr(r.root, "data-import-failures")[0]!)).toContain("Popo 2: disk full");
  });
});

describe("importing a blob you already have", () => {
  const withExisting = () =>
    plan({
      blobs: [
        { ...plan().blobs[0]!, existing: { id: "mine_popo", identical: true } },
        {
          fileName: "Wobbo",
          name: "Wobbo 2",
          renamed: true,
          title: "Analyst",
          soul: "Numbers.",
          outfit: null,
          skills: [],
          routines: [],
          flags: [],
          existing: { id: "mine_wobbo", identical: false },
        },
        { ...plan().blobs[1]!, existing: null },
      ],
    });
  const mkApi = (): TeamImportApi => ({
    fromText: vi.fn(async () => ({ ok: true as const, value: withExisting() })),
    fromUrl: vi.fn(async () => ({ ok: true as const, value: withExisting() })),
    apply: vi.fn(async () => ({ ok: true as const, value: { blobs: [], groups: [], errors: [] } })),
  });

  it("an identical blob starts skipped, a different one starts as 'keep both'", () => {
    expect(defaultImportSkips(withExisting())).toEqual(["Popo 2"]);
    const r = render(
      <ImportTeamDialog open onOpenChange={vi.fn()} api={mkApi()} initialPlan={withExisting()} />,
    );
    expect(byAttr(r.root, "data-import-existing", "identical")).toHaveLength(1);
    expect(text(byAttr(r.root, "data-import-existing", "identical")[0]!)).toContain(
      "exactly like this",
    );
    expect(text(byAttr(r.root, "data-import-existing", "identical")[0]!)).toContain("Skipped");
    expect(text(byAttr(r.root, "data-import-existing", "different")[0]!)).toContain(
      "this one is different",
    );
    const keep = byAttr(
      byAttr(r.root, "data-import-blob", "Wobbo 2")[0]!,
      "data-import-choice",
      "keep",
    )[0]!;
    expect(keep.props["aria-checked"]).toBe(true);
    expect(text(keep)).toContain("Keep both (Wobbo 2)");
    expect(text(byAttr(r.root, "data-import-apply")[0]!)).toBe("Import 2 blobs and 1 group");
  });

  it("Replace sends the blob in `replace`; the rename note disappears; ticking an identical one back on offers the choice", async () => {
    const api = mkApi();
    const r = render(
      <ImportTeamDialog open onOpenChange={vi.fn()} api={api} initialPlan={withExisting()} />,
    );
    act(() =>
      byAttr(
        byAttr(r.root, "data-import-blob", "Wobbo 2")[0]!,
        "data-import-choice",
        "replace",
      )[0]?.props.onClick(),
    );
    expect(text(byAttr(r.root, "data-import-blob", "Wobbo 2")[0]!)).not.toContain("was Wobbo");
    await act(async () => byAttr(r.root, "data-import-apply")[0]?.props.onClick());
    expect(api.apply).toHaveBeenCalledWith("plan1", {
      blobs: ["Popo 2"],
      groups: [],
      replace: ["Wobbo 2"],
    });
  });

  it("a replace on a blob that is then skipped is not sent", async () => {
    const api = mkApi();
    const r = render(
      <ImportTeamDialog open onOpenChange={vi.fn()} api={api} initialPlan={withExisting()} />,
    );
    act(() =>
      byAttr(
        byAttr(r.root, "data-import-blob", "Wobbo 2")[0]!,
        "data-import-choice",
        "replace",
      )[0]?.props.onClick(),
    );
    act(() => byAttr(r.root, "aria-label", "Import Wobbo 2")[0]?.props.onClick());
    await act(async () => byAttr(r.root, "data-import-apply")[0]?.props.onClick());
    expect(api.apply).toHaveBeenCalledWith("plan1", {
      blobs: ["Popo 2", "Wobbo 2"],
      groups: [],
      replace: [],
    });
  });
});
