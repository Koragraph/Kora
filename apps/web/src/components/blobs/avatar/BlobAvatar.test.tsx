// @effect-diagnostics nodeBuiltinImport:off - reads the stylesheet sources to check the palette contract.
import {
  shuffledOutfit,
  defaultOutfitFor,
  STARTER_OUTFITS,
  OutfitPicker,
  BlobAvatarGallery,
  BlobAvatar,
  BLOB_STATES,
  BLOB_SIZES,
  ACCESSORY_CHOICES,
} from "./index";

import { SpriteMotionProvider } from "~/components/sprite";
import { describe, expect, it } from "vite-plus/test";

import { renderToStaticMarkup } from "react-dom/server";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

describe("BlobAvatar motion rule", () => {
  it("the nav and the Kora coming-soon showcase are the only places that opt into ambient motion", () => {
    const src = (f: string) => NodeFS.readFileSync(NodePath.join(here, "../../", f), "utf8");
    expect(src("blobs/shell/BlobsNavContent.tsx")).toContain(
      '<SpriteMotionProvider value="ambient">',
    );
    const providers = NodeFS.globSync("**/*.tsx", { cwd: NodePath.join(here, "../../..") })
      .map((f) => f.split(NodePath.sep).join("/")) // Windows: globSync answers with "\\"
      .filter((f) => !f.endsWith(".test.tsx") && !f.startsWith("components/sprite/"))
      .filter((f) =>
        NodeFS.readFileSync(NodePath.join(here, "../../..", f), "utf8").includes(
          "<SpriteMotionProvider",
        ),
      );
    expect(providers.sort()).toEqual([
      "components/blobs/shell/BlobsNavContent.tsx",
      // The coming-soon page's team idles gently (reduced motion stops it): a showcase, never a conversation.
      "components/kora/KoraComingSoon.tsx",
    ]);
  });

  it("content sprites move only through the frame engine: the live turn's lead plays one PixelAnimation", () => {
    const lead = NodeFS.readFileSync(NodePath.join(here, "../../thread/LeadBlob.tsx"), "utf8");
    expect(lead).not.toContain("<SpriteMotionProvider");
    expect(lead).toContain("<PixelAnimation");
    const players = NodeFS.globSync("**/*.tsx", { cwd: NodePath.join(here, "../../..") })
      .map((f) => f.split(NodePath.sep).join("/"))
      .filter((f) => !f.endsWith(".test.tsx") && !f.startsWith("components/sprite/"))
      .filter((f) =>
        NodeFS.readFileSync(NodePath.join(here, "../../..", f), "utf8").includes("<PixelAnimation"),
      );
    expect(players.sort()).toEqual([
      // The lead's working animation while a turn runs (only mood "working"): a frozen one read as hung.
      "components/thread/LeadBlob.tsx",
    ]);
  });

  it("the still frame still carries the state (needs-you ?, sleeping z)", () => {
    expect(renderToStaticMarkup(<BlobAvatar state="waiting" />)).toContain('data-state="wait"');
    expect(renderToStaticMarkup(<BlobAvatar state="sleeping" />)).toContain("px-mark");
  });
  it("is still in the content area (default) and animates only inside the nav provider", () => {
    const content = renderToStaticMarkup(<BlobAvatar state="working" reaction="wave" />);
    expect(content).toContain("px-sprite--still");
    expect(content).not.toContain("data-reaction");
    const nav = renderToStaticMarkup(
      <SpriteMotionProvider value="ambient">
        <BlobAvatar state="working" />
      </SpriteMotionProvider>,
    );
    expect(nav).not.toContain("px-sprite--still");
    expect(nav).toContain('data-state="walk"');
  });
});

describe("palette", () => {
  it("uses only neutral greys (Ink: no hue)", () => {
    const hex = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
    for (const file of [
      "blobAvatar.css",
      "blobPicker.css",
      "BlobAvatar.tsx",
      "../../sprite/sprite.css",
      "../../sprite/spriteData.ts",
    ]) {
      const src = NodeFS.readFileSync(NodePath.join(here, file), "utf8");
      for (const m of src.matchAll(hex)) {
        const h = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
        const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [
          number,
          number,
          number,
        ];
        // Allow the Ink surface tints (#1f2024, #26272c ...): channel spread <= 8.
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${file} ${m[0]}`).toBeLessThanOrEqual(12);
      }
      expect(src).not.toMatch(
        /\b(blue|sky|cyan|violet|indigo|purple|red|green|orange|amber|pink)\b/i,
      );
    }
  });
});

describe("gallery + picker", () => {
  it("render", () => {
    expect(renderToStaticMarkup(<BlobAvatarGallery />)).toContain("blob-avatar-gallery");
    const html = renderToStaticMarkup(<OutfitPicker value={{ head: "cap" }} onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Shuffle");
    expect(html).not.toContain("Head: Crown");
    expect(html).toContain("Accessory: None");
    expect(html.match(/role="radio"/g)).toHaveLength(11); // none + 10 accessories
    expect(renderToStaticMarkup(<OutfitPicker chief value={{}} onChange={() => {}} />)).toContain(
      "Head: Crown",
    );
  });
});

describe("starter roster", () => {
  it("is the plain blob plus exactly one aspect each", () => {
    expect(STARTER_OUTFITS).toEqual({
      fizzle: { head: "flower" },
      plonk: { face: "square-glasses" },
      zonk: { head: "beanie" },
      mibble: { face: "sunglasses" },
      tibbo: { head: "top-hat" },
      wobbo: { face: "monocle" },
      junip: { head: "beret" },
      dimp: { head: "cap" },
      bobble: { head: "headphones" },
      popo: { face: "round-glasses" },
      kora: { head: "crown" },
    });
  });
});

describe("BlobAvatar", () => {
  it("snaps every size to a whole multiple of 12 px", () => {
    for (const size of BLOB_SIZES) {
      const w = Number(
        renderToStaticMarkup(<BlobAvatar size={size} />).match(/width:(\d+)px/)?.[1],
      );
      expect(w % 12).toBe(0);
    }
  });

  it("chief is the same blob plus a crown, larger, with a badge from 40px", () => {
    const html = renderToStaticMarkup(<BlobAvatar chief badge size={56} />);
    expect(html).toContain("Chief");
    expect(html).toContain("width:72px"); // 56 * 1.2 = 67.2, snapped to 6 whole pixels per sprite pixel
    expect(html).toContain('data-accessory="crown"');
    expect(renderToStaticMarkup(<BlobAvatar chief badge size={24} />)).not.toContain(
      "blob-av__badge",
    );
  });

  it("applies the reduced-motion class", () => {
    expect(renderToStaticMarkup(<BlobAvatar reducedMotion />)).toContain("px-sprite--reduced");
    expect(renderToStaticMarkup(<BlobAvatar reducedMotion={false} />)).not.toContain(
      "px-sprite--reduced",
    );
  });

  it("renders every state and maps it onto a sprite frame", () => {
    for (const state of BLOB_STATES) {
      expect(renderToStaticMarkup(<BlobAvatar state={state} />)).toContain("data-state=");
    }
    const frame = (state: (typeof BLOB_STATES)[number]) =>
      renderToStaticMarkup(<BlobAvatar state={state} />).match(/data-state="(\w+)"/)?.[1];
    expect(frame("working")).toBe("walk");
    expect(frame("waiting")).toBe("wait");
    expect(frame("sleeping")).toBe("sleep");
    expect(frame("done")).toBe("done");
    expect(frame("failed")).toBe("fail");
    expect(frame("streaming")).toBe("idle");
    expect(renderToStaticMarkup(<BlobAvatar state="streaming" />)).toContain("px-mouth");
    expect(frame("archived")).toBe("off");
  });

  it("legacy ids (neck items, retired hats) render the plain blob", () => {
    for (const outfit of [{ neck: "scarf" }, { head: "party-hat" }, { face: "moustache" }]) {
      expect(renderToStaticMarkup(<BlobAvatar outfit={outfit as never} />)).not.toContain(
        'class="px-acc"><path',
      );
    }
  });
  it("renders every accessory at every size, and each draws exactly one accessory group", () => {
    for (const size of BLOB_SIZES) {
      for (const c of ACCESSORY_CHOICES) {
        const html = renderToStaticMarkup(
          <BlobAvatar size={size} outfit={c.slot === "head" ? { head: c.id } : { face: c.id }} />,
        );
        expect(html).toContain("<svg");
        expect(html.match(/class="px-acc"><path/g)).toHaveLength(1);
      }
    }
  });
});

describe("pixel sprite body", () => {
  it("renders the classic sprite with no accessory by default", () => {
    const html = renderToStaticMarkup(<BlobAvatar />);
    expect(html).toContain("px-sprite");
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).not.toContain('px-acc"><path');
    const src = NodeFS.readFileSync(NodePath.join(here, "blobAvatar.css"), "utf8");
    expect(src).not.toMatch(/border-radius:\s*48%/);
  });
});

describe("defaultOutfitFor", () => {
  it("shuffle also yields a single accessory", () => {
    for (let i = 0; i < 100; i++) {
      const o = shuffledOutfit(i % 2 === 0);
      expect([o.head, o.face].filter(Boolean)).toHaveLength(1);
    }
  });

  it("varies across ids", () => {
    const keys = new Set(
      Array.from({ length: 200 }, (_, i) => {
        const o = defaultOutfitFor(`x${i}`);
        return o.head ?? o.face;
      }),
    );
    expect(keys.size).toBeGreaterThan(5);
  });

  it("gives exactly one accessory, never the crown, never a neck item", () => {
    for (let i = 0; i < 500; i++) {
      const o = defaultOutfitFor(`id-${i}-${i * 7919}`);
      expect([o.head, o.face].filter(Boolean)).toHaveLength(1);
      expect(o.head).not.toBe("crown");
    }
  });
  it("is deterministic", () => {
    expect(defaultOutfitFor("blob-123")).toEqual(defaultOutfitFor("blob-123"));
  });
});
