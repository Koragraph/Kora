import type { BlobProfile } from "@kora/contracts";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));

import { SAMPLE_TEMPLATES } from "./fixtures";
import {
  hireLabel,
  koraHireLine,
  orderedSelection,
  pruneSelection,
  toTemplateView,
  toggleSelected,
} from "./galleryModel";
import { StarterGallery, type HireResult } from "./StarterGallery";
import { KoraWelcome } from "../welcome/KoraWelcome";
import { KoraFirstRun } from "../welcome/KoraFirstRun";

const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const byAttr = (root: ReactTestInstance, attr: string, value?: string) =>
  root.findAll(
    (n) =>
      typeof n.type === "string" &&
      (value === undefined ? attr in n.props : n.props[attr] === value),
  );

const profile = (id: string, name: string, templateId: string): BlobProfile => ({
  id,
  version: 1,
  name,
  title: "",
  role: "member",
  teamId: "team",
  engine: { instanceId: "claude", model: "sonnet", effort: null },
  permission: "auto",
  outfit: null,
  toolGrants: {
    apps: { mode: "none", allow: [] },
    mcp: [],
    computer: { browser: false, vm: false },
  },
  slug: name.toLowerCase(),
  workspace: `/tmp/${name}`,
  templateId,
  pinned: false,
  hidden: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
});

const okHire = (ids: ReadonlyArray<string>): Promise<HireResult> =>
  Promise.resolve({
    ok: true,
    profiles: ids.map((id) => profile(`blob_${id}`, id[0]!.toUpperCase() + id.slice(1), id)),
  });

async function mountGallery(over: Partial<React.ComponentProps<typeof StarterGallery>> = {}) {
  const onHire = vi.fn(okHire);
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <StarterGallery
        templates={SAMPLE_TEMPLATES}
        hiredTemplateIds={new Set()}
        onHire={onHire}
        flyIn={false}
        {...over}
      />,
    );
  });
  return { renderer, onHire };
}

describe("gallery model", () => {
  it("reads a template into its card fields (outfit, one-line job, three asks, wants)", () => {
    const bobble = SAMPLE_TEMPLATES.find((t) => t.id === "bobble")!;
    const view = toTemplateView(bobble);
    expect(view).toMatchObject({ name: "Bobble", title: "Inbox", wants: ["Gmail", "Outlook"] });
    expect(view.outfit.head).toBe("headphones");
    expect(view.exampleAsks).toHaveLength(3);
    expect(view.job).toContain("Triages your email");
  });

  it("selection toggles, never selects a hired template, and prunes", () => {
    const hired = new Set(["popo"]);
    let sel = toggleSelected(new Set(), "dimp", hired);
    sel = toggleSelected(sel, "junip", hired);
    expect([...sel]).toEqual(["dimp", "junip"]);
    expect(toggleSelected(sel, "popo", hired).has("popo")).toBe(false);
    expect([...toggleSelected(sel, "dimp", hired)]).toEqual(["junip"]);
    expect([...pruneSelection(sel, ["junip"], hired)]).toEqual(["junip"]);
    expect(orderedSelection(new Set(["junip", "dimp"]), ["dimp", "junip", "fizzle"])).toEqual([
      "dimp",
      "junip",
    ]);
  });

  it("labels and Kora's one-liner", () => {
    expect(hireLabel(1)).toBe("Hire 1 blob");
    expect(hireLabel(3)).toBe("Hire 3 blobs");
    expect(koraHireLine(["Popo"])).toBe("Popo's on the team. Want me to give Popo a first task?");
    expect(koraHireLine(["Popo", "Dimp", "Fizzle"])).toContain(
      "Popo, Dimp and Fizzle are on the team",
    );
    expect(koraHireLine([])).toBeNull();
  });
});

describe("StarterGallery", () => {
  it("shows the ten starter cards with name · role, job, asks and wants chips", async () => {
    const { renderer } = await mountGallery();
    const cards = byAttr(renderer.root, "data-template-card");
    expect(cards).toHaveLength(10);
    const bobble = cards.find((c) => c.props["data-template-card"] === "bobble")!;
    expect(text(bobble)).toContain("Bobble");
    expect(text(bobble)).toContain("Inbox");
    expect(text(bobble)).toContain("Works best with");
    expect(text(bobble)).toContain("Gmail");
    expect(text(bobble)).toContain("“What needs a reply today?”");
    expect(byAttr(renderer.root, "data-hire-bar")).toHaveLength(0);
  });

  it("selects several and hires them from the sticky bar, in gallery order", async () => {
    const { renderer, onHire } = await mountGallery();
    const select = (id: string) => byAttr(renderer.root, "data-template-select", id)[0]!;
    await act(async () => select("junip").props.onClick());
    await act(async () => select("dimp").props.onClick());
    expect(select("junip").props["aria-checked"]).toBe(true);
    const bar = byAttr(renderer.root, "data-hire-bar")[0]!;
    const hireBtn = byAttr(bar, "data-hire-selected")[0]!;
    expect(text(hireBtn)).toBe("Hire 2 blobs");
    await act(async () => {
      await hireBtn.props.onClick();
    });
    expect(onHire).toHaveBeenCalledTimes(1);
    expect(onHire).toHaveBeenCalledWith(["dimp", "junip"]);
    // Hired cards flip to "On the team", lose Hire, and the bar is gone.
    const dimp = byAttr(renderer.root, "data-template-card", "dimp")[0]!;
    expect(dimp.props["data-hired"]).toBe("true");
    expect(text(dimp)).toContain("On the team");
    expect(byAttr(dimp, "data-template-hire")).toHaveLength(0);
    expect(byAttr(renderer.root, "data-hire-bar")).toHaveLength(0);
  });

  it("Hire on one card hires just that template", async () => {
    const { renderer, onHire } = await mountGallery();
    await act(async () => {
      await byAttr(renderer.root, "data-template-hire", "popo")[0]!.props.onClick();
    });
    expect(onHire).toHaveBeenCalledWith(["popo"]);
  });

  it("templates already on the team show 'On the team' and cannot be selected", async () => {
    const { renderer } = await mountGallery({ hiredTemplateIds: new Set(["popo"]) });
    const popo = byAttr(renderer.root, "data-template-card", "popo")[0]!;
    expect(text(popo)).toContain("On the team");
    expect(byAttr(popo, "data-template-select")).toHaveLength(0);
    expect(byAttr(popo, "data-template-hire")).toHaveLength(0);
  });

  it("a failed hire keeps the selection and says why", async () => {
    const onHire = vi.fn(async (): Promise<HireResult> => ({
      ok: false,
      message: "Could not hire them.",
    }));
    const { renderer } = await mountGallery({ onHire });
    await act(async () =>
      byAttr(renderer.root, "data-template-select", "wobbo")[0]!.props.onClick(),
    );
    await act(async () => {
      await byAttr(renderer.root, "data-hire-selected")[0]!.props.onClick();
    });
    expect(text(byAttr(renderer.root, "data-hire-bar")[0]!)).toContain("Could not hire them.");
    expect(byAttr(renderer.root, "data-template-card", "wobbo")[0]!.props["data-hired"]).toBe(
      "false",
    );
  });
});

describe("Kora welcome + first run", () => {
  it("gives concrete first steps and hosts the sign-in card inside the welcome", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <KoraWelcome
          onBrowse={vi.fn()}
          onBuild={vi.fn()}
          setup={<div data-test-setup-card>Log in to Claude to start</div>}
        />,
      );
    });
    const t = text(renderer.root);
    expect(byAttr(renderer.root, "data-test-setup-card")).toHaveLength(1);
    expect(byAttr(renderer.root, "data-kora-welcome-steps")).toHaveLength(1);
    expect(t).toContain("Log in to Claude");
    expect(t).toContain("Send your first message");
    expect(t).toContain("Switch to Code");
  });

  it("welcome has the intro, both actions and the direct-message hint", async () => {
    const onBrowse = vi.fn();
    const onBuild = vi.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<KoraWelcome onBrowse={onBrowse} onBuild={onBuild} />);
    });
    const t = text(renderer.root);
    expect(t).toContain("I’m Kora.");
    expect(t).toContain("I run your team of blobs");
    expect(t).toContain("message any blob directly");
    await act(async () => byAttr(renderer.root, "data-welcome-browse")[0]!.props.onClick());
    await act(async () => byAttr(renderer.root, "data-welcome-build")[0]!.props.onClick());
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(onBuild).toHaveBeenCalledTimes(1);
  });

  it("Browse the roster opens the gallery; a hire makes Kora say her one line", async () => {
    const onHire = vi.fn(okHire);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <KoraFirstRun
          gallery={{
            templates: SAMPLE_TEMPLATES,
            hiredTemplateIds: new Set(),
            onHire,
            flyIn: false,
          }}
          onBuild={() => {}}
        />,
      );
    });
    await act(async () => byAttr(renderer.root, "data-welcome-browse")[0]!.props.onClick());
    expect(byAttr(renderer.root, "data-starter-gallery")).toHaveLength(1);
    await act(async () => {
      await byAttr(renderer.root, "data-template-hire", "popo")[0]!.props.onClick();
    });
    expect(text(byAttr(renderer.root, "data-kora-hire-line")[0]!)).toContain(
      "Popo's on the team. Want me to give Popo a first task?",
    );
  });
});

describe("template card polish (live QA #2)", () => {
  it("every card reserves its job lines, names the real suggested routine once, and the Hire button looks the same selected or not", async () => {
    const { renderer } = await mountGallery();
    const popo = byAttr(renderer.root, "data-template-card", "popo")[0]!;
    expect(byAttr(popo, "data-template-job")).toHaveLength(1);
    expect(byAttr(popo, "data-template-job")[0]!.props.className).toContain("line-clamp-3");
    // Popo and Tibbo come with a paused routine: said once, in words, from the template's real routine
    const routine = byAttr(popo, "data-template-routine");
    expect(routine).toHaveLength(1);
    expect(text(routine[0]!)).toMatch(/Suggested routine · .* \(paused\)/);
    const tibbo = byAttr(renderer.root, "data-template-card", "tibbo")[0]!;
    expect(byAttr(tibbo, "data-template-routine")).toHaveLength(1);
    expect(text(byAttr(tibbo, "data-template-wants")[0]!)).not.toMatch(/routine/i);
    // a template with no routine has no routine line
    const none = SAMPLE_TEMPLATES.find((t) => t.draft.routines.length === 0);
    if (none)
      expect(
        byAttr(byAttr(renderer.root, "data-template-card", none.id)[0]!, "data-template-routine"),
      ).toHaveLength(0);
    // the Hire button is the same outline whether the card is selected or not
    const hire = byAttr(popo, "data-template-hire")[0]!;
    const before = hire.props.variant;
    await act(async () => {
      byAttr(popo, "data-template-select")[0]!.props.onClick();
    });
    expect(
      byAttr(byAttr(renderer.root, "data-template-card", "popo")[0]!, "data-template-hire")[0]!
        .props.variant,
    ).toBe(before);
    expect(before).toBe("outline");
    // the grid keeps rows an even height
    expect(byAttr(renderer.root, "data-gallery-grid")[0]!.props.className).toContain(
      "auto-rows-fr",
    );
  });
});
