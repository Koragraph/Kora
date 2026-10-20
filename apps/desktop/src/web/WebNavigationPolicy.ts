/**
 * Where preview `<webview>` guests may be pointed by the host, and how a guest
 * is hardened when it attaches. Electron-free so it is unit-testable.
 *
 * A guest renders arbitrary web content (isolated, sandboxed picker preload;
 * see WebviewPreferences.ts). Host-driven loads (`webContents.loadURL`, the `<webview src>` attribute) are
 * browser-initiated, so they skip Chromium's renderer-side bans on top-level
 * `file:`, `data:` and `javascript:` navigations. Every host-driven entry point
 * therefore admits only web URLs: a `file://` document in Electron can read
 * other local files, and a third-party page must not be able to steer its own
 * tab there (e.g. `window.open("file:///…", "_blank")`).
 */

const WEB_PROTOCOLS = new Set(["http:", "https:"]);

/** http(s), `about:blank`, and `blob:` URLs created by an http(s) page. */
export function isWebTabNavigationUrl(urlText: unknown): boolean {
  if (typeof urlText !== "string") return false;
  try {
    const address = new URL(urlText);
    if (WEB_PROTOCOLS.has(address.protocol)) return true;
    if (address.href === "about:blank") return true;
    if (address.protocol === "blob:") return WEB_PROTOCOLS.has(new URL(address.pathname).protocol);
    return false;
  } catch {
    return false;
  }
}

/** The subset of Electron's WebPreferences the attach hardening pins. */
export interface WebviewAttachPreferences {
  preload?: string;
  sandbox?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  nodeIntegrationInWorker?: boolean;
  contextIsolation?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  experimentalFeatures?: boolean;
  enableBlinkFeatures?: string;
  webviewTag?: boolean;
}

/**
 * Pins a preview guest's security posture in `will-attach-webview`, whatever
 * the `<webview>` element asked for. Returns false when the attach must be
 * refused (unknown partition). Mutates `webPreferences` and `params` in place,
 * which is how Electron takes the overrides.
 */
export function hardenWebviewAttach(request: {
  readonly webPreferences: WebviewAttachPreferences;
  readonly params: Record<string, string>;
  readonly isBrowserPartition: (partName: string) => boolean;
  readonly pickPreloadPath: string;
}): boolean {
  const { webPreferences, params } = request;
  if (typeof params.partition !== "string" || !request.isBrowserPartition(params.partition)) {
    return false;
  }
  Object.assign(webPreferences, {
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegration: false,
    sandbox: true,
  });
  // The picker preload runs isolated; React context comes from a main-world
  // script that only exchanges strings with it (PickMainWorldProtocol.ts).
  webPreferences.contextIsolation = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.experimentalFeatures = false;
  webPreferences.webviewTag = false;
  delete webPreferences.enableBlinkFeatures;
  // A guest may only ever run the app's own picker preload: an attacker-chosen
  // `preload` attribute must never execute in a third-party page.
  if (webPreferences.preload !== undefined) webPreferences.preload = request.pickPreloadPath;
  if (params.src !== undefined && params.src !== "" && !isWebTabNavigationUrl(params.src)) {
    params.src = "about:blank";
  }
  return true;
}

/** A popup window's title: the scheme + host it is on, never anything the page chooses. */
export function popupOriginTitle(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:")
      return `${u.protocol === "https:" ? "" : "Not secure \u2014 "}${u.host}`;
    return u.protocol.replace(/:$/, "") || "about:blank";
  } catch {
    return "about:blank";
  }
}
