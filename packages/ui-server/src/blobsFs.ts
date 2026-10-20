// @effect-diagnostics nodeBuiltinImport:off -- the boundary to the Blobs surface's plain files under KORA_HOME and ~/Blobs.
// @effect-diagnostics globalDate:off -- plain wall-clock reads outside any Effect fiber.
/**
 * Blobs' plain files, ui-server side (docs/bots/ARCH.md section 1.1): the workspace-wide about-me note, the New-blob
 * defaults, the UI flags, the Trash move for a real delete, and the outputs/files listing. Profile truth, SOUL.md and
 * memory belong to the runtime (`runtime.blobs`); only files the Settings pages edit directly live here. The folder
 * helpers (`blobsRoot`, `isBlobsCwd`, ...) are in assistantFs.ts, which must stay byte-identical to runtime `blobs/home.ts`.
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { BlobDefaults, type BlobFlagKey, type BlobFlags } from "@kora/contracts";
import * as Schema from "effect/Schema";

import {
  writeFileAtomic,
  readTextFile,
  listWorkspaceFiles,
  koraHome,
  type WorkspaceFileEntry,
} from "./assistantFs.ts";

/** SPEC: workspace-wide context added to every blob turn, at most this many characters. */
export const ABOUT_ME_MAX_CHARS = 24_000;

const aboutMePath = (): string => path.join(koraHome(), "profile", "about-me.md");
const defaultsPath = (): string => path.join(koraHome(), "blob-defaults.json");
const flagsPath = (): string => path.join(koraHome(), "blobs", "_settings.json");

export function readAboutMe(): string {
  return readTextFile(aboutMePath());
}
/** Throws on an over-long note: silently truncating what the user wrote would lose their text. */
export function writeAboutMe(text: string): string {
  if (text.length > ABOUT_ME_MAX_CHARS)
    throw new Error(
      `About me is ${text.length.toLocaleString("en-US")} characters; the limit is ${ABOUT_ME_MAX_CHARS.toLocaleString("en-US")}.`,
    );
  writeFileAtomic(aboutMePath(), text);
  return text;
}

export const DEFAULT_SOUL_TEMPLATE =
  "You are a friendly, capable coworker. Be warm and concise, with a little character, never cutesy in the work itself. " +
  "Ask before anything that sends, posts, deletes or pays. Put finished work in outputs/ and say where it is.";

function defaultBlobDefaults(): BlobDefaults {
  return { engine: null, permission: "auto", soulTemplate: DEFAULT_SOUL_TEMPLATE };
}

/** The New-blob template; a missing or damaged file reads as the built-in defaults (never throws). */
export function readBlobDefaults(): BlobDefaults {
  try {
    const raw = JSON.parse(fs.readFileSync(defaultsPath(), "utf8")) as unknown;
    return Schema.decodeUnknownSync(BlobDefaults)({ ...defaultBlobDefaults(), ...(raw as object) });
  } catch {
    return defaultBlobDefaults();
  }
}
export function writeBlobDefaults(next: BlobDefaults): BlobDefaults {
  const clean = Schema.decodeUnknownSync(BlobDefaults)(next);
  writeFileAtomic(defaultsPath(), JSON.stringify(clean, null, 2) + "\n");
  return clean;
}

const DEFAULT_FLAGS: BlobFlags = {
  concurrencyWarningDismissed: false,
  galleryDismissed: false,
  claudeMemoryFallback: false,
};

export function readBlobFlags(): BlobFlags {
  try {
    const raw = JSON.parse(fs.readFileSync(flagsPath(), "utf8")) as Partial<BlobFlags>;
    return {
      concurrencyWarningDismissed: raw.concurrencyWarningDismissed === true,
      galleryDismissed: raw.galleryDismissed === true,
      claudeMemoryFallback: raw.claudeMemoryFallback === true,
    };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}
export function writeBlobFlag(key: BlobFlagKey, value: boolean): BlobFlags {
  const next = { ...readBlobFlags(), [key]: value };
  writeFileAtomic(flagsPath(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** `~/.Trash`, or `KORA_TRASH_DIR` (tests, sandboxes). */
function trashDir(): string {
  return process.env.KORA_TRASH_DIR || path.join(os.homedir(), ".Trash");
}

/**
 * Move a blob's workspace into the Trash by rename (never `rm`), de-duplicating the name the way Finder does.
 * Returns where it went, or null when the folder is already gone. A cross-volume move cannot be a rename: that
 * throws, and the caller must not have deleted anything yet.
 */
export function moveToTrash(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const trash = trashDir();
  fs.mkdirSync(trash, { recursive: true });
  const base = path.basename(dir);
  let target = path.join(trash, base);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(trash, `${base} ${i}`);
  try {
    fs.renameSync(dir, target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "EXDEV")
      throw new Error(
        `${dir} is on another disk than the Trash, so Kora cannot move it there. Drag the folder to the Trash yourself, then delete the blob.`,
      );
    throw cause;
  }
  return target;
}

/** A blob's deliverables and inputs: `outputs/` then `files/` (depth-bounded, newest first overall). */
export function listBlobFiles(workspace: string, since: number | null): WorkspaceFileEntry[] {
  const all = [
    ...listWorkspaceFiles(path.join(workspace, "outputs"), workspace, 3),
    ...listWorkspaceFiles(path.join(workspace, "files"), workspace, 3),
  ].sort((a, b) => b.modifiedAt - a.modifiedAt);
  return since == null ? all : all.filter((f) => f.modifiedAt >= since);
}

/** The largest file `GET /api/blobs/:blobId/file` streams (the previews' own cap is smaller). */
export const BLOB_FILE_MAX_BYTES = 25 * 1024 * 1024;

const FILE_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export type BlobFileLookup =
  | {
      readonly ok: true;
      readonly filePath: string;
      readonly name: string;
      readonly mimeType: string;
      readonly size: number;
    }
  | { readonly ok: false; readonly status: 404 | 413 };

/**
 * A file inside a blob's workspace, for streaming. `relativePath` must be relative and stay inside the workspace after
 * symlinks are resolved (both the folder and the file are realpath'd): `..`, absolute paths, NUL bytes and a symlink
 * pointing outside all answer not-found. A directory is not a file. Over `BLOB_FILE_MAX_BYTES` answers 413.
 */
export function resolveBlobFile(workspace: string, relativePath: string): BlobFileLookup {
  const notFound = { ok: false, status: 404 } as const;
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath))
    return notFound;
  try {
    const root = fs.realpathSync(workspace);
    const real = fs.realpathSync(path.join(root, relativePath));
    if (real !== root && !real.startsWith(root + path.sep)) return notFound;
    const stat = fs.statSync(real);
    if (!stat.isFile()) return notFound;
    if (stat.size > BLOB_FILE_MAX_BYTES) return { ok: false, status: 413 };
    return {
      ok: true,
      filePath: real,
      name: path.basename(real),
      mimeType: FILE_MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream",
      size: stat.size,
    };
  } catch {
    return notFound;
  }
}

/** `etag` + `last-modified` of a workspace file (size + mtime); empty when it cannot be stat'ed. */
export function blobFileVersionHeaders(filePath: string): Record<string, string> {
  try {
    const st = fs.statSync(filePath);
    return {
      etag: `"${st.size}-${Math.trunc(st.mtimeMs)}"`,
      "last-modified": new Date(st.mtimeMs).toUTCString(),
    };
  } catch {
    return {};
  }
}
