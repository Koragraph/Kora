// One BlobBrowserHost per blob, created lazily, at most `maxConcurrent` running (LRU eviction of the longest-idle
// one), all closed gracefully at daemon shutdown, orphans from a crashed daemon swept at startup.
import fs from 'node:fs';
import path from 'node:path';
import { BlobBrowserHost, type BlobBrowserHostOptions, type BlobBrowserSettings } from './host';
import { browserCacheDir, engineStatus, ensureEngine, sweepOrphans, type EngineStatus, type InstallProgress, type SweepResult } from './engine';

export interface BrowserManagerOptions {
  /** Profile dir of a blob: `<blob folder>/.browser-profile`. */
  profileDirFor(blobId: string): string;
  requestApproval?: BlobBrowserHostOptions['requestApproval'];
  /** Live per-blob browser settings (local-dev-server allowlist, download opt-in). Read on every request, so edits apply at once. */
  settingsFor?(blobId: string): Partial<BlobBrowserSettings>;
  /** `<blob workspace>/downloads` of a blob. Without it downloads are always denied. */
  downloadsDirFor?(blobId: string): string | undefined;
  /** Applied to every host (browserDir, bin, idleCloseMs, log, onInstallProgress ...). */
  hostDefaults?: Partial<Omit<BlobBrowserHostOptions, 'blobId' | 'profileDir' | 'requestApproval' | 'beforeStart' | 'settings' | 'downloadsDir'>>;
  maxConcurrent?: number; // default 3
}

export class BlobBrowserManager {
  private hosts = new Map<string, BlobBrowserHost>();
  private max: number;
  constructor(private o: BrowserManagerOptions) { this.max = o.maxConcurrent ?? 3; }

  /** Run once at daemon start, before any host. */
  sweepOrphans(): Promise<SweepResult> { return sweepOrphans({ dir: this.o.hostDefaults?.browserDir, log: this.o.hostDefaults?.log }); }

  /** The blob's host (created on first use; the browser itself starts on the first tool call). */
  get(blobId: string): BlobBrowserHost {
    let h = this.hosts.get(blobId);
    if (!h) {
      h = new BlobBrowserHost({ ...this.o.hostDefaults, blobId, profileDir: this.o.profileDirFor(blobId), requestApproval: this.o.requestApproval, beforeStart: () => this.makeRoom(blobId), settings: this.o.settingsFor ? () => this.o.settingsFor!(blobId) : undefined, downloadsDir: this.o.downloadsDirFor?.(blobId) });
      this.hosts.set(blobId, h);
    }
    return h;
  }
  peek(blobId: string): BlobBrowserHost | undefined { return this.hosts.get(blobId); }

  /** Call before starting blobId's browser: closes the longest-idle other running browser if the cap is reached. */
  async makeRoom(blobId: string): Promise<void> {
    const running = [...this.hosts.values()].filter((h) => h.isRunning && h.blobId !== blobId);
    if (running.length < this.max) return;
    const victim = running.filter((h) => !h.isBusy()).sort((a, b) => b.idleMs() - a.idleMs())[0];
    if (victim) await victim.stop();
  }

  /** The engine ("Setting up the blob browser", ~98 MB): state and a one-shot, shared, progress-reporting install. */
  engine = {
    status: (): Promise<EngineStatus> => engineStatus(this.o.hostDefaults?.browserDir ?? browserCacheDir()),
    install: async (onProgress?: (p: InstallProgress) => void): Promise<void> => { await ensureEngine({ dir: this.o.hostDefaults?.browserDir ?? browserCacheDir(), onProgress }); },
  };

  /**
   * What the ui-server's live route (`/blob-browser/:blobId/live`) and the status/install RPCs talk to. `exists` says
   * whether a blob id is a real, non-archived blob (an unknown id gets no browser).
   */
  liveSource(exists: (blobId: string) => boolean): LiveBrowserSource {
    return { get: (blobId) => (exists(blobId) ? this.get(blobId) : undefined), engine: this.engine, settingsChanged: (blobId) => this.settingsChanged(blobId), close: (blobId) => this.close(blobId), clearData: (blobId) => this.clearData(blobId) };
  }

  /** A blob's browser settings changed (allowlist / downloads): apply them to the running browser. */
  async settingsChanged(blobId: string): Promise<void> { await this.hosts.get(blobId)?.settingsChanged(); }

  /**
   * "Clear browser data": sign the blob out of every site. Its browser is closed first (cookies flush on a graceful
   * stop, so the wipe comes after), then its profile folder is deleted; the next browse starts a fresh profile.
   * Only a folder named `browser-profile` is ever removed (pl8 S2-2).
   */
  async clearData(blobId: string): Promise<{ cleared: boolean }> {
    await this.close(blobId);
    const dir = path.resolve(this.o.profileDirFor(blobId));
    if (path.basename(dir) !== 'browser-profile' || dir.split(path.sep).filter(Boolean).length < 3) throw new Error(`refusing to clear ${dir}`);
    const existed = fs.existsSync(dir);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return { cleared: existed };
  }

  /** Close one blob's browser (blob deleted / archived) and forget the host. */
  async close(blobId: string): Promise<void> { const h = this.hosts.get(blobId); this.hosts.delete(blobId); if (h) await h.stop(); }
  /** Daemon shutdown: graceful, in parallel. */
  async shutdown(): Promise<void> { const all = [...this.hosts.values()]; this.hosts.clear(); await Promise.all(all.map((h) => h.stop().catch(() => {}))); }
}

/** The structural contract the ui-server route consumes (it cannot import runtime types: it ships as a separate bundle). */
export interface LiveBrowserSource {
  get(blobId: string): BlobBrowserHost | undefined;
  engine: { status(): Promise<EngineStatus>; install(onProgress?: (p: InstallProgress) => void): Promise<void> };
  settingsChanged(blobId: string): Promise<void>;
  close(blobId: string): Promise<void>;
  clearData(blobId: string): Promise<{ cleared: boolean }>;
}
