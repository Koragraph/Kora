// @effect-diagnostics nodeBuiltinImport:off -- the CLI shim path is plain path maths on the user's home.
import type { OutsideAuditInput, OutsideCreateInput, OutsideRevokeInput } from "@kora/contracts";
import { OUTSIDE_METHODS } from "@kora/contracts";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { host, type KoraOutsideLike } from "../host.ts";
import type { HandlerRecord } from "./shared.ts";
import { callAsync, fail, runtimeFor } from "./blobs.ts";
import { koraHome } from "../paths.ts";

/**
 * `blobs.outside.*` (docs/bots/OUTSIDE.md): the Settings, Outside access page. Thin delegation to the runtime's
 * `OutsideService` token store and audit log. The plaintext token leaves ONLY in the reply to `create`; it is never logged
 * and the daemon keeps only its hash. Revoking applies at once (the next call from that client is refused and audited).
 */

/** The limits the page states (runtime outside/ratelimit.ts DEFAULT_LIMITS). */
const LIMITS = { callsPerMinute: 60, sendsPerMinute: 12 } as const;

function outsideOf(operation: string): KoraOutsideLike {
  const o = runtimeFor(operation).outside;
  if (!o)
    throw fail(
      operation,
      "Outside access is not available in this daemon yet. Restart Kora to finish updating it.",
      "unavailable",
    );
  return o;
}

const tokenWire = (t: Record<string, unknown>) => ({
  id: String(t.id),
  name: String(t.name),
  createdAt: Number(t.createdAt) || 0,
  lastUsedAt: typeof t.lastUsedAt === "number" ? t.lastUsedAt : null,
  revokedAt: typeof t.revokedAt === "number" ? t.revokedAt : null,
  suffix: String(t.suffix ?? ""),
});

const auditWire = (r: Record<string, unknown>) => ({
  id: String(r.id),
  at: Number(r.at) || 0,
  tokenId: String(r.tokenId ?? ""),
  client: String(r.client ?? ""),
  tool: String(r.tool ?? ""),
  target: typeof r.target === "string" ? r.target : null,
  ok: r.ok === true,
  note: typeof r.note === "string" ? r.note : null,
});

/** How an outside client launches the bridge on THIS install (stable app: `kora`; Kora Dev and QA stacks differ). */
function outsideSetup() {
  const home = koraHome();
  const base = NodePath.basename(home);
  const dev = base === ".kora-dev";
  const stable = base === ".kora";
  const socket = host().managerRuntime?.socketPath;
  return {
    // kora-runtime.cjs writes kora.cmd on Windows
    command: NodePath.join(
      NodeOS.homedir(),
      ".local",
      "bin",
      `${dev ? "kora-dev" : "kora"}${process.platform === "win32" ? ".cmd" : ""}`,
    ),
    args: ["mcp", "--team", ...(!stable && socket ? ["--socket", socket] : [])],
    serverName: dev
      ? "kora-dev-team"
      : stable
        ? "kora-team"
        : `kora-${base.replace(/^\./, "").replace(/^kora-?/, "") || "team"}-team`,
    limits: { ...LIMITS },
  };
}

export const blobsOutsideHandlers: HandlerRecord = {
  [OUTSIDE_METHODS.setup]: () =>
    callAsync("outsideSetup", async () => {
      outsideOf("outsideSetup");
      return outsideSetup();
    }),

  [OUTSIDE_METHODS.tokens]: () =>
    callAsync("outsideTokens", async () => ({
      tokens: outsideOf("outsideTokens").listTokens().map(tokenWire),
    })),

  [OUTSIDE_METHODS.create]: (input) => {
    const i = input as OutsideCreateInput;
    return callAsync("outsideCreate", async () => {
      const r = outsideOf("outsideCreate").createToken(i.name);
      if (!r.ok)
        throw fail(
          "outsideCreate",
          r.message ?? r.error ?? "Could not create that token.",
          "invalid",
        );
      return { token: tokenWire(r.record), secret: r.token };
    });
  },

  [OUTSIDE_METHODS.revoke]: (input) => {
    const i = input as OutsideRevokeInput;
    return callAsync("outsideRevoke", async () => ({
      revoked: outsideOf("outsideRevoke").revokeToken(i.id),
    }));
  },

  [OUTSIDE_METHODS.audit]: (input) => {
    const i = input as OutsideAuditInput;
    return callAsync("outsideAudit", async () => {
      const page = outsideOf("outsideAudit").auditPage({
        limit: 50,
        ...(i.before !== null ? { before: i.before } : {}),
      });
      return { rows: page.rows.map(auditWire), next: page.next };
    });
  },
};
