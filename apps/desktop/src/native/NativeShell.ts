import * as Electron from "electron";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { REMOTE_CAPABLE_EDITOR_IDS, remoteSchemeForEditor } from "@kora/contracts";

/**
 * Links Kora hands to the OS: web pages, and remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`,
 * `zed://ssh/<host>/<path>`), which must reach the editor. Any other scheme (file:, a random app's handler) stays
 * blocked, and so does a remote link carrying credentials in it.
 */
const WEB = new Set(["http:", "https:"]);
const EDITOR_SCHEMES = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.map((id) => remoteSchemeForEditor(id))
    .filter((s): s is string => !!s)
    .map((s) => `${s}:`),
);
const VSCODE_REMOTE_PREFIX = "/ssh-remote+";

/** Is this a well-formed remote-editor link of the shape its scheme uses? */
function remoteEditorLink(u: URL): boolean {
  if (!EDITOR_SCHEMES.has(u.protocol) || u.username || u.password) return false;
  if (u.protocol === "zed:") {
    // zed://ssh/<host>/<path>: the host is the first path segment, so userinfo there is refused too.
    const [, host, ...rest] = u.pathname.split("/");
    return u.host === "ssh" && !!host && !/[@:]/.test(host) && rest.length > 0;
  }
  return (
    u.host === "vscode-remote" &&
    u.pathname.startsWith(VSCODE_REMOTE_PREFIX) &&
    u.pathname.length > VSCODE_REMOTE_PREFIX.length
  );
}

export function parseSafeExternalUrl(urlText: unknown): Option.Option<string> {
  if (typeof urlText !== "string") return Option.none();
  let u: URL;
  try {
    u = new URL(urlText);
  } catch {
    return Option.none();
  }
  return WEB.has(u.protocol) || remoteEditorLink(u) ? Option.some(u.href) : Option.none();
}

export class NativeShell extends Context.Service<
  NativeShell,
  {
    readonly openExternal: (urlText: unknown) => Effect.Effect<boolean>;
    readonly copyText: (str: string) => Effect.Effect<void>;
  }
>()("@kora/desktop/native/NativeShell") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = NativeShell.of({
  // true only when the OS accepted the link; an unsafe link is never handed over.
  openExternal: (urlText) => {
    const safe = parseSafeExternalUrl(urlText);
    if (Option.isNone(safe)) return Effect.succeed(false);
    return Effect.promise(() =>
      Electron.shell.openExternal(safe.value).then(
        () => true,
        () => false,
      ),
    );
  },
  copyText: (str) => Effect.promise(() => Electron.clipboard.writeText(str).catch(() => undefined)),
});

export const layer = Layer.succeed(NativeShell, make);
