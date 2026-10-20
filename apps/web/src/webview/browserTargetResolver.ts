import { isLoopbackHost, normalizeWebUrl } from "@kora/shared/webUrl";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@kora/shared/hostnames";
import type { BrowserNavigationTarget, HostId, WebUrlResolution } from "@kora/contracts";

import { readPreparedLink } from "~/atoms/session";

export {
  canonicalHostname,
  isPublicFaviconHost,
  isPrivateNetworkHost,
  isLocalLoopbackHost,
} from "@kora/shared/hostnames";

const readHostUrl = (hostKey: HostId): URL => {
  const connection = readPreparedLink(hostKey);
  if (!connection) throw new Error(`Environment ${hostKey} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

const resolveHostPortTarget = (
  hostKey: HostId,
  dest: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  hostUrl: URL,
  requestedUrl?: string,
  sourceUrl?: URL,
): WebUrlResolution => {
  if (!isPrivateNetworkHost(hostUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const protocol = dest.protocol ?? "http";
  const loc = dest.path?.startsWith("/") ? dest.path : `/${dest.path ?? ""}`;
  const normalizedHostUrlHost = hostUrl.hostname.replace(/^\[|\]$/g, "");
  // Local loopback environments should advertise `localhost` so Chromium
  // dual-stack lookup can reach a Vite server bound only to ::1 or 127.0.0.1.
  const resolvedHost = isLocalLoopbackHost(normalizedHostUrlHost)
    ? "localhost"
    : normalizedHostUrlHost.includes(":")
      ? `[${normalizedHostUrlHost}]`
      : normalizedHostUrlHost;
  const settled = sourceUrl
    ? new URL(sourceUrl)
    : new URL(loc, `${protocol}://${resolvedHost}:${dest.port}`);
  if (sourceUrl) {
    settled.hostname = resolvedHost;
    settled.port = String(dest.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${dest.port}${loc}`,
    resolvedUrl: settled.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedHostUrlHost)
      ? "direct"
      : "direct-private-network",
    hostId: hostKey,
  };
};

export function resolveDiscoveredDaemonUrl(hostKey: HostId, urlText: string): string {
  try {
    const normalizedUrl = normalizeWebUrl(urlText);
    const decoded = new URL(normalizedUrl);
    if (!isLoopbackHost(decoded.hostname)) return normalizedUrl;
    return resolveHostPortTarget(
      hostKey,
      {
        kind: "environment-port",
        port: Number(decoded.port || (decoded.protocol === "https:" ? 443 : 80)),
        protocol: decoded.protocol === "https:" ? "https" : "http",
        path: `${decoded.pathname}${decoded.search}${decoded.hash}`,
      },
      readHostUrl(hostKey),
      urlText,
      decoded,
    ).resolvedUrl;
  } catch {
    return urlText;
  }
}
