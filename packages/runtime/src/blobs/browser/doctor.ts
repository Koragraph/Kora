// `kora doctor` check for the blob browser: is the engine installed, which version, and does it really launch and answer
// over CDP. Exported for the doctor command to call later; it never throws and never downloads anything.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Cdp } from './cdp';
import { browserCacheDir, ENGINE_VERSION, findInstalledEngine, launchEngine, pinnedEngine } from './engine';

export interface DoctorCheck { name: string; ok: boolean; detail: string }
export interface BrowserDoctorReport { ok: boolean; installed: boolean; checks: DoctorCheck[] }

export async function browserDoctor(o: { dir?: string; bin?: string; smoke?: boolean } = {}): Promise<BrowserDoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const dir = o.dir ?? browserCacheDir();
  const pinned = pinnedEngine();
  add('platform', !!pinned, pinned ? `${process.platform}-${process.arch}` : `the blob browser is not available on ${process.platform}-${process.arch}`);
  let bin = o.bin ?? null;
  let installed = !!bin;
  if (!bin && pinned) {
    const found = await findInstalledEngine(dir).catch(() => null);
    installed = !!found;
    bin = found?.bin ?? null;
    add('engine installed', !!found, found ? `chrome-headless-shell ${found.version} at ${found.dir}` : `not installed (pinned ${ENGINE_VERSION}, about ${pinned.build ? Math.round(pinned.build.size / 1048576) : 98} MB, downloaded when you open a blob's browser)`);
  } else if (bin) add('engine installed', true, bin);
  if (bin && o.smoke !== false) {
    const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'kora-browser-doctor-'));
    const t0 = performance.now();
    let eng: Awaited<ReturnType<typeof launchEngine>> | null = null;
    try {
      eng = await launchEngine({ bin, profileDir: profile, registryDir: dir });
      const cdp = await new Cdp(eng.wsUrl).connect();
      const v = await cdp.send('Browser.getVersion');
      const { targetInfos } = await cdp.send('Target.getTargets');
      add('launch smoke', true, `${v.product} started in ${Math.round(performance.now() - t0)} ms, ${targetInfos.length} target(s)`);
      add('version', !pinned || String(v.product).includes(pinned.version.split('.')[0]), String(v.product));
      try { await cdp.send('Browser.close', {}, undefined, 3000); } catch { /* dropped socket is the normal reply */ }
      cdp.close();
    } catch (e) {
      add('launch smoke', false, (e as Error).message.split('\n')[0].slice(0, 200));
    } finally {
      if (eng) { await Promise.race([eng.exited, new Promise((r) => setTimeout(r, 4000))]); if (!eng.hasExited()) { try { eng.proc.kill('SIGKILL'); } catch { /* gone */ } await eng.exited; } }
      await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }
  // "not installed" is a state to fix, not a broken install: ok means nothing that IS present is broken.
  return { ok: checks.every((c) => c.ok), installed, checks };
}
