// @effect-diagnostics nodeBuiltinImport:off - reads scripts/brand/make-icons.py to keep its sprite map in step.
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PRESS_REACTION_MS, PixelSprite } from "./PixelSprite";
import { SpriteMotionProvider } from "./spriteMotion";
import {
  ACCESSORIES,
  ACCESSORY_IDS,
  BASE,
  GRID,
  SPRITE_STATES,
  composeRows,
  eyesMovable,
  spriteScale,
} from "./spriteData";

describe("sprite maps", () => {
  it("the base body and every composed frame are 12x12", () => {
    expect(BASE).toHaveLength(GRID);
    for (const state of SPRITE_STATES) {
      for (const acc of [null, ...ACCESSORY_IDS]) {
        for (const legs of ["rest", "a", "b"] as const) {
          const rows = composeRows(state, acc, legs);
          expect(rows).toHaveLength(GRID);
          for (const r of rows) expect(r).toHaveLength(GRID);
        }
      }
    }
  });

  it("every accessory overlay has 12-wide rows inside the grid", () => {
    for (const id of ACCESSORY_IDS) {
      for (const [row, mask] of Object.entries(ACCESSORIES[id])) {
        expect(Number(row)).toBeGreaterThanOrEqual(0);
        expect(Number(row)).toBeLessThan(GRID);
        expect(mask).toHaveLength(GRID);
      }
    }
  });

  it("matches the classic idle body", () => {
    expect(composeRows("idle", null)).toEqual([...BASE]);
  });

  it("state faces read from the pixels", () => {
    expect(composeRows("done", null)[7]).toBe("..KWKWKWKS..");
    expect(composeRows("fail", null)[6]).toBe("..KWKWKWKS..");
    expect(composeRows("sleep", null)[7]).toBe("..KKWWKKWS..");
    expect(composeRows("wait", null)[0]).toBe(".........QQ.");
    expect(composeRows("walk", null, "a")[10]).toBe("..WS....WS..");
    expect(composeRows("walk", null, "b")[10]).toBe("....WSWS....");
  });

  it("face accessories bake the eyes in; head accessories leave them movable", () => {
    expect(eyesMovable("idle", "shades")).toBe(false);
    expect(eyesMovable("idle", "tophat")).toBe(true);
    expect(eyesMovable("done", null)).toBe(false);
  });

  it("snaps sizes to whole pixels", () => {
    expect([12, 24, 36, 48, 96].map(spriteScale)).toEqual([1, 2, 3, 4, 8]);
    expect(spriteScale(4)).toBe(1);
  });
});

describe("PixelSprite", () => {
  it("renders crisp, integer-scaled SVG", () => {
    const html = renderToStaticMarkup(<PixelSprite size={40} />);
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain("width:36px");
    expect(html).toContain('viewBox="0 0 12 12"');
  });

  it("chief wears the crown, others one accessory at most", () => {
    expect(renderToStaticMarkup(<PixelSprite chief />)).toContain('data-accessory="crown"');
    expect(renderToStaticMarkup(<PixelSprite accessory="cap" chief />)).toContain(
      'data-accessory="cap"',
    );
    expect(renderToStaticMarkup(<PixelSprite />)).not.toContain("data-accessory");
  });

  it("every state renders, with its mark where it has one", () => {
    for (const state of SPRITE_STATES) {
      expect(renderToStaticMarkup(<PixelSprite state={state} />)).toContain(
        `data-state="${state}"`,
      );
    }
    expect(renderToStaticMarkup(<PixelSprite state="wait" />)).toContain("px-mark");
    expect(renderToStaticMarkup(<PixelSprite state="sleep" />)).toContain("px-mark");
    expect(renderToStaticMarkup(<PixelSprite state="idle" />)).not.toContain("px-mark");
  });

  it("reduced motion and still add the static class", () => {
    expect(renderToStaticMarkup(<PixelSprite reducedMotion />)).toContain("px-sprite--reduced");
    expect(renderToStaticMarkup(<PixelSprite still />)).toContain("px-sprite--still");
  });
});

describe("sprite motion rule (sidebar ambient, content still, press to react)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mount = (el: React.ReactElement) => {
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(el);
    });
    return r;
  };

  const press = (root: ReturnType<typeof create>, button = 0) => {
    const span = root.root.findByType("span");
    act(() => span.props.onPointerDown({ button }));
    return () => root.root.findByType("span").props["data-reaction"];
  };

  it("is still by default and ambient only inside the nav provider", () => {
    expect(renderToStaticMarkup(<PixelSprite />)).toContain("px-sprite--still");
    expect(renderToStaticMarkup(<PixelSprite />)).toContain('data-motion="still"');
    const nav = renderToStaticMarkup(
      <SpriteMotionProvider value="ambient">
        <PixelSprite />
      </SpriteMotionProvider>,
    );
    expect(nav).not.toContain("px-sprite--still");
    expect(nav).toContain('data-motion="ambient"');
  });

  it("an explicit motion prop beats the context", () => {
    const html = renderToStaticMarkup(
      <SpriteMotionProvider value="ambient">
        <PixelSprite motion="still" />
      </SpriteMotionProvider>,
    );
    expect(html).toContain("px-sprite--still");
  });

  it("a still sprite keeps its state frame and ignores declarative reactions", () => {
    const html = renderToStaticMarkup(<PixelSprite state="wait" reaction="wave" />);
    expect(html).toContain('data-state="wait"');
    expect(html).toContain("px-mark");
    expect(html).not.toContain("data-reaction");
    const ambient = renderToStaticMarkup(
      <SpriteMotionProvider value="ambient">
        <PixelSprite reaction="wave" />
      </SpriteMotionProvider>,
    );
    expect(ambient).toContain('data-reaction="wave"');
  });

  it("pressing a still sprite plays one short reaction, then returns to the frame", () => {
    const root = mount(<PixelSprite state="done" />);
    expect(root.root.findByType("span").props["data-reaction"]).toBeUndefined();
    const reaction = press(root);
    expect(reaction()).toBe("press");
    act(() => {
      vi.advanceTimersByTime(PRESS_REACTION_MS - 1);
    });
    expect(reaction()).toBe("press");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(reaction()).toBeUndefined();
    root.unmount();
  });

  it("only the primary button reacts; inert (still prop) and reduced-motion sprites never do", () => {
    const root = mount(<PixelSprite />);
    expect(press(root, 2)()).toBeUndefined();
    root.unmount();
    for (const props of [{ still: true }, { reducedMotion: true }]) {
      const r = mount(<PixelSprite {...props} />);
      expect(r.root.findByType("span").props.onPointerDown).toBeUndefined();
      r.unmount();
    }
  });

  it("an ambient sprite has no press handler", () => {
    const root = mount(
      <SpriteMotionProvider value="ambient">
        <PixelSprite />
      </SpriteMotionProvider>,
    );
    expect(root.root.findByType("span").props.onPointerDown).toBeUndefined();
    root.unmount();
  });
});

describe("icon script", () => {
  it("make-icons.py carries the same body rows as BASE", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const py = fs.readFileSync(
      path.join(here, "../../../../../scripts/brand/make-icons.py"),
      "utf8",
    );
    for (const row of BASE) expect(py).toContain(`"${row}"`);
  });
});
