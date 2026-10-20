// @effect-diagnostics nodeBuiltinImport:off -- Vite dev-server config code (plain Node), not an Effect program.
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * The kora daemon refuses `/ws` and `/api/*` without its UI secret (`<kora home>/ui-token`) and refuses any foreign
 * Origin (packages/ui-server/src/localAuth.ts). In single-origin browser dev this proxy is the page's trusted hop: for
 * a request from the dev server's OWN origin it drops the Origin header and adds the secret. A foreign page's
 * requests keep their Origin (the daemon then refuses them) and cross-site no-Origin requests get no secret. Vite's
 * `allowedHosts` check runs first, so a DNS-rebound hostname never reaches this.
 */
/**
 * Only a caller on this machine may receive the daemon secret. With HOST set to a LAN/Tailscale address the dev
 * server accepts peers from other machines, and a no-Origin request (curl, a script) from one of them would
 * otherwise be handed the secret.
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export function authorizeDevProxy(proxy: {
  on(event: "proxyReq" | "proxyReqWs", fn: (...args: never[]) => void): unknown;
}): void {
  const tokenFile = NodePath.join(
    process.env.KORA_HOME || NodePath.join(NodeOS.homedir(), ".kora"),
    "ui-token",
  );
  const apply = (proxyReq: NodeHttp.ClientRequest, req: NodeHttp.IncomingMessage) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const sameOrigin =
      origin !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
    const fetchSite = req.headers["sec-fetch-site"];
    const trusted =
      sameOrigin ||
      (origin === undefined &&
        (fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none"));
    if (!trusted || !isLoopbackRemoteAddress(req.socket?.remoteAddress)) return;
    if (sameOrigin) proxyReq.removeHeader("origin");
    try {
      proxyReq.setHeader("x-kora-ui-token", NodeFS.readFileSync(tokenFile, "utf8").trim());
    } catch {
      /* no daemon secret yet: the daemon answers 401 and the client retries */
    }
  };
  proxy.on("proxyReq", apply as (...args: never[]) => void);
  proxy.on("proxyReqWs", apply as (...args: never[]) => void);
  // When the daemon goes away, close the browser's socket at once so the page sees the close event now (the proxy
  // otherwise leaves it half open for ~20 s and the "Offline" chip is late). Dev proxy only; the desktop app connects directly.
  proxy.on("proxyReqWs", ((proxyReq: NodeHttp.ClientRequest, _req: unknown, socket: NodeNet.Socket) => {
    proxyReq.on("upgrade", (_res: unknown, upstream: NodeNet.Socket) => {
      const drop = () => {
        if (!socket.destroyed) socket.destroy();
      };
      upstream.on("close", drop);
      upstream.on("error", drop);
      upstream.on("end", drop);
    });
  }) as (...args: never[]) => void);
}
