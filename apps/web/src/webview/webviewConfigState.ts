import { useAtomValue } from "@effect/atom-react";
import type { HostId, ShellWebBridge, ShellWebviewConfig } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";

import { webBridge } from "~/components/web/webBridge";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

export class WebviewBridgeUnavailableError extends Schema.TaggedError<WebviewBridgeUnavailableError>()(
  "WebviewBridgeUnavailableError",
  { hostId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.hostId}".`;
  }
}

export class WebviewConfigLoadError extends Schema.TaggedError<WebviewConfigLoadError>()(
  "WebviewConfigLoadError",
  { hostId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.hostId}".`;
  }
}

export const WebviewConfigError = Schema.Union([
  WebviewBridgeUnavailableError,
  WebviewConfigLoadError,
]);
export type WebviewConfigError = typeof WebviewConfigError.Type;

export const loadWebviewConfig = (
  hostId: HostId,
  profileId?: string,
  bridge: Pick<ShellWebBridge, "getWebConfig"> | null = webBridge,
): Effect.Effect<ShellWebviewConfig, WebviewConfigError> => {
  if (bridge === null) return Effect.fail(new WebviewBridgeUnavailableError({ hostId }));
  return Effect.tryPromise({
    try: () => bridge.getWebConfig(hostId, profileId),
    catch: (cause) => new WebviewConfigLoadError({ hostId, cause }),
  });
};

// One string key: an object key would allocate a new family entry on every render. The profile
// is the tail, so a profile id that contains the delimiter still round-trips whole.
const configKey = (hostId: HostId, profileId?: string) => `${hostId}\u0000${profileId ?? ""}`;

function parseConfigKey(key: string): { hostId: HostId; profileId: string | undefined } {
  const at = key.indexOf("\u0000");
  const profile = key.slice(at + 1);
  return { hostId: key.slice(0, at) as HostId, profileId: profile === "" ? undefined : profile };
}

const webviewConfigAtom = Atom.family((key: string) => {
  const { hostId, profileId } = parseConfigKey(key);
  return Atom.make(loadWebviewConfig(hostId, profileId)).pipe(
    Atom.swr({ staleTime: FIVE_MINUTES_MS, revalidateOnMount: true }),
    Atom.setIdleTTL(TEN_MINUTES_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

export function useWebviewConfig(hostId: HostId, profileId?: string): ShellWebviewConfig | null {
  const result = useAtomValue(webviewConfigAtom(configKey(hostId, profileId)));
  return Option.getOrNull(AsyncResult.value(result));
}
