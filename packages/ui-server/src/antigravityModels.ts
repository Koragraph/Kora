// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off globalDate:off -- plain Node probes of the
// `agy` CLI (spawn + a bounded timeout) and one cache file, at the boundary to the in-process runtime; not Effect code.
//
// Antigravity (Google's agent, the `agy` CLI) as a composer provider, auto-detected like Codex:
//   - found on PATH or in ~/.local/bin (the daemon's own PATH is bare, so the installer folders are searched too), or at
//     the path set in Settings > Engines (`<KORA_HOME>/engines.json` executables.antigravity);
//   - `agy --version` for the Agents card; `agy models` (`id<TAB>label` per line, "Fetching…" on stderr, ~6 s) for the
//     picker, cached in `<KORA_HOME>/cache/antigravity-models.json` so the first snapshot after a restart already has them;
//   - not installed = still listed (as Codex is), `status: "error"` with a calm "Install Antigravity" message.
// Nothing here blocks boot: the cache is read synchronously, the probe runs in the background, a failed probe is retried
// (the modelRefresh.ts delays) and the result is pushed to open clients.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Schema from "effect/Schema";
import { AgentModel } from "@kora/contracts";

import { daemonConfig } from "./config.ts";
import { notifyAgentsChanged } from "./modelRefresh.ts";
import { koraHome } from "./paths.ts";
import { envPath, exeCandidates, killChild, winCommand } from "./winSpawn.ts";

export const ANTIGRAVITY_INSTANCE_ID = "antigravity";
const PROBE_TIMEOUT_MS = 20_000;
const INSTALL_HINT =
  "Install Antigravity (the agy command) to chat with Google's agent, then press Re-check in Settings › Engines.";

type ProviderEntry = (typeof daemonConfig.providers)[number];
export interface AgyModelRow {
  readonly id: string;
  readonly label: string;
}

/** The explicit path from Settings > Engines, when one is set and absolute. */
function explicitAgyPath(home: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "engines.json"), "utf8")) as {
      executables?: { antigravity?: unknown };
    };
    const p = j.executables?.antigravity;
    return typeof p === "string" && path.isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

const isFileSync = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isExec = (p: string): boolean => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform === "win32") return exeCandidates(p).length === 1; // runnable = has a PATHEXT extension
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where `agy` is: the explicit path, else PATH, else the folders installers use. Null when it is not installed. */
export function resolveAgyBin(
  o: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    userHome?: string;
    isExecutable?: (p: string) => boolean;
  } = {},
): string | null {
  const exec = o.isExecutable ?? isExec;
  const explicit = explicitAgyPath(o.home ?? koraHome());
  // The path set in Settings > Engines is the user's choice: on Windows any file there runs (winCommand starts a `#!`
  // script under Git bash), so only its existence is checked.
  if (explicit) {
    if (process.platform === "win32" && !o.isExecutable)
      return isFileSync(explicit) ? explicit : null;
    return exec(explicit) ? explicit : null;
  }
  const userHome = o.userHome ?? os.homedir();
  const dirs = [
    ...(envPath(o.env ?? process.env) ?? "").split(path.delimiter),
    path.join(userHome, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const file of exeCandidates(path.join(dir, "agy"))) if (exec(file)) return file;
  }
  return null;
}

/** `agy models` stdout → rows. Lines are `id<TAB>label`; anything else (progress text, blanks) is skipped. */
export function parseAgyModels(stdout: string): AgyModelRow[] {
  const out: AgyModelRow[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: label || id });
  }
  return out;
}

/** The model agy itself defaults to (`model` in ~/.gemini/antigravity-cli/settings.json is a LABEL), or null. */
export function agyDefaultLabel(userHome = os.homedir()): string | null {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(userHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    ) as { model?: unknown };
    return typeof j.model === "string" && j.model.trim() ? j.model.trim() : null;
  } catch {
    return null;
  }
}

const decodeModel = Schema.decodeUnknownSync(AgentModel);

/**
 * Rows → picker models. The effort is part of the id (`gemini-3.8-flash-low`), so no effort select. Exactly one default:
 * agy's own default when it is in the list, else the first row.
 */
export function mapAgyModels(
  rows: ReadonlyArray<AgyModelRow>,
  defaultLabel: string | null = null,
): Array<typeof AgentModel.Type> {
  const want = rows.findIndex((r) => r.label === defaultLabel || r.id === defaultLabel);
  const defaultAt = want >= 0 ? want : 0;
  const out: Array<typeof AgentModel.Type> = [];
  rows.forEach((r, i) => {
    try {
      out.push(
        decodeModel({
          slug: r.id,
          name: r.label,
          shortName: r.label,
          isCustom: false,
          ...(i === defaultAt ? { isDefault: true } : {}),
          capabilities: null,
        }),
      );
    } catch {
      /* one bad row never sinks the list */
    }
  });
  if (out.length > 0 && !out.some((m) => m.isDefault)) out[0] = { ...out[0]!, isDefault: true };
  return out;
}

// ── cache ────────────────────────────────────────────────────────────────────────────────────────────────────────
const cacheFile = (home: string) => path.join(home, "cache", "antigravity-models.json");

export function readAgyCache(
  home = koraHome(),
): { version: string | null; models: AgyModelRow[] } | null {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(home), "utf8")) as {
      version?: unknown;
      models?: unknown;
    };
    const models = Array.isArray(j.models)
      ? parseAgyModels(
          j.models
            .map(
              (m: { id?: unknown; label?: unknown }) =>
                `${String(m?.id ?? "")}\t${String(m?.label ?? "")}`,
            )
            .join("\n"),
        )
      : [];
    return models.length
      ? { version: typeof j.version === "string" ? j.version : null, models }
      : null;
  } catch {
    return null;
  }
}

/** How old the cached model list is, or null when there is none. */
export function agyCacheAgeMs(home = koraHome(), now = Date.now()): number | null {
  try {
    const at = Date.parse(
      String((JSON.parse(fs.readFileSync(cacheFile(home), "utf8")) as { at?: unknown }).at),
    );
    return Number.isFinite(at) ? Math.max(0, now - at) : null;
  } catch {
    return null;
  }
}

/** A cached list younger than this is trusted at boot: `agy models` contacts Google through the user's agy sign-in. */
export const AGY_CACHE_FRESH_MS = 24 * 3_600_000;

function writeAgyCache(home: string, version: string | null, models: AgyModelRow[]): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile(home)), { recursive: true });
    const tmp = `${cacheFile(home)}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ at: new Date().toISOString(), version, models }, null, 2)}\n`,
    );
    fs.renameSync(tmp, cacheFile(home));
  } catch {
    /* a cache is a nicety */
  }
}

// ── probes ───────────────────────────────────────────────────────────────────────────────────────────────────────
interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
/**
 * Environment for Kora's own background `agy` reads (models, /usage). When agy's silent token refresh fails (a network
 * hiccup), print mode falls back to an interactive OAuth flow and opens a Google login page in the user's browser:
 * that is how background usage checks opened ~10 login tabs (2026-10-13). With no PATH, agy cannot find `open`, so
 * it can never launch a browser; its keychain sign-in still works (verified), so the read still succeeds.
 *
 * Windows: agy (Go) opens the page with `rundll32 url.dll,FileProtocolHandler <url>` (its own changelog: "launch browser
 * sign-in via `rundll32`"; the strings `rundll32` / `url.dll,FileProtocolHandler` sit next to `xdg-open` in the binary).
 * Go's exec.LookPath finds a bare name only through PATH and the current folder, never System32 on its own, so:
 *   - PATH is an empty Kora-owned folder (not `/var/empty`, which Windows reads as `<current drive>:\var\empty`);
 *   - NoDefaultCurrentDirectoryInExePath=1 stops the current-folder lookup (Go's LookPath and cmd.exe both honour it);
 *   - BROWSER names a program that does not exist, for any opener that tries $BROWSER first.
 * A child still starts without PATH: SystemRoot and the profile folders are kept.
 */
export function backgroundAgyEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  emptyDir: () => string = agyEmptyPathDir,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/var/empty" };
  for (const k of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"])
    if (base[k]) env[k] = base[k];
  // Windows: what any program needs to start, and the profile folders its sign-in lives in.
  if (platform === "win32") {
    for (const k of [
      "SystemRoot",
      "SystemDrive",
      "windir",
      "USERPROFILE",
      "USERNAME",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
    ])
      if (base[k]) env[k] = base[k];
    env.PATH = emptyDir();
    env.NoDefaultCurrentDirectoryInExePath = "1";
    env.BROWSER = "kora-blocked-browser";
  }
  return env;
}

/** `<KORA_HOME>/agy-empty-path`: a folder that holds nothing, so a PATH lookup through it finds nothing. */
function agyEmptyPathDir(): string {
  const dir = path.join(koraHome(), "agy-empty-path");
  try {
    fs.mkdirSync(dir, { recursive: true });
    // keep it empty: anything dropped in here would become runnable by name for the probe
    for (const f of fs.readdirSync(dir))
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  } catch {
    /* a missing folder finds nothing either */
  }
  return dir;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const w = winCommand(bin, args);
      child = spawn(w.command, w.args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: os.homedir(),
        env: backgroundAgyEnv(),
        windowsHide: true,
        windowsVerbatimArguments: w.windowsVerbatimArguments,
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        killChild(child, "SIGKILL");
      } catch {
        /* gone */
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout = (stdout + c).slice(-200_000);
    });
    child.stderr?.on("data", (c: string) => {
      stderr = (stderr + c).slice(-20_000);
    });
    child.on("error", () => finish({ code: null, stdout, stderr, timedOut: false }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

export interface AgyProbe {
  installed: boolean;
  version: string | null;
  models: AgyModelRow[] | null;
  /** Why the model list could not be read (installed only). */
  problem: string | null;
  signedOut: boolean;
}

/** One look at the CLI: is it there, which version, which models. Never throws. */
export async function probeAntigravity(
  o: { bin?: string | null; timeoutMs?: number; runFn?: typeof run } = {},
): Promise<AgyProbe> {
  const bin = o.bin === undefined ? resolveAgyBin() : o.bin;
  if (!bin)
    return { installed: false, version: null, models: null, problem: null, signedOut: false };
  const exec = o.runFn ?? run;
  const v = await exec(bin, ["--version"], 5_000);
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(v.stdout)?.[1] ?? null;
  const m = await exec(bin, ["models"], o.timeoutMs ?? PROBE_TIMEOUT_MS);
  const rows = parseAgyModels(m.stdout);
  if (rows.length)
    return { installed: true, version, models: rows, problem: null, signedOut: false };
  const said = `${m.stderr}\n${m.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^fetching available models/i.test(l));
  const signedOut = said.some((l) =>
    /not (?:signed|logged) in|sign[- ]?in|log ?in|unauthenticated|oauth|credential/i.test(l),
  );
  const problem = m.timedOut
    ? "agy models did not answer in time."
    : signedOut
      ? `Antigravity is not signed in. Run agy ${process.platform === "darwin" ? "in Terminal" : "in a terminal"} once and sign in with your Google account.`
      : said[0]
        ? `agy models failed: ${said[0].slice(0, 200)}`
        : "agy models listed nothing.";
  return { installed: true, version, models: null, problem, signedOut };
}

// ── the provider entry ───────────────────────────────────────────────────────────────────────────────────────────
function entry(): ProviderEntry | undefined {
  return daemonConfig.providers.find((p) => p.instanceId === ANTIGRAVITY_INSTANCE_ID);
}

/** Patch the advertised Antigravity entry from what is known now. Returns whether anything a client sees changed. */
export function applyAntigravityState(s: {
  installed: boolean;
  version: string | null;
  models: AgyModelRow[] | null;
  problem?: string | null;
  signedOut?: boolean;
  defaultLabel?: string | null;
}): boolean {
  const p = entry() as (ProviderEntry & Record<string, unknown>) | undefined;
  if (!p) return false;
  const before = JSON.stringify({ ...p, checkedAt: null });
  const models = s.models ? mapAgyModels(s.models, s.defaultLabel ?? null) : null;
  const next: Record<string, unknown> = {
    installed: s.installed,
    version: s.installed ? s.version : null,
    checkedAt: new Date().toISOString(),
  };
  if (models && models.length) next.models = models;
  else if (!s.installed) next.models = [];
  if (!s.installed) {
    Object.assign(next, {
      status: "error",
      auth: { status: "unknown" },
      message: INSTALL_HINT,
      availability: "unavailable",
      unavailableReason: INSTALL_HINT,
    });
  } else if (s.signedOut) {
    Object.assign(next, {
      status: "error",
      auth: { status: "unauthenticated" },
      message: s.problem ?? "Antigravity is not signed in.",
    });
  } else {
    const haveModels = Array.isArray(next.models) ? next.models.length > 0 : p.models.length > 0;
    Object.assign(next, {
      status: haveModels ? "ready" : "warning",
      auth: models ? { status: "authenticated", type: "subscription" } : { status: "unknown" },
      ...(haveModels ? {} : { message: s.problem ?? "Antigravity's model list is not known yet." }),
    });
  }
  for (const k of ["message", "availability", "unavailableReason"]) if (!(k in next)) delete p[k];
  Object.assign(p, next);
  return JSON.stringify({ ...p, checkedAt: null }) !== before;
}

/** Boot: the cached list (no process) so the first snapshot is right; whether agy is there is a stat. */
export function initAntigravityFromCache(home = koraHome()): void {
  const bin = resolveAgyBin({ home });
  const cached = bin ? readAgyCache(home) : null;
  applyAntigravityState({
    installed: !!bin,
    version: cached?.version ?? null,
    models: cached?.models ?? null,
    defaultLabel: agyDefaultLabel(),
  });
}

/** Probe now, patch the entry, cache the list, tell open clients. True when the model list landed (or agy is absent). */
export async function refreshAntigravity(home = koraHome(), timeoutMs?: number): Promise<boolean> {
  const r = await probeAntigravity({
    bin: resolveAgyBin({ home }),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (r.models) writeAgyCache(home, r.version, r.models);
  const changed = applyAntigravityState({ ...r, defaultLabel: agyDefaultLabel() });
  if (changed) notifyAgentsChanged();
  if (r.installed)
    console.log(
      r.models
        ? `[kora-daemon] antigravity auto-detect: agy ${r.version ?? "?"}, ${r.models.length} model(s)`
        : `[kora-daemon] antigravity auto-detect: ${r.problem}`,
    );
  return !r.installed || !!r.models;
}

const RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 300_000, 600_000];
const INSTALL_POLL_MS = 60_000;

/**
 * Keep the entry true: cache now, probe in the background, retry a failed probe, and notice an install / uninstall
 * (a stat a minute; a change re-probes). Never blocks the caller.
 */
export function startAntigravityDetect(home = koraHome()): void {
  initAntigravityFromCache(home);
  let attempt = 0;
  const tick = async () => {
    const ok = await refreshAntigravity(home).catch(() => false);
    if (ok) return;
    const delay = RETRY_DELAYS_MS[attempt++];
    if (delay !== undefined) setTimeout(() => void tick(), delay).unref?.();
  };
  // A fresh cache means no live `agy models` at boot (it is an account call to Google, ~25 s of agy): the list is
  // re-read once a day, when agy is installed or removed, or when there is no usable cache (aud1 section 2).
  const cacheAge = agyCacheAgeMs(home);
  const fresh =
    cacheAge !== null && cacheAge < AGY_CACHE_FRESH_MS && !!readAgyCache(home)?.models.length;
  if (!fresh) void tick();
  else setTimeout(() => void tick(), AGY_CACHE_FRESH_MS - (cacheAge ?? 0)).unref?.();
  let wasInstalled = !!resolveAgyBin({ home });
  setInterval(() => {
    const now = !!resolveAgyBin({ home });
    if (now === wasInstalled) return;
    wasInstalled = now;
    attempt = 0;
    void tick();
  }, INSTALL_POLL_MS).unref?.();
}

// ── plan usage (`agy -p /usage --output-format json`) ────────────────────────────────────────────────────────────
// A local command: answers at once, 0 tokens, no model call. Each quota GROUP (models that share limits, e.g.
// "Gemini Models", "Claude and GPT models") has a weekly and a 5-hour bucket; each bucket becomes one plan window
// labelled "<group> · Weekly" / "<group> · 5-hour", so the client can pick the group of the selected model.
const USAGE_TIMEOUT_MS = 45_000;

interface AgyUsageWindow {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowMinutes?: number;
}

/** The separator between a window's group and its span in an Antigravity label (the client splits on it). */
export const AGY_GROUP_SEPARATOR = " · ";

function bucketSpan(
  window: string,
  name: string,
): { kind: AgyUsageWindow["kind"]; label: string; minutes?: number } {
  const w = window.trim().toLowerCase();
  if (w === "weekly" || w === "7d")
    return { kind: "weekly", label: "Weekly", minutes: 7 * 24 * 60 };
  if (w === "5h") return { kind: "session", label: "5-hour", minutes: 300 };
  if (w === "monthly") return { kind: "monthly", label: "Monthly" };
  const fromName = name.replace(/\s*limit remaining\s*$/i, "").trim();
  return { kind: "other", label: fromName || window || "Limit" };
}

/**
 * `agy /usage` JSON → a full usage report, or null when the output is not that shape. usedPercent is
 * round((1 - remaining_fraction) * 100); a bucket without a usable fraction is skipped.
 */
export function parseAgyUsage(
  stdout: string,
): { provider: string; windows: AgyUsageWindow[]; complete: true } | null {
  let j: unknown = null;
  const text = stdout.trim();
  try {
    j = JSON.parse(text);
  } catch {
    const line = text
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    if (!line) return null;
    try {
      j = JSON.parse(line);
    } catch {
      return null;
    }
  }
  const data = (j as { command?: { name?: unknown; data?: { groups?: unknown } } } | null)?.command
    ?.data;
  if (!data || !Array.isArray(data.groups)) return null;
  const windows: AgyUsageWindow[] = [];
  const seen = new Set<string>();
  for (const g of data.groups as Array<{ name?: unknown; buckets?: unknown }>) {
    const group = typeof g?.name === "string" ? g.name.trim() : "";
    if (!group || !Array.isArray(g.buckets)) continue;
    for (const b of g.buckets as Array<Record<string, unknown>>) {
      const frac = b?.remaining_fraction;
      if (typeof frac !== "number" || !Number.isFinite(frac)) continue;
      const span = bucketSpan(
        typeof b.window === "string" ? b.window : "",
        typeof b.name === "string" ? b.name : "",
      );
      const rawId =
        typeof b.id === "string" && b.id.trim() ? b.id.trim() : `${group}:${span.label}`;
      if (seen.has(rawId)) continue;
      seen.add(rawId);
      const resetsAt = typeof b.reset_time === "string" ? Date.parse(b.reset_time) : Number.NaN;
      windows.push({
        id: rawId,
        kind: span.kind,
        label: `${group}${AGY_GROUP_SEPARATOR}${span.label}`,
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - frac) * 100))),
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
        ...(span.minutes !== undefined ? { windowMinutes: span.minutes } : {}),
      });
    }
  }
  return { provider: ANTIGRAVITY_INSTANCE_ID, windows, complete: true };
}

/**
 * Read Antigravity's plan usage in a child process (never on the event loop), bounded by a timeout.
 * "absent" = agy is not installed (no usage entry at all); null = the read failed (keep the last good bars).
 */
export async function readAgyUsage(
  o: { home?: string; bin?: string | null; runFn?: typeof run; timeoutMs?: number } = {},
): Promise<ReturnType<typeof parseAgyUsage> | "absent"> {
  const bin = o.bin === undefined ? resolveAgyBin({ home: o.home ?? koraHome() }) : o.bin;
  if (!bin) return "absent";
  const r = await (o.runFn ?? run)(
    bin,
    ["-p", "/usage", "--output-format", "json", "--print-timeout", "40s"],
    o.timeoutMs ?? USAGE_TIMEOUT_MS,
  );
  if (r.timedOut) return null;
  return parseAgyUsage(r.stdout);
}
