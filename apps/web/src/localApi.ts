import type { ConfirmDialogOptions, ContextMenuItem, LocalApi } from "@kora/contracts";

import { dismissContextMenu, showContextMenuFallback } from "./inPageContextMenu";
import { askToConfirm } from "./confirm";
import { readBrowserClientPrefs, writeBrowserClientPrefs } from "./browserPrefsStorage";

let cachedApi: LocalApi | undefined;

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (opts) => {
        if (!window.shellBridge) return null;
        return window.shellBridge.pickFolder(opts);
      },
      confirm: async (msg, opts?: ConfirmDialogOptions) => {
        return askToConfirm(msg, opts) ?? false;
      },
    },
    shell: {
      openExternal: async (address) => {
        if (window.shellBridge) {
          const opened = await window.shellBridge.openExternal(address);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(address, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <Item extends string>(
        elems: readonly ContextMenuItem<Item>[],
        place?: { x: number; y: number },
      ): Promise<Item | null> => {
        if (window.shellBridge) {
          return window.shellBridge.showContextMenu(elems, place) as Promise<Item | null>;
        }
        return showContextMenuFallback(elems, place);
      },
      // A native desktop menu blocks keyboard input and closes on outside
      // interaction, so nothing to do there; the DOM fallback needs an explicit
      // dismiss when the state behind it goes away.
      close: async () => {
        if (!window.shellBridge) {
          dismissContextMenu();
        }
      },
    },
    persistence: {
      getClientPrefs: async () => {
        if (window.shellBridge) {
          return window.shellBridge.getClientPrefs();
        }
        return readBrowserClientPrefs();
      },
      setClientPrefs: async (conf) => {
        if (window.shellBridge) {
          return window.shellBridge.setClientPrefs(conf);
        }
        writeBrowserClientPrefs(conf);
      },
    },
  };
}

export const createLocalApi = (): LocalApi => createBrowserLocalApi();

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (cachedApi ??= createLocalApi());
}

export function localApiOrThrow(): LocalApi {
  const apiClient = readLocalApi();
  if (!apiClient) {
    throw new Error("Local API not found");
  }
  return apiClient;
}
