// @effect-diagnostics nodeBuiltinImport:off -- runs the user's OpenCode CLI in a child process.
/**
 * Every model the user's own OpenCode can run, for the composer's OpenCode tab: Zen's free and paid models, Go, and any
 * provider the user connected with `opencode auth login`. Read from `opencode models --verbose` under the user's normal
 * home, so OpenCode's own login decides what is listed; Kora never sees or stores a key. Each model's reasoning
 * variants become its effort levels (the OpenCodeDriver passes the pick as `--variant`).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type OpencodeModelInfo = {
  id: string;
  provider: string;
  name: string;
  free: boolean;
  variants: string[];
};

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const rank = (id: string) => {
  const i = EFFORT_ORDER.indexOf(id);
  return i < 0 ? EFFORT_ORDER.length : i;
};

/** `provider/model` header lines, each followed by the model's JSON. Unparseable blocks are skipped. */
export function parseOpencodeVerbose(text: string): OpencodeModelInfo[] {
  const out: OpencodeModelInfo[] = [];
  const blocks = text.split(/^(?=[^\s{}"]+\/\S+$)/m);
  for (const block of blocks) {
    const nl = block.indexOf("\n");
    if (nl < 0) continue;
    const id = block.slice(0, nl).trim();
    if (!/^[^\s/]+\/\S+$/.test(id)) continue;
    let info: {
      name?: unknown;
      providerID?: unknown;
      status?: unknown;
      cost?: { input?: unknown; output?: unknown };
      variants?: Record<string, unknown>;
    };
    try {
      info = JSON.parse(block.slice(nl + 1));
    } catch {
      continue;
    }
    if (info.status === "deprecated") continue;
    const variants = Object.keys(info.variants ?? {}).sort((a, b) => rank(a) - rank(b));
    out.push({
      id,
      provider:
        typeof info.providerID === "string" ? info.providerID : id.slice(0, id.indexOf("/")),
      name: typeof info.name === "string" && info.name ? info.name : id.slice(id.indexOf("/") + 1),
      free: info.cost?.input === 0 && info.cost?.output === 0,
      variants,
    });
  }
  return out;
}

/** The effort select for a model with reasoning variants (`effort` id: the same plumbing as Claude and Codex). */
export function opencodeEffortCapabilities(variants: ReadonlyArray<string>) {
  if (variants.length < 2) return { optionDescriptors: [] };
  const fallback = variants[Math.floor((variants.length - 1) / 2)]!;
  const defaultEffort = variants.includes("medium") ? "medium" : fallback;
  return {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        description: "How hard the model reasons per turn",
        type: "select" as const,
        options: variants.map((id) => ({
          id,
          label: EFFORT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1),
          ...(id === defaultEffort ? { isDefault: true } : {}),
        })),
        currentValue: defaultEffort,
      },
    ],
  };
}

/** Which OpenCode provider a model comes from, as the picker says it. */
export function opencodeProviderLabel(provider: string): string {
  if (provider === "opencode") return "Zen";
  if (provider === "opencode-go") return "Go";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

let listed: OpencodeModelInfo[] = [];
let running = false;

export function opencodeListedModels(): ReadonlyArray<OpencodeModelInfo> {
  return listed;
}

/** For tests. */
export function setOpencodeListedModelsForTests(models: OpencodeModelInfo[]): void {
  listed = models;
}

/** Kora's own OpenCode (Swarm setup installs it), else one on PATH. */
function opencodeBinary(koraHome: string): string | null {
  const managed = path.join(koraHome, "tools", "opencode", "current", "opencode");
  try {
    fs.accessSync(managed, fs.constants.X_OK);
    return managed;
  } catch {
    /* not installed by Kora */
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "opencode");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Re-read the list in a child process (never on the event loop) and call `onChange` when it differs. A failure keeps
 * the last good list: a slow or broken run is not a verdict on what the user can run.
 */
export function refreshOpencodeModels(koraHome: string, onChange: () => void): void {
  const bin = opencodeBinary(koraHome);
  if (!bin || running) return;
  running = true;
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" };
  for (const k of Object.keys(env)) {
    if (k.startsWith("KORA_") || k === "OPENCODE_CONFIG_DIR" || k === "OPENCODE_CONFIG_CONTENT")
      delete env[k];
  }
  execFile(
    bin,
    ["models", "--verbose"],
    { env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true },
    (err, stdout) => {
      running = false;
      if (err && !stdout) return;
      const next = parseOpencodeVerbose(String(stdout ?? ""));
      if (next.length === 0 || JSON.stringify(next) === JSON.stringify(listed)) return;
      listed = next;
      onChange();
    },
  );
}
