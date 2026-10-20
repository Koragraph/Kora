// The parts of the main window and the application menu that differ by OS. macOS keeps exactly what it had: an inset
// hidden title bar with the traffic lights centred in Kora's top bar, and the app-name menu. Windows has no traffic
// lights: `titleBarStyle: "hidden"` alone removes the caption buttons, so the window gets a Window Controls Overlay
// (native minimise / maximise / close drawn over the top bar; the web client already reserves room for it through
// the `.wco` class and `env(titlebar-area-*)`). The menu bar is hidden with the frame, so the menu only carries the
// accelerators there; macOS-only roles (Services, Hide, Speech) are dropped and Finder reads as Explorer.
import type * as Electron from "electron";

/** `--workspace-topbar-height` in the web client. */
export const TOPBAR_HEIGHT = 52;
export const TRAFFIC_LIGHT_SIZE = 14;
export const TRAFFIC_LIGHT_X = 16;

const OVERLAY = {
  dark: { color: "#000000", symbolColor: "#f2f2f4" },
  light: { color: "#efeff1", symbolColor: "#000000" },
} as const;

/** Title-bar options of the main window. */
export function mainWindowChrome(
  platform: NodeJS.Platform,
  dark: boolean,
): Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"
> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: TRAFFIC_LIGHT_X,
        y: Math.round(TOPBAR_HEIGHT / 2 - TRAFFIC_LIGHT_SIZE / 2),
      },
    };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { ...(dark ? OVERLAY.dark : OVERLAY.light), height: TOPBAR_HEIGHT },
    };
  }
  return {}; // Linux: the native frame and its own buttons.
}

/** The native file manager's name, as menu items say it. */
export function fileManagerName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Finder";
  return platform === "win32" ? "File Explorer" : "File Manager";
}

const MAC_ONLY_ROLES = new Set<string>([
  "services",
  "hide",
  "hideOthers",
  "unhide",
  "startSpeaking",
  "stopSpeaking",
]);

type MenuItem = Electron.MenuItemConstructorOptions;

const isDivider = (item: MenuItem) => item.type === "separator";

/** Drop leading, trailing and doubled separators left behind by removed items. */
function tidy(items: readonly MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (isDivider(item) && (out.length === 0 || isDivider(out[out.length - 1]!))) continue;
    out.push(item);
  }
  while (out.length > 0 && isDivider(out[out.length - 1]!)) out.pop();
  return out;
}

function withoutMacOnly(items: readonly MenuItem[]): MenuItem[] {
  return tidy(
    items
      .filter((item) => !(item.role && MAC_ONLY_ROLES.has(item.role)))
      .filter((item) => !(item.label === "Speech" && Array.isArray(item.submenu)))
      .map((item) =>
        Array.isArray(item.submenu) ? { ...item, submenu: withoutMacOnly(item.submenu) } : item,
      ),
  );
}

/**
 * The macOS template (app-name menu first) shaped for `platform`. macOS: returned as is. Elsewhere the app-name menu
 * is folded into File (Settings, Check for Updates, Close, Quit), About moves to Help, macOS-only roles go, and
 * "… in Finder" names this OS's file manager.
 */
export function shapeMenuForPlatform(
  template: readonly MenuItem[],
  platform: NodeJS.Platform,
): MenuItem[] {
  if (platform === "darwin") return [...template];
  const [appMenu, ...rest] = template;
  const appItems = Array.isArray(appMenu?.submenu) ? appMenu.submenu : [];
  const about = appItems.filter((item) => item.role === "about");
  const quit = appItems.filter((item) => item.role === "quit");
  const fileExtras = appItems.filter((item) => item.role !== "about" && item.role !== "quit");
  const finder = fileManagerName(platform);
  const shaped = rest.map((menu): MenuItem => {
    const sub = Array.isArray(menu.submenu) ? menu.submenu : null;
    if (menu.label === "File" && sub) {
      return { ...menu, submenu: [...fileExtras, { type: "separator" }, ...sub, ...quit] };
    }
    if (menu.role === "help" && sub) {
      const renamed = sub.map((item) =>
        typeof item.label === "string" && item.label.endsWith(" in Finder")
          ? { ...item, label: item.label.replace(/ in Finder$/, ` in ${finder}`) }
          : item,
      );
      return {
        ...menu,
        submenu: [...renamed, ...(about.length ? [{ type: "separator" as const }] : []), ...about],
      };
    }
    return menu;
  });
  return withoutMacOnly(shaped);
}
