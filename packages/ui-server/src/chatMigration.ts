// @effect-diagnostics nodeBuiltinImport:off -- one-time boot migration over plain folders under KORA_HOME.
// @effect-diagnostics globalDate:off -- plain wall-clock reads (dated backup names, the marker).
// @effect-diagnostics globalConsole:off -- the migration logs through the injected `log`.
/**
 * The one-time Chat -> Kora migration (2026-10-10: the Chat surface was removed; Kora takes over).
 *
 *   Chat project  -> a blob (name = project title, SOUL from PROJECT.md, memory.md lines -> blob memory facts,
 *                    schedules.json -> routines, files/ + outputs/ copied into the blob workspace, threads re-pointed)
 *   General chats -> threads under Kora (the Chief)
 *
 * Contract:
 *   - Runs once per KORA_HOME, at daemon start, after Kora (the Chief) exists. A marker file (`chat-migration.json`)
 *     makes every later start a no-op; an interrupted run resumes from its journal (`chat-migration.state.json`), so no
 *     blob, fact, routine or file is ever made twice.
 *   - Backs up the chat store (`chat/`), the read models (`kora-daemon/`) and `chats/` first.
 *   - Never deletes anything: when everything moved, `chats/` is renamed to `chats.migrated-<date>/` (a backup).
 *   - Dry run (`KORA_CHAT_MIGRATION=dry-run`): reads, plans, writes `chat-migration.dry-run.json`, touches nothing else.
 *   - Whatever cannot be migrated is listed in a one-time notice thread in Kora ("Moved your Chat projects into Kora").
 *
 * ui-server cannot import the runtime, so every collaborator is a small structural interface (`MigrationEngine` is the
 * chat engine's slice; `KoraBlobsLike` is the runtime's blobs facade).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { CHIEF_BLOB_ID } from "@kora/contracts";
import type { BlobProfile } from "@kora/contracts";

import type { KoraBlobsLike } from "./host.ts";

// ── legacy layout (the folders the Chat surface used; see docs/chat/PLAN.md) ─────────────────────────────

const GENERAL_PROJECT_ID = "chat-general";
const MARKER = "chat-migration.json";
const STATE = "chat-migration.state.json";
const DRY_RUN_REPORT = "chat-migration.dry-run.json";
const MAX_FACT_CHARS = 300;
const MAX_FACTS_PER_PROJECT = 150;
const MAX_NAME = 40;

const legacyChatsDir = (home: string): string => path.join(home, "chats");
const legacyGeneralDir = (home: string): string => path.join(legacyChatsDir(home), "general");
const legacyProjectsDir = (home: string): string => path.join(legacyChatsDir(home), "projects");

export type MigrationMode = "run" | "dry-run" | "off";

/** `KORA_CHAT_MIGRATION=dry-run` plans without touching anything; `off` skips (nothing runs, nothing is marked). */
export function migrationModeFromEnv(env: NodeJS.ProcessEnv = process.env): MigrationMode {
  const v = (env.KORA_CHAT_MIGRATION ?? "").trim().toLowerCase();
  if (v === "dry-run" || v === "dry" || v === "plan") return "dry-run";
  if (v === "off" || v === "0" || v === "skip") return "off";
  return "run";
}

// ── collaborators ────────────────────────────────────────────────────────────────────────────────────────

export interface LegacyThread {
  threadId: string;
  projectId: string;
  cwd: string;
  title: string;
  archived: boolean;
  running: boolean;
}
export interface LegacyProjectHead {
  id: string;
  title: string;
  workspaceRoot: string;
  engine: { instanceId: string; model: string; effort: string | null } | null;
}
export interface MoveResult {
  moved: boolean;
  transcriptCopied: boolean;
  reason?: string;
}
/** The chat engine's slice (kora-chat.ts implements it). */
export interface MigrationEngine {
  legacyProjects(isLegacy: (cwd: string) => boolean): LegacyProjectHead[];
  legacyThreads(isLegacy: (cwd: string) => boolean): LegacyThread[];
  /** The blob exists in the store: mirror it as a project now (threads need it before they move). */
  upsertBlobProject(blob: BlobProfile): void;
  /** Re-point a thread at a blob: project, folder, runtime head, and `rewrites` applied to the paths in its transcript. */
  moveThread(
    threadId: string,
    blob: { id: string; workspace: string },
    rewrites: ReadonlyArray<readonly [string, string]>,
  ): Promise<MoveResult>;
  /** Remove an emptied legacy project head (its threads already moved). */
  dropProject(projectId: string): void;
  /** A Kora thread holding one assistant message (no model run). Returns its id, or null. */
  postNotice(blobId: string, title: string, markdown: string): string | null;
  threadExists(threadId: string): boolean;
}

export interface ChatMigrationDeps {
  /** KORA_HOME. */
  home: string;
  blobs: KoraBlobsLike;
  engine: MigrationEngine;
  mode: MigrationMode;
  now?: () => number;
  log?: (message: string) => void;
  /** IANA zone for converted schedules (default: this Mac's). */
  timeZone?: string;
  /** The engine a new blob gets when nothing else says (Settings > Kora defaults, else the best installed). */
  bestEngine?: () => BlobProfile["engine"] | null;
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────────────────────

interface LegacySchedule {
  id?: string;
  title?: string;
  prompt?: string;
  cadence?: { kind?: string; time?: string | null; weekday?: number | null; at?: number | null };
  enabled?: boolean;
  lastThreadId?: string | null;
}

interface Folder {
  root: string;
  title: string;
  instructions: string;
  memoryRaw: string;
  schedules: LegacySchedule[];
  files: number;
  outputs: number;
}

export interface PlanEntry {
  /** `general`, `projects/<slug>` or `path/<relative>` — the journal key. */
  key: string;
  kind: "general" | "project";
  title: string;
  root: string;
  projectIds: string[];
  threadIds: string[];
  folder: Folder | null;
  engine: { instanceId: string; model: string; effort: string | null } | null;
}

const isUnder = (p: string, root: string): boolean => {
  const a = path.resolve(p);
  const r = path.resolve(root);
  return a === r || a.startsWith(r + path.sep);
};

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile()) n += 1;
    }
  };
  walk(dir);
  return n;
}

function readSchedules(root: string): LegacySchedule[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, "schedules.json"), "utf8"));
    return Array.isArray(parsed) ? (parsed as LegacySchedule[]) : [];
  } catch {
    return [];
  }
}

/** "# Title" is what a fresh PROJECT.md holds: not instructions. */
export function instructionsOf(raw: string, title: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  if (
    lines.length &&
    /^#\s+/.test(lines[0]!) &&
    lines[0]!.replace(/^#\s+/, "").trim().toLowerCase() === title.trim().toLowerCase()
  )
    lines.shift();
  return lines.join("\n").trim();
}

function readFolder(root: string, fallbackTitle: string): Folder {
  const rawProject = readText(path.join(root, "PROJECT.md"));
  const heading = /^#\s+(.+)$/m.exec(rawProject)?.[1]?.trim();
  const title = (heading || fallbackTitle).trim();
  return {
    root,
    title,
    instructions: instructionsOf(rawProject, title),
    memoryRaw: readText(path.join(root, "memory.md")),
    schedules: readSchedules(root),
    files: countFiles(path.join(root, "files")),
    outputs: countFiles(path.join(root, "outputs")),
  };
}

export function buildPlan(home: string, engine: MigrationEngine): PlanEntry[] {
  const chats = legacyChatsDir(home);
  const isLegacy = (cwd: string): boolean => isUnder(cwd, chats);
  const heads = engine.legacyProjects(isLegacy);
  const threads = engine.legacyThreads(isLegacy);
  const entries = new Map<string, PlanEntry>();

  const keyOf = (root: string): { key: string; kind: "general" | "project" } => {
    const rel = path.relative(chats, path.resolve(root));
    if (rel === "general" || rel.startsWith("general" + path.sep))
      return { key: "general", kind: "general" };
    const m = /^projects[\\/]([^\\/]+)/.exec(rel);
    if (m) return { key: `projects/${m[1]}`, kind: "project" };
    return { key: `path/${rel || "root"}`, kind: "project" };
  };
  const rootOfKey = (key: string): string =>
    key === "general"
      ? legacyGeneralDir(home)
      : key.startsWith("projects/")
        ? path.join(legacyProjectsDir(home), key.slice("projects/".length))
        : path.join(chats, key.slice("path/".length));
  const ensure = (root: string): PlanEntry => {
    const { key, kind } = keyOf(root);
    let e = entries.get(key);
    if (!e) {
      const r = rootOfKey(key);
      e = {
        key,
        kind,
        title: kind === "general" ? "General" : path.basename(r),
        root: r,
        projectIds: [],
        threadIds: [],
        folder: null,
        engine: null,
      };
      entries.set(key, e);
    }
    return e;
  };

  // folders on disk
  if (fs.existsSync(legacyGeneralDir(home)))
    ensure(legacyGeneralDir(home)).folder = readFolder(legacyGeneralDir(home), "General");
  try {
    for (const d of fs.readdirSync(legacyProjectsDir(home), { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const root = path.join(legacyProjectsDir(home), d.name);
      const e = ensure(root);
      e.folder = readFolder(root, d.name);
      e.title = e.folder.title;
    }
  } catch {
    /* no projects folder */
  }
  // project heads in the chat engine (may name folders that are gone)
  for (const h of heads) {
    const root = h.id === GENERAL_PROJECT_ID ? legacyGeneralDir(home) : h.workspaceRoot;
    const e = ensure(root);
    if (!e.projectIds.includes(h.id)) e.projectIds.push(h.id);
    if (e.kind === "project" && !e.folder) e.title = h.title;
    if (h.engine && !e.engine) e.engine = h.engine;
  }
  // threads
  for (const t of threads) {
    const e = ensure(
      isLegacy(t.cwd) ? t.cwd : (heads.find((h) => h.id === t.projectId)?.workspaceRoot ?? t.cwd),
    );
    e.threadIds.push(t.threadId);
  }
  return [...entries.values()].sort((a, b) =>
    a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === "general" ? -1 : 1,
  );
}

// ── memory.md -> facts ───────────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER =
  /^(none|n\/a|na|nothing|nothing yet|none yet|empty|tbd|todo|to do|unknown|not set|no notes?|no memory|\(none.*\)|\(empty\)|_none_|-|\.\.\.|…)$/i;

/** The lines of a memory.md worth remembering, one fact each. Headings, fences, comments, placeholders, duplicates and
 *  noise are skipped (and counted); a line over the fact size is split at sentence ends, or skipped when it cannot be. */
export function parseMemoryLines(raw: string): { facts: string[]; skipped: string[] } {
  const facts: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let fenced = false;
  let comment = false;
  const push = (text: string, original: string): void => {
    const key = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (text.length <= MAX_FACT_CHARS) {
      facts.push(text);
      return;
    }
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const pieces: string[] = [];
    let cur = "";
    for (const s of sentences) {
      if (s.length > MAX_FACT_CHARS) {
        skipped.push(original.slice(0, 80));
        return;
      }
      if ((cur + " " + s).trim().length > MAX_FACT_CHARS) {
        if (cur) pieces.push(cur);
        cur = s;
      } else cur = (cur + " " + s).trim();
    }
    if (cur) pieces.push(cur);
    facts.push(...pieces);
  };
  for (const line0 of raw.replace(/\r\n/g, "\n").split("\n")) {
    let line = line0.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) comment = true;
      continue;
    }
    if (!line || line.startsWith("#") || /^[-=*_]{3,}$/.test(line) || line.startsWith("|---"))
      continue;
    line = line
      .replace(/^>+\s*/, "")
      .replace(/^([-*+•]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s*/, "")
      .trim();
    if (/^_.*_$/.test(line) && PLACEHOLDER.test(line.replace(/^_+|_+$/g, "").trim())) continue;
    // placeholders and one-word noise are not memories, and not worth a line in the notice either
    if (PLACEHOLDER.test(line) || !/[A-Za-z0-9]{3}/.test(line) || line.length < 6) continue;
    push(line, line0.trim());
  }
  return {
    facts: facts.slice(0, MAX_FACTS_PER_PROJECT),
    skipped:
      facts.length > MAX_FACTS_PER_PROJECT
        ? [
            ...skipped,
            `${facts.length - MAX_FACTS_PER_PROJECT} more lines (the per-project limit is ${MAX_FACTS_PER_PROJECT})`,
          ]
        : skipped,
  };
}

// ── schedules -> routines ────────────────────────────────────────────────────────────────────────────────

type RoutineCadenceInput =
  | { kind: "interval"; everyMinutes: number; anchor: number }
  | { kind: "weekly"; days: number[]; time: string; tz: string }
  | { kind: "cron"; expr: string; tz: string }
  | { kind: "once"; at: number };

const pad = (n: number): string => String(n).padStart(2, "0");

/** Chat's hourly/daily/weekdays/weekly/once -> the routine engine's cadences; null when it cannot be read. */
export function cadenceToRoutine(
  c: LegacySchedule["cadence"],
  tz: string,
): RoutineCadenceInput | null {
  if (!c || typeof c.kind !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec((c.time ?? "").trim());
  const hh = m ? Math.min(23, Number(m[1])) : 9;
  const mm = m ? Math.min(59, Number(m[2])) : 0;
  const time = `${pad(hh)}:${pad(mm)}`;
  switch (c.kind) {
    case "hourly":
      return { kind: "cron", expr: `${mm} * * * *`, tz };
    case "daily":
      return { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time, tz };
    case "weekdays":
      return { kind: "weekly", days: [1, 2, 3, 4, 5], time, tz };
    case "weekly": {
      const d = typeof c.weekday === "number" && c.weekday >= 0 && c.weekday <= 6 ? c.weekday : 1;
      return { kind: "weekly", days: [d], time, tz };
    }
    case "once":
      return typeof c.at === "number" && Number.isFinite(c.at) ? { kind: "once", at: c.at } : null;
    default:
      return null;
  }
}

// ── journal ──────────────────────────────────────────────────────────────────────────────────────────────

interface EntryState {
  blobId: string | null;
  name: string | null;
  filesDone: boolean;
  memoryDone: boolean;
  routines: Record<string, string>;
  moved: string[];
  failed: Record<string, string>;
  dropped: boolean;
  /** The report line for this area, kept in the journal so a resumed run reports what the whole migration did. */
  rep: EntryReport;
}
interface State {
  version: 1;
  startedAt: number;
  backupDir: string | null;
  entries: Record<string, EntryState>;
  noticeThreadId: string | null;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────

export interface EntryReport {
  key: string;
  kind: "general" | "project";
  title: string;
  blobId: string | null;
  blobName: string | null;
  threadsFound: number;
  threadsMoved: number;
  transcriptsCopied: number;
  factsFound: number;
  factsAdded: number;
  factsExisting: number;
  routinesFound: number;
  routinesCreated: number;
  filesCopied: number;
  filesKept: number;
  /** Things that did not move, in plain words. */
  skipped: string[];
}
export interface MigrationReport {
  at: number;
  mode: MigrationMode;
  entries: EntryReport[];
  backupDir: string | null;
  archivedChatsDir: string | null;
}
export type MigrationStatus =
  | "off"
  | "already"
  | "deferred"
  | "nothing"
  | "dry-run"
  | "done"
  | "partial";
export interface MigrationOutcome {
  status: MigrationStatus;
  report: MigrationReport | null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function renderNotice(report: MigrationReport): string {
  const lines: string[] = ["Chat is now part of Kora. Here is what I moved over:", ""];
  for (const e of report.entries) {
    if (e.kind === "general" && !e.threadsFound && !e.filesCopied && !e.skipped.length) continue; // General was empty
    const bits: string[] = [];
    if (e.threadsFound) bits.push(plural(e.threadsMoved, "chat"));
    if (e.factsAdded) bits.push(plural(e.factsAdded, "memory", "memories"));
    if (e.routinesCreated) bits.push(plural(e.routinesCreated, "routine"));
    if (e.filesCopied) bits.push(plural(e.filesCopied, "file"));
    const detail = bits.length ? ` (${bits.join(", ")})` : "";
    lines.push(
      e.kind === "general"
        ? `- Your **General** chats are now chats with me${detail}.`
        : `- **${e.title}** is now a blob called **${e.blobName ?? e.title}**${detail}. Its folder is in your Blobs folder.`,
    );
  }
  const left = report.entries.flatMap((e) =>
    e.skipped.map((s) => `${e.kind === "general" ? "General" : e.title}: ${s}`),
  );
  if (left.length) {
    lines.push("", "I could not move these:", ...left.slice(0, 25).map((s) => `- ${s}`));
    if (left.length > 25) lines.push(`- ...and ${left.length - 25} more`);
  }
  lines.push(
    "",
    "Nothing was deleted. The old Chat folders and conversations are kept as a backup" +
      (report.archivedChatsDir ? ` in ${report.archivedChatsDir}` : "") +
      ".",
  );
  return lines.join("\n");
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────

const stamp = (t: number): string =>
  new Date(t).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
const dateOnly = (t: number): string => new Date(t).toISOString().slice(0, 10);

function backupStores(home: string, t: number): string {
  const dir = path.join(home, `chat-migration-backup-${stamp(t)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["chat", "chats", "kora-daemon"]) {
    const src = path.join(home, name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dir, name), {
      recursive: true,
      preserveTimestamps: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  }
  return dir;
}

function uniqueName(base0: string, taken: Set<string>): string {
  const base = (base0.trim().replace(/\s+/g, " ") || "Chat project").slice(0, MAX_NAME).trim();
  const free = (n: string): boolean => !taken.has(n.toLowerCase());
  if (free(base)) return base;
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? " (Chat)" : ` (Chat ${i})`;
    const n = `${base.slice(0, MAX_NAME - suffix.length).trim()}${suffix}`;
    if (free(n)) return n;
  }
  return `${base.slice(0, MAX_NAME - 6)}-${Date.now() % 100000}`;
}

/** Copy `from`/ into `to`/ without overwriting: an existing different file keeps its name, the newcomer becomes
 *  "name (from Chat).ext". Returns what was copied and the path rewrites for renamed files. */
export function copyTree(
  fromDir: string,
  toDir: string,
): { copied: number; kept: number; renamed: Array<readonly [string, string]> } {
  let copied = 0;
  let kept = 0;
  const renamed: Array<readonly [string, string]> = [];
  const walk = (src: string, dst: string, depth: number): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < 12) walk(s, d, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      fs.mkdirSync(dst, { recursive: true });
      let target = d;
      if (fs.existsSync(d)) {
        if (sameFile(s, d)) {
          kept += 1;
          continue;
        }
        const ext = path.extname(e.name);
        const stem = e.name.slice(0, e.name.length - ext.length);
        target = path.join(dst, `${stem} (from Chat)${ext}`);
        for (let i = 2; fs.existsSync(target); i++) {
          if (sameFile(s, target)) break;
          target = path.join(dst, `${stem} (from Chat ${i})${ext}`);
        }
        if (fs.existsSync(target)) {
          kept += 1;
          renamed.push([s, target]);
          continue;
        }
        renamed.push([s, target]);
      }
      fs.copyFileSync(s, target);
      try {
        const st = fs.statSync(s);
        fs.utimesSync(target, st.atime, st.mtime);
      } catch {
        /* times are cosmetic */
      }
      copied += 1;
    }
  };
  walk(fromDir, toDir, 0);
  return { copied, kept, renamed };
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function soulFor(title: string, instructions: string): string {
  return [
    `You are the assistant for the "${title}" project. This work moved over from Kora Chat, so the brief below is your standing instructions: keep going the way it says.`,
    "",
    "## Standing brief (from the old project)",
    instructions ||
      "The project had no written instructions. When it matters, ask the user what the project is about, and keep what you learn in your working notes.",
    "",
    "## How you work",
    "- Short, warm replies; do the work properly. Put finished files in outputs/.",
    "- Files the user keeps for this project are in files/ - read from there first.",
  ].join("\n");
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────

const blankReport = (key: string, kind: "general" | "project", title: string): EntryReport => ({
  key,
  kind,
  title,
  blobId: null,
  blobName: null,
  threadsFound: 0,
  threadsMoved: 0,
  transcriptsCopied: 0,
  factsFound: 0,
  factsAdded: 0,
  factsExisting: 0,
  routinesFound: 0,
  routinesCreated: 0,
  filesCopied: 0,
  filesKept: 0,
  skipped: [],
});

function reportForPlan(p: PlanEntry): EntryReport {
  const r = blankReport(p.key, p.kind, p.folder?.title ?? p.title);
  r.threadsFound = p.threadIds.length;
  r.factsFound = p.folder ? parseMemoryLines(p.folder.memoryRaw).facts.length : 0;
  r.routinesFound = p.folder ? p.folder.schedules.length : 0;
  return r;
}

const errText = (cause: unknown): string => String((cause as Error)?.message ?? cause);

export async function runChatMigration(deps: ChatMigrationDeps): Promise<MigrationOutcome> {
  const { home, blobs, engine } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const tz =
    deps.timeZone ??
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        return "UTC";
      }
    })();
  if (deps.mode === "off") return { status: "off", report: null };
  if (fs.existsSync(path.join(home, MARKER))) return { status: "already", report: null };

  const statePath = path.join(home, STATE);
  const prior = deps.mode === "run" ? readJson<State>(statePath) : null;
  const plan = buildPlan(home, engine);

  if (plan.length === 0 && !prior) {
    if (deps.mode === "run")
      writeJson(path.join(home, MARKER), { version: 1, at: now(), status: "nothing" });
    return { status: "nothing", report: null };
  }

  if (deps.mode === "dry-run") {
    const report: MigrationReport = {
      at: now(),
      mode: "dry-run",
      entries: plan.map(reportForPlan),
      backupDir: null,
      archivedChatsDir: null,
    };
    writeJson(path.join(home, DRY_RUN_REPORT), {
      ...report,
      plan: plan.map((p) => ({
        key: p.key,
        kind: p.kind,
        title: p.title,
        root: p.root,
        projectIds: p.projectIds,
        threads: p.threadIds.length,
        files: p.folder?.files ?? 0,
        outputs: p.folder?.outputs ?? 0,
        schedules: p.folder?.schedules.length ?? 0,
      })),
    });
    log(
      `[chat-migration] dry run: ${plan.length} area(s), nothing changed (report: ${path.join(home, DRY_RUN_REPORT)})`,
    );
    return { status: "dry-run", report };
  }

  // Kora is needed for General's chats and as the engine to copy; not there yet -> try again at the next start.
  const kora = blobs.store.get(CHIEF_BLOB_ID);
  if (!kora) {
    log("[chat-migration] deferred: Kora (the Chief) does not exist yet");
    return { status: "deferred", report: null };
  }

  // ── journal + backup ────────────────────────────────────────────────────────────────────────────────
  const state: State = prior ?? {
    version: 1,
    startedAt: now(),
    backupDir: null,
    entries: {},
    noticeThreadId: null,
  };
  const save = (): void => writeJson(statePath, state);
  if (!state.backupDir || !fs.existsSync(state.backupDir)) {
    state.backupDir = backupStores(home, now());
    save();
    log(`[chat-migration] backup written to ${state.backupDir}`);
  }

  const allNames = (): Set<string> =>
    new Set(blobs.store.list({ includeArchived: true }).map((b) => b.name.toLowerCase()));
  const defaults = (() => {
    try {
      const d = blobs.store.defaults?.();
      return { permission: d?.permission ?? ("auto" as const), engine: d?.engine ?? null };
    } catch {
      return { permission: "auto" as const, engine: null };
    }
  })();
  const permission = defaults.permission;

  let unmigrated = 0;
  for (const p of plan) {
    const st: EntryState = (state.entries[p.key] ??= {
      blobId: null,
      name: null,
      filesDone: false,
      memoryDone: false,
      routines: {},
      moved: [],
      failed: {},
      dropped: false,
      rep: reportForPlan(p),
    });
    const rep = st.rep;
    // a resumed run: what the plan sees now (threads not yet moved) adds to what the journal already counts
    rep.threadsFound = Math.max(
      rep.threadsFound,
      st.moved.length + p.threadIds.filter((t) => !st.moved.includes(t)).length,
    );
    try {
      // 1. the target blob
      let target: BlobProfile | null = null;
      if (p.kind === "general") target = kora;
      else {
        if (st.blobId) target = blobs.store.get(st.blobId);
        if (!target) {
          const title = p.folder?.title ?? p.title;
          const created = await blobs.store.create({
            name: uniqueName(title, allNames()),
            title: "Chat project",
            soul: soulFor(title, p.folder?.instructions ?? ""),
            engine: p.engine ?? defaults.engine ?? deps.bestEngine?.() ?? kora.engine,
            permission,
            outfit: null,
            templateId: null,
          });
          target = created;
          st.blobId = created.id;
          st.name = created.name;
          save();
          log(`[chat-migration] "${title}" -> blob ${created.name}`);
        }
        engine.upsertBlobProject(target);
      }
      rep.blobId = target.id;
      rep.blobName = target.name;

      // 2. files + outputs (copy, never move: the originals stay in the backup folder)
      const rewrites: Array<readonly [string, string]> = [];
      if (p.folder) {
        for (const sub of ["outputs", "files"] as const) {
          const from = path.join(p.root, sub);
          if (!fs.existsSync(from)) continue;
          const r = copyTree(from, path.join(target.workspace, sub));
          if (!st.filesDone) {
            rep.filesCopied += r.copied;
            rep.filesKept += r.kept;
          }
          rewrites.push(...r.renamed);
          rewrites.push([from, path.join(target.workspace, sub)]);
        }
      }
      st.filesDone = true;
      rewrites.push([p.root, target.workspace]);
      rewrites.sort((a, b) => b[0].length - a[0].length);
      save();

      // 3. memory (projects only: General never had a memory.md of its own)
      if (p.kind === "project" && p.folder && !st.memoryDone) {
        const parsed = parseMemoryLines(p.folder.memoryRaw);
        rep.factsFound = parsed.facts.length;
        rep.skipped.push(...parsed.skipped.map((x) => `memory line not saved: "${x}"`));
        const addFact = blobs.memory.addFact;
        if (parsed.facts.length && !addFact) {
          rep.skipped.push(
            "memory is not available in this build: memory.md was left in the backup",
          );
        } else if (parsed.facts.length && addFact) {
          const have = new Set(
            (
              (await blobs.memory.listFacts({ scope: "blob", blobId: target.id })) as Array<{
                text?: string;
              }>
            ).map((f) =>
              String(f.text ?? "")
                .toLowerCase()
                .trim(),
            ),
          );
          for (const text of parsed.facts) {
            if (have.has(text.toLowerCase())) {
              rep.factsExisting += 1;
              continue;
            }
            try {
              await addFact.call(blobs.memory, { scope: "blob", blobId: target.id, text });
              rep.factsAdded += 1;
            } catch (cause) {
              rep.skipped.push(`memory line not saved ("${text.slice(0, 60)}"): ${errText(cause)}`);
            }
          }
        }
        st.memoryDone = true;
        save();
      }

      // 4. routines (projects only)
      if (p.kind === "project" && p.folder && blobs.routines) {
        const mine = p.threadIds.filter((id) => engine.threadExists(id));
        for (const [idx, s] of p.folder.schedules.entries()) {
          const sid = String(s.id ?? `#${idx}`);
          const title = String(s.title ?? "").trim() || `Routine ${idx + 1}`;
          if (st.routines[sid]) continue;
          const cadence = cadenceToRoutine(s.cadence, tz);
          if (!cadence || !String(s.prompt ?? "").trim()) {
            rep.skipped.push(
              `routine "${title}" has no readable ${cadence ? "prompt" : "schedule"}`,
            );
            continue;
          }
          // the thread the reports go to: the one the last run made, else the project's newest chat, else a new one
          const last = s.lastThreadId ? String(s.lastThreadId) : null;
          const results =
            last && engine.threadExists(last)
              ? { mode: "thread" as const, threadId: last }
              : mine[0]
                ? { mode: "thread" as const, threadId: mine[0] }
                : { mode: "dedicated" as const, threadId: null };
          const expired = cadence.kind === "once" && cadence.at <= now();
          const r = blobs.routines.create(
            {
              blobId: target.id,
              title: title.slice(0, 80),
              prompt: String(s.prompt),
              cadence,
              paused: s.enabled !== true || expired,
              results,
              rememberLastRun: false,
              maxRunMinutes: null,
            },
            "user",
          );
          if (r.ok) {
            st.routines[sid] = String((r.value as { id?: string } | null)?.id ?? sid);
            rep.routinesCreated += 1;
            if (s.enabled === true && expired)
              rep.skipped.push(
                `routine "${title}" was a one-time schedule whose time has passed: kept, paused`,
              );
            save();
          } else rep.skipped.push(`routine "${title}": ${r.message}`);
        }
      } else if (p.kind === "project" && p.folder?.schedules.length && !blobs.routines) {
        rep.skipped.push(
          "routines are not available in this build: schedules.json was left in the backup",
        );
      }

      // 5. threads
      for (const threadId of p.threadIds) {
        if (st.moved.includes(threadId)) continue;
        const res = await engine.moveThread(
          threadId,
          { id: target.id, workspace: target.workspace },
          rewrites,
        );
        if (res.moved) {
          st.moved.push(threadId);
          delete st.failed[threadId];
          rep.threadsMoved = st.moved.length;
          if (res.transcriptCopied) rep.transcriptsCopied += 1;
        } else {
          st.failed[threadId] = res.reason ?? "unknown";
          rep.skipped.push(`chat ${threadId}: ${res.reason ?? "could not be moved"}`);
        }
        save();
      }
      rep.threadsMoved = st.moved.length;

      // 6. the emptied legacy project heads
      const stuck = p.threadIds.some((t) => !st.moved.includes(t));
      if (!stuck && !st.dropped) {
        for (const id of p.projectIds) engine.dropProject(id);
        st.dropped = true;
      }
      if (stuck) unmigrated += 1;
      save();
    } catch (cause) {
      unmigrated += 1;
      rep.skipped.push(`not moved: ${errText(cause)}`);
      save();
      log(`[chat-migration] ${p.key} failed: ${String((cause as Error)?.stack ?? cause)}`);
    }
  }
  // areas finished by an earlier (interrupted) run still count in the report
  const reports = Object.values(state.entries).map((e) => e.rep);

  // ── the notice, then the old folder aside, then the marker ──────────────────────────────────────────
  const worthSaying = reports.some(
    (e) =>
      e.threadsFound ||
      e.filesCopied ||
      e.factsAdded ||
      e.routinesCreated ||
      e.skipped.length ||
      e.kind === "project",
  );
  let archived: string | null = null;
  const draft: MigrationReport = {
    at: now(),
    mode: "run",
    entries: reports,
    backupDir: state.backupDir,
    archivedChatsDir: null,
  };
  if (unmigrated === 0 && fs.existsSync(legacyChatsDir(home))) {
    let target = path.join(home, `chats.migrated-${dateOnly(now())}`);
    for (let i = 2; fs.existsSync(target); i++)
      target = path.join(home, `chats.migrated-${dateOnly(now())}-${i}`);
    archived = target;
    draft.archivedChatsDir = target;
  }
  if (worthSaying && !(state.noticeThreadId && engine.threadExists(state.noticeThreadId))) {
    state.noticeThreadId = engine.postNotice(
      CHIEF_BLOB_ID,
      "Moved your Chat projects into Kora",
      renderNotice(draft),
    );
    save();
  }
  if (archived) {
    try {
      fs.renameSync(legacyChatsDir(home), archived);
    } catch (cause) {
      archived = null;
      draft.archivedChatsDir = null;
      log(`[chat-migration] could not move chats/ aside: ${errText(cause)}`);
    }
  }
  const report: MigrationReport = { ...draft, archivedChatsDir: archived };
  writeJson(path.join(home, MARKER), {
    version: 1,
    at: now(),
    status: unmigrated === 0 ? "done" : "partial",
    backupDir: state.backupDir,
    archivedChatsDir: archived,
    noticeThreadId: state.noticeThreadId,
    entries: reports,
  });
  log(
    `[chat-migration] ${unmigrated === 0 ? "done" : "partial"}: ` +
      reports
        .map(
          (e) =>
            `${e.kind === "general" ? "General" : e.title} (${e.threadsMoved}/${e.threadsFound} chats, ${e.factsAdded} facts, ${e.routinesCreated} routines, ${e.filesCopied} files)`,
        )
        .join("; "),
  );
  return { status: unmigrated === 0 ? "done" : "partial", report };
}
