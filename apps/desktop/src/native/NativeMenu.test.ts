import { assert, describe, it } from "@effect/vitest";
import { MachinePlatform } from "@kora/shared/hostMachine";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

type Template = Electron.MenuItemConstructorOptions[];

const menus = vi.hoisted(() => ({
  build: vi.fn(),
  setApplication: vi.fn(),
  namedImage: vi.fn(),
}));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: menus.build, setApplicationMenu: menus.setApplication },
  nativeImage: { createFromNamedImage: menus.namedImage },
}));

import * as NativeMenu from "./NativeMenu.ts";

/**
 * What the "user" does when the menu pops up: click the item with this label, or close the menu.
 * Records every template built and every popup() call.
 */
function scriptMenu(action: { click: string } | "dismiss") {
  const built: Template[] = [];
  const popups: Electron.PopupOptions[] = [];
  menus.build.mockImplementation((template: Template) => {
    built.push(template);
    return {
      popup: (opts: Electron.PopupOptions) => {
        popups.push(opts);
        if (action === "dismiss") return opts.callback?.();
        const item = template.find((i) => i.label === action.click);
        item?.click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      },
    };
  });
  return { built, popups };
}

const shape = (template: Template) => template.map((i) => i.type ?? i.label);
const windowAt = (zoom = 1, id = 7) =>
  ({ id, webContents: { getZoomFactor: () => zoom } }) as unknown as Electron.BrowserWindow;
const withMenu = <A, E>(body: (m: NativeMenu.NativeMenu["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(NativeMenu.NativeMenu, body).pipe(
    Effect.provide(NativeMenu.layer.pipe(Layer.provide(Layer.succeed(MachinePlatform, "linux")))),
  );

const menuDefect = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) throw new Error("expected the menu operation to die");
    const error = Cause.squash(exit.cause);
    assert.instanceOf(error, NativeMenu.NativeMenuOperationError);
    return error as NativeMenu.NativeMenuOperationError;
  });

beforeEach(() => {
  for (const spy of Object.values(menus)) spy.mockReset();
});

describe("context menus", () => {
  it.effect("nothing usable to show: no menu is built and the answer is none", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const choice = yield* m.showContextMenu({
          window: windowAt(),
          items: [],
          position: Option.none(),
        });
        assert.isTrue(Option.isNone(choice));
        assert.lengthOf(menus.build.mock.calls, 0);
      }),
    ),
  );

  it.effect("answers with the id of the item the user clicked", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        scriptMenu({ click: "Rename" });
        const choice = yield* m.showContextMenu({
          window: windowAt(),
          items: [
            { id: "open", label: "Open" },
            { id: "rename", label: "Rename" },
          ],
          position: Option.none(),
        });
        assert.isTrue(Option.contains(choice, "rename"));
      }),
    ),
  );

  it.effect(
    "closing the menu answers none; the anchor is scaled by the page zoom and floored",
    () =>
      withMenu((m) =>
        Effect.gen(function* () {
          const { built, popups } = scriptMenu("dismiss");
          const choice = yield* m.showContextMenu({
            window: windowAt(1.5),
            items: [
              { id: "copy", label: "Copy" },
              { id: "remove", label: "Remove", destructive: true, separatorBefore: true },
            ],
            position: Option.some({ x: 11.9, y: 30.4 }),
          });
          assert.isTrue(Option.isNone(choice));
          assert.deepEqual([popups[0]?.x, popups[0]?.y], [17, 45]);
          assert.deepEqual(shape(built[0]!), ["Copy", "separator", "Remove"]);
          const { click, ...plain } = built[0]![0]!;
          assert.isFunction(click);
          assert.deepEqual(plain, { label: "Copy", enabled: true });
        }),
      ),
  );

  it.effect("an anchor that is negative or not finite is ignored rather than clamped", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const { popups } = scriptMenu("dismiss");
        yield* m.showContextMenu({
          window: windowAt(),
          items: [{ id: "a", label: "A" }],
          position: Option.some({ x: -4, y: 9 }),
        });
        assert.notProperty(popups[0], "x");
        assert.notProperty(popups[0], "y");
      }),
    ),
  );

  it.effect("an explicit section keeps the action before a destructive item together", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const { built } = scriptMenu("dismiss");
        yield* m.showContextMenu({
          window: windowAt(),
          items: [
            { id: "copy", label: "Copy" },
            { id: "pin", label: "Pin", separatorBefore: true },
            { id: "trash", label: "Trash", destructive: true },
          ],
          position: Option.none(),
        });
        assert.deepEqual(shape(built[0]!), ["Copy", "separator", "Pin", "Trash"]);
      }),
    ),
  );

  it.effect("a destructive item without a section still gets its own separator", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const { built } = scriptMenu("dismiss");
        yield* m.showContextMenu({
          window: windowAt(),
          items: [
            { id: "copy", label: "Copy" },
            { id: "trash", label: "Trash", destructive: true },
          ],
          position: Option.none(),
        });
        assert.deepEqual(shape(built[0]!), ["Copy", "separator", "Trash"]);
      }),
    ),
  );
});

describe("template popups", () => {
  it.effect("nothing happens until the effect runs, then the menu pops up in the given frame", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const shown = vi.fn();
        menus.build.mockImplementation(() => ({ popup: shown }));
        const frame = { routingId: 3 } as Electron.WebFrameMain;
        const pending = m.popupTemplate({
          window: windowAt(),
          template: [{ label: "Paste" }],
          frame,
        });
        assert.deepEqual([menus.build.mock.calls.length, shown.mock.calls.length], [0, 0]);
        yield* pending;
        assert.deepEqual([menus.build.mock.calls.length, shown.mock.calls.length], [1, 1]);
        assert.strictEqual(shown.mock.calls[0]?.[0].frame, frame);
      }),
    ),
  );

  it.effect("an empty template does nothing", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        yield* m.popupTemplate({ window: windowAt(), template: [] });
        assert.lengthOf(menus.build.mock.calls, 0);
      }),
    ),
  );
});

describe("failures inside Electron die with what was attempted", () => {
  it.effect("setting the application menu", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const boom = new Error("menu build broke");
        menus.build.mockImplementationOnce(() => {
          throw boom;
        });
        const error = yield* menuDefect(
          m.setApplicationMenu([{ label: "File" }, { label: "View" }]),
        );
        assert.deepInclude(error, {
          operation: "set-application-menu",
          platform: "linux",
          windowId: null,
          itemCount: 2,
        });
        assert.strictEqual(error.cause, boom);
        assert.notInclude(error.message, boom.message);
      }),
    ),
  );

  it.effect("popping up a template", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const boom = new Error("popup broke");
        menus.build.mockReturnValueOnce({
          popup: () => {
            throw boom;
          },
        });
        const error = yield* menuDefect(
          m.popupTemplate({ window: windowAt(1, 41), template: [{ label: "Paste" }] }),
        );
        assert.deepInclude(error, { operation: "popup-template", windowId: 41, itemCount: 1 });
        assert.strictEqual(error.cause, boom);
      }),
    ),
  );

  it.effect("showing a context menu counts only the items that survived cleaning", () =>
    withMenu((m) =>
      Effect.gen(function* () {
        const boom = new Error("context build broke");
        menus.build.mockImplementationOnce(() => {
          throw boom;
        });
        const error = yield* menuDefect(
          m.showContextMenu({
            window: windowAt(1, 42),
            items: [
              { id: "copy", label: "Copy" },
              { id: "h", label: "Heading", header: true },
            ],
            position: Option.none(),
          }),
        );
        assert.deepInclude(error, { operation: "show-context-menu", windowId: 42, itemCount: 1 });
        assert.strictEqual(error.cause, boom);
      }),
    ),
  );
});
