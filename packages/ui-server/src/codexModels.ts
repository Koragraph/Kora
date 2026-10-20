// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off -- this is a plain Node
// stdio probe of the `codex` CLI at boot (spawn + line buffer + a bounded timeout), not an Effect fiber;
// it mirrors the raw-Node style bin.ts already uses for its stall detector.
//
// Auto-detect the Codex model catalog at daemon boot instead of hardcoding it.
//
// Codex's `codex app-server` speaks JSON-RPC over stdio (the same protocol the Codex desktop app uses).
// Its `model/list` method returns the account's real models with, per model, the reasoning-effort levels
// that model actually supports and its default — which differ across models (e.g. `low,medium,high,xhigh,max`
// vs `…,ultra`), so a hardcoded list is always wrong for someone. We do the `initialize` → `model/list`
// handshake once at boot, map each model to a `AgentModel`, and patch them into the Codex provider
// in `daemonConfig`. Everything here is best-effort and bounded: if Codex isn't installed, the probe times
// out, or the payload is malformed, we keep the static fallback list in config.ts and never block boot.
import { spawn } from "node:child_process";
import * as Schema from "effect/Schema";
import { AgentModel } from "@kora/contracts";
import { codexCapabilities, daemonConfig } from "./config.ts";
import { resolveCodexBin } from "./skillDiscovery.ts";
import { killChild, winCommand } from "./winSpawn.ts";

const CODEX_INSTANCE_ID = "codex";
const PROBE_TIMEOUT_MS = 4000;

interface CodexModel {
  model?: unknown;
  displayName?: unknown;
  isDefault?: unknown;
  hidden?: unknown;
  supportedReasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Run the `codex app-server` `model/list` handshake, returning the raw model rows (or null on any failure). */
function probeCodexModels(timeoutMs = PROBE_TIMEOUT_MS): Promise<CodexModel[] | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const w = winCommand(resolveCodexBin(), ["app-server"]);
      child = spawn(w.command, w.args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        windowsVerbatimArguments: w.windowsVerbatimArguments,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let buf = "";
    const finish = (result: CodexModel[] | null) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      try {
        killChild(child, "SIGKILL");
      } catch {
        /* best effort */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const send = (o: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(o)}\n`);
      } catch {
        finish(null);
      }
    };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: { id?: unknown; result?: { data?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "model/list",
            params: { includeHidden: false, limit: 100 },
          });
        } else if (msg.id === 2) {
          const data = msg.result?.data;
          finish(Array.isArray(data) ? (data as CodexModel[]) : null);
          return;
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "kora", title: null, version: "0.0.0" }, capabilities: null },
    });
  });
}

/** Map raw Codex `model/list` rows to validated `AgentModel`s (dropping hidden / malformed ones). */
function mapCodexModels(rows: ReadonlyArray<CodexModel>): Array<typeof AgentModel.Type> {
  const visible = rows.filter((row) => row.hidden !== true);
  const source = visible.length > 0 ? visible : rows;
  const out: Array<typeof AgentModel.Type> = [];
  let sawDefault = false;
  for (const row of source) {
    const slug = str(row.model);
    if (!slug) continue;
    const name = str(row.displayName) ?? slug;
    const efforts = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts
          .map((e) => str((e as { reasoningEffort?: unknown })?.reasoningEffort))
          .filter((e): e is string => e !== null)
      : [];
    const defaultEffort = str(row.defaultReasoningEffort) ?? efforts[0] ?? null;
    const isDefault = row.isDefault === true && !sawDefault;
    if (isDefault) sawDefault = true;
    const candidate = {
      slug,
      name,
      shortName: name,
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      capabilities:
        efforts.length > 0 && defaultEffort ? codexCapabilities(efforts, defaultEffort) : null,
    };
    try {
      out.push(Schema.decodeUnknownSync(AgentModel)(candidate));
    } catch {
      // A single malformed row must not sink the whole catalog.
    }
  }
  // Guarantee exactly one default so the composer always has a model to preselect.
  if (out.length > 0 && !out.some((m) => m.isDefault)) {
    out[0] = { ...out[0]!, isDefault: true };
  }
  return out;
}

/**
 * Detect the Codex catalog and patch it into `daemonConfig` in place. Runs once at boot, before the WS
 * server starts serving, so the connection snapshot carries the real models. No-op (keeps the fallback)
 * when the probe yields nothing.
 */
export async function applyCodexModels(timeoutMs?: number): Promise<boolean> {
  const provider = daemonConfig.providers.find((p) => p.instanceId === CODEX_INSTANCE_ID);
  if (!provider) return true;
  let rows: CodexModel[] | null = null;
  try {
    rows = await probeCodexModels(timeoutMs);
  } catch {
    rows = null;
  }
  if (!rows) {
    console.warn("[kora-daemon] codex model auto-detect: probe failed; keeping fallback list");
    return false;
  }
  const models = mapCodexModels(rows);
  if (models.length === 0) {
    console.warn("[kora-daemon] codex model auto-detect: no usable models; keeping fallback list");
    return false;
  }
  // daemonConfig is a decoded (non-frozen) object; replace the codex models in place.
  (provider as { models: ReadonlyArray<typeof AgentModel.Type> }).models = models;
  console.log(
    `[kora-daemon] codex model auto-detect: ${models.length} model(s) — ${models
      .map((m) => m.slug)
      .join(", ")}`,
  );
  return true;
}
