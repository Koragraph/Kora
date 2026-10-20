import * as Electron from "electron";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { MachinePlatform } from "@kora/shared/hostMachine";
import type { ContextMenuItem } from "@kora/contracts";

export interface NativeMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface NativeMenuContextInput {
  readonly window: Electron.BrowserWindow;
  readonly items: readonly ContextMenuItem[];
  readonly position: Option.Option<NativeMenuPosition>;
}

export interface NativeMenuTemplateInput {
  readonly frame?: Electron.WebFrameMain;
  readonly template: readonly Electron.MenuItemConstructorOptions[];
  readonly window: Electron.BrowserWindow;
}

export class NativeMenuOperationError extends Schema.TaggedError<NativeMenuOperationError>()(
  "NativeMenuOperationError",
  {
    cause: Schema.Defect(),
    itemCount: Schema.Number,
    windowId: Schema.NullOr(Schema.Number),
    platform: Schema.String,
    operation: Schema.Literals(["set-application-menu", "popup-template", "show-context-menu"]),
  },
) {
  override get message() {
    const win = this.windowId === null ? "" : ` for window ${this.windowId}`;
    return `Electron menu operation "${this.operation}" failed${win} with ${this.itemCount} items on ${this.platform}.`;
  }
}

export class NativeMenu extends Context.Service<
  NativeMenu,
  {
    /** Resolves with the id of the chosen item, or none when the menu closed without a choice. */
    readonly showContextMenu: (
      request: NativeMenuContextInput,
    ) => Effect.Effect<Option.Option<string>>;
    readonly popupTemplate: (request: NativeMenuTemplateInput) => Effect.Effect<void>;
    readonly setApplicationMenu: (
      template: ReadonlyArray<Electron.MenuItemConstructorOptions>,
    ) => Effect.Effect<void>;
  }
>()("@kora/desktop/native/NativeMenu") {}

/** A context-menu entry reduced to what the native menu can show. */
interface CleanItem {
  readonly id: string;
  readonly label: string;
  readonly destructive: boolean;
  readonly disabled: boolean;
  readonly separatorBefore: boolean;
  readonly children?: readonly CleanItem[];
}

function cleanItems(elems: readonly ContextMenuItem[]): CleanItem[] {
  const cleaned: CleanItem[] = [];
  for (const item of elems) {
    if (typeof item.id !== "string" || typeof item.label !== "string") continue;
    // Section headers are only for the web fallback menu.
    if (item.header) continue;
    let children: CleanItem[] | undefined;
    if (item.children) {
      children = cleanItems(item.children);
      if (children.length === 0) continue;
    }
    cleaned.push({
      id: item.id,
      label: item.label,
      destructive: Boolean(item.destructive),
      disabled: Boolean(item.disabled),
      separatorBefore: item.separatorBefore === true,
      ...(children ? { children } : {}),
    });
  }
  return cleaned;
}

const make = Effect.gen(function* () {
  const hostOs = yield* MachinePlatform;

  let trashIcon: Electron.NativeImage | null | undefined;
  const destructiveIcon = (): Electron.NativeImage | undefined => {
    if (hostOs !== "darwin") return undefined;
    if (trashIcon === undefined) {
      try {
        const img = Electron.nativeImage.createFromNamedImage("trash", [-1, 0, 1]);
        if (img.isEmpty()) {
          trashIcon = null;
        } else {
          trashIcon = img.resize({ width: 12, height: 12 });
          trashIcon.setTemplateImage(true);
        }
      } catch {
        trashIcon = null;
      }
    }
    return trashIcon ?? undefined;
  };

  const buildTemplate = (
    elems: readonly CleanItem[],
    choose: (id: string) => void,
  ): Electron.MenuItemConstructorOptions[] => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    const endsWithSeparator = () => template.at(-1)?.type === "separator";
    const addSeparator = () => {
      if (template.length > 0 && !endsWithSeparator()) template.push({ type: "separator" });
    };
    let explicitSection = false;
    let destructiveSeen = false;

    for (const item of elems) {
      if (item.separatorBefore) {
        addSeparator();
        explicitSection = true;
      } else if (item.destructive && !destructiveSeen && !explicitSection) {
        addSeparator();
      }
      if (item.destructive) destructiveSeen = true;

      if (item.children) {
        template.push({
          label: item.label,
          enabled: !item.disabled,
          submenu: buildTemplate(item.children, choose),
        });
        continue;
      }
      const icon = item.destructive ? destructiveIcon() : undefined;
      template.push({
        label: item.label,
        enabled: !item.disabled,
        ...(icon ? { icon } : {}),
        click: () => choose(item.id),
      });
    }
    return template;
  };

  const fail = (
    operation1: NativeMenuOperationError["operation"],
    windowId: number | null,
    itemCount: number,
    reason: unknown,
  ) =>
    new NativeMenuOperationError({
      operation: operation1,
      platform: hostOs,
      windowId,
      itemCount,
      cause: reason,
    });

  return NativeMenu.of({
    setApplicationMenu: (template) =>
      Effect.try({
        try: () =>
          Electron.Menu.setApplicationMenu(
            Electron.Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]),
          ),
        catch: (reason) => fail("set-application-menu", null, template.length, reason),
      }).pipe(Effect.orDie),

    popupTemplate: ({ window, template, frame }) =>
      template.length === 0
        ? Effect.void
        : Effect.try({
            try: () => {
              const menu = Electron.Menu.buildFromTemplate(
                template as Electron.MenuItemConstructorOptions[],
              );
              menu.popup({ window, ...(frame ? { frame } : {}) });
            },
            catch: (reason) => fail("popup-template", window.id, template.length, reason),
          }).pipe(Effect.orDie),

    showContextMenu: ({ window, items, position }) => {
      const cleaned = cleanItems(items);
      if (cleaned.length === 0) return Effect.succeed(Option.none<string>());

      return Effect.callback<Option.Option<string>>((resume) => {
        let settled = false;
        const settle = (choice: Option.Option<string>) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(choice));
        };
        try {
          const menu = Electron.Menu.buildFromTemplate(
            buildTemplate(cleaned, (id) => settle(Option.some(id))),
          );
          // The renderer measures in CSS pixels; popup() wants window points, which differ by the page zoom.
          const zoomLevel = window.webContents.getZoomFactor();
          const anch = Option.filter(
            position,
            (point) =>
              Number.isFinite(point.x) &&
              Number.isFinite(point.y) &&
              point.x >= 0 &&
              point.y >= 0 &&
              Number.isFinite(zoomLevel),
          );
          menu.popup({
            window,
            ...(Option.isSome(anch)
              ? { x: Math.floor(anch.value.x * zoomLevel), y: Math.floor(anch.value.y * zoomLevel) }
              : {}),
            callback: () => settle(Option.none()),
          });
        } catch (reason) {
          if (!settled) {
            settled = true;
            resume(Effect.die(fail("show-context-menu", window.id, cleaned.length, reason)));
          }
        }
      });
    },
  });
});

export const layer = Layer.effect(NativeMenu, make);
