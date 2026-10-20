// @effect-diagnostics nodeBuiltinImport:off -- the boundary to plain files and a child process.
// @effect-diagnostics globalDate:off -- plain wall-clock reads outside any Effect fiber.
/**
 * First-page thumbnails of Word documents and PowerPoint decks (`GET /api/blobs/:blobId/thumbnail?path=`).
 *
 * Why the daemon, and why Quick Look: a document's first page needs real layout (fonts, tables, images, charts). A
 * browser-side renderer would be a second, always-approximate implementation of Word and PowerPoint that someone has to
 * keep fixing; macOS already ships the one that matters (`qlmanage -t`, the same engine as Finder's preview), Kora is a
 * macOS app, and it answers in a fraction of a second. Where it is missing (another OS, a sandbox) or fails, the route
 * says 404 and the card keeps its text excerpt - a thumbnail is a convenience, never a gate.
 *
 * Safety: only the daemon reads the file (the route has already confined the path to the blob's workspace), the child is
 * killed after `TIMEOUT_MS`, one thumbnail is made at a time (a burst of cards never spawns a burst of processes), results
 * are cached on disk by content identity (path + size + mtime) and the cache is bounded.
 */
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";

import { koraHome } from "./assistantFs.ts";

export const THUMB_EXTENSIONS = new Set([".docx", ".pptx"]);
const THUMB_SIZE = 960;
const TIMEOUT_MS = 20_000;
const MAX_CACHE_FILES = 300;
const MAX_CACHE_AGE_MS = 21 * 24 * 3600 * 1000;
const QLMANAGE = "/usr/bin/qlmanage";

export type ThumbRunner = (file: string, outDir: string, size: number) => Promise<void>;

const defaultRunner: ThumbRunner = (file, outDir, size) =>
  new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      QLMANAGE,
      ["-t", "-s", String(size), "-o", outDir, file],
      { timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.end();
  });

const thumbCacheDir = (): string => NodePath.join(koraHome(), "cache", "blob-thumbs");

const keyOf = (file: string, st: NodeFS.Stats, size: number): string =>
  NodeCrypto.createHash("sha1")
    .update(`${file}\0${st.size}\0${Math.trunc(st.mtimeMs)}\0${size}`)
    .digest("hex")
    .slice(0, 32);

let tail: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<string | null>>();

function prune(dir: string): void {
  try {
    const now = Date.now();
    const files = NodeFS.readdirSync(dir)
      .filter((n) => n.endsWith(".png"))
      .map((n) => ({ n, st: NodeFS.statSync(NodePath.join(dir, n)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    files.forEach((f, i) => {
      if (i >= MAX_CACHE_FILES || now - f.st.mtimeMs > MAX_CACHE_AGE_MS)
        NodeFS.rmSync(NodePath.join(dir, f.n), { force: true });
    });
  } catch {
    /* the cache is advisory */
  }
}

/**
 * The PNG path of `file`'s first page, or null when no thumbnail can be made. `run` is the child-process seam (tests).
 * Never throws; concurrent requests for one file share one job.
 */
export function blobThumbnail(
  file: string,
  opts: { size?: number; run?: ThumbRunner; hasRenderer?: boolean; dir?: string } = {},
): Promise<string | null> {
  const size = opts.size ?? THUMB_SIZE;
  const run = opts.run ?? defaultRunner;
  if (!THUMB_EXTENSIONS.has(NodePath.extname(file).toLowerCase())) return Promise.resolve(null);
  // the renderer is macOS's own: where /usr/bin/qlmanage is not there (another OS), there is simply no thumbnail
  if (!opts.run && !(opts.hasRenderer ?? NodeFS.existsSync(QLMANAGE))) return Promise.resolve(null);
  let st: NodeFS.Stats;
  try {
    st = NodeFS.statSync(file);
  } catch {
    return Promise.resolve(null);
  }
  const dir = opts.dir ?? thumbCacheDir();
  const key = keyOf(file, st, size);
  const target = NodePath.join(dir, `${key}.png`);
  try {
    if (NodeFS.statSync(target).size > 0) {
      NodeFS.utimesSync(target, new Date(), new Date());
      return Promise.resolve(target);
    }
  } catch {
    /* not cached yet */
  }
  const shared = inFlight.get(key);
  if (shared) return shared;
  const job = (async () => {
    // one at a time: a chat full of cards must not spawn a burst of Quick Look children
    const mine = tail.then(async (): Promise<string | null> => {
      let work: string | null = null;
      try {
        NodeFS.mkdirSync(dir, { recursive: true });
        work = NodeFS.mkdtempSync(NodePath.join(dir, "work-"));
        await run(file, work, size);
        const made = NodeFS.readdirSync(work).find((n) => n.toLowerCase().endsWith(".png"));
        if (!made) return null;
        const produced = NodePath.join(work, made);
        if (NodeFS.statSync(produced).size === 0) return null;
        NodeFS.renameSync(produced, target);
        prune(dir);
        return target;
      } catch {
        return null;
      } finally {
        if (work) NodeFS.rmSync(work, { recursive: true, force: true });
      }
    });
    tail = mine.catch(() => undefined);
    return mine;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
