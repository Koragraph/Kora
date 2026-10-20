/**
 * webPreferences override applied to every preview `<webview>` element via
 * its `webpreferences="..."` attribute. Single source of truth so all guest
 * surfaces inherit the same security posture.
 *
 * Lives in its own electron-free module so the value is unit-testable
 * without importing `Manager.ts` (which transitively imports
 * `electron` and blows up under vitest).
 *
 * - `contextIsolation=true`: the picker preload (`PickPreload.ts`) runs in an
 *   isolated world, so a hostile page cannot reach its `ipcRenderer` (e.g. by
 *   tampering with shared builtins). React component names are read by a
 *   separate main-world script that only ever exchanges plain strings with the
 *   preload (`PickMainWorldProtocol.ts`).
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled. Without it
 *   the preload would have full Node access (`require`, `fs`,
 *   `child_process`, ...). In sandboxed mode Electron still synthesizes the
 *   `electron` module for the preload's `import { ipcRenderer, webFrame }`.
 * - `nodeIntegration=false`: pinned for clarity (the page itself never gets
 *   Node access).
 *
 * Format notes (locked down by `WebviewPreferences.test.ts`):
 * - Whitespace-free. Electron's webpreferences parser splits on `,` and
 *   does not trim, so a leading space would turn a key into an unknown one
 *   and silently drop it.
 * - Values are JS-boolean strings (`true`/`false`) — `yes`/`no` are not
 *   special-cased by the parser; `value="no"` becomes the truthy STRING
 *   `"no"` when assigned to a boolean webPreferences key.
 *
 * Defense in depth: `apps/desktop/src/main.ts` also runs a
 * `will-attach-webview` handler (`hardenWebviewAttach`) that force-sets
 * `sandbox: true`, `contextIsolation: true` and `nodeIntegration*: false` on
 * the actual webPreferences object, gated on
 * the preview partition, so even if this string is ever wrong, the
 * security-critical flags can't regress on preview tabs.
 */
export const WEBVIEW_PREFERENCES = "contextIsolation=true,sandbox=true,nodeIntegration=false";
