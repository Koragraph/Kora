/**
 * MAIN-WORLD half of the element picker. This file is NOT part of any preload
 * bundle: `scripts/pick-main-world-plugin.ts` bundles it (with react-grab) into
 * a self-contained IIFE string, and `PickPreload.ts` evaluates that string in
 * the page's main world at document start via `webFrame.executeJavaScript`.
 *
 * Importing react-grab installs its React DevTools hook as a side effect, which
 * has to happen before the page's React boots for component names to resolve.
 *
 * It holds no Kora capability: no ipcRenderer, no Electron, nothing from the
 * isolated preload. It exposes exactly one function (see `install`) that maps a
 * token string to a JSON string. See `PickMainWorldProtocol.ts`.
 */
import { getElementContext } from "react-grab/primitives";

import {
  PICK_TARGET_ATTRIBUTE,
  isPickMainWorldKey,
  isPickToken,
  projectElementContext,
} from "./PickMainWorldProtocol.ts";

export function install(key: string): void {
  if (!isPickMainWorldKey(key)) return;
  // Captured at document start, before any page script can replace them.
  const stringify = JSON.stringify;
  const querySelector = Document.prototype.querySelector;
  const read = async (token: unknown): Promise<string | null> => {
    if (!isPickToken(token)) return null;
    const element = querySelector.call(document, `[${PICK_TARGET_ATTRIBUTE}="${token}"]`);
    if (!element) return null;
    const context = await getElementContext(element);
    return stringify(projectElementContext(context));
  };
  Object.defineProperty(globalThis, key, {
    value: read,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
