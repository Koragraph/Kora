// Which Kora this build is. The free app ships today; Kora Pro (Koragent workers and the rest of the paid layer) is
// built later. Plan-usage tracking (probes, usage-limits.json, /api/usage) runs in every edition and is never gated. Pro-only features stay in the tree but are refused at their entry
// points here and hidden in the client (apps/web/src/branding.ts KORA_EDITION — keep the two in step).

export type KoraEdition = 'free' | 'pro';

export const KORA_EDITION: KoraEdition = 'free';

let edition: KoraEdition = KORA_EDITION;

export const isProEdition = (): boolean => edition === 'pro';

/** The one message every refused Pro-only entry point gives. */
export function proOnlyMessage(feature: string): string {
  return `${feature} is part of Kora Pro. This is the free edition of Kora.`;
}

/** Tests of Pro-only code (Koragent workers) run as Pro; the free gates have their own tests. */
export function setEditionForTests(next: KoraEdition): void {
  edition = next;
}

// ── The Kora surface (blobs) ────────────────────────────────────────────────────────────────────────────────────
// The first launch ships Kora Code only: the Kora surface (blobs, memory, routines, the Chief, outside access) shows a
// coming-soon screen and the daemon starts none of its background work. The code stays in the tree. The client twin is
// KORA_SURFACE in apps/web/src/branding.ts (keep the two in step); the client also follows this daemon's answer, which
// rides on the blobs snapshot (`koraSurface`).
//
// Developer override (every build defaults to coming-soon, Kora Dev included): start the daemon with KORA_SURFACE=on,
// or put the word `on` in <KORA_HOME>/kora-surface, then restart the daemon.

export type KoraSurface = 'coming-soon' | 'on';

export const KORA_SURFACE: KoraSurface = 'coming-soon';

let surfaceForTests: KoraSurface | null = null;
/** The override file is read once per home (the daemon reads it at boot; a change needs a restart, like the env var). */
let fileOverride: { home: string; value: KoraSurface | null } | null = null;

function surfaceOverride(): KoraSurface | null {
  if (process.env.KORA_SURFACE === 'on') return 'on';
  if (process.env.KORA_SURFACE === 'coming-soon') return 'coming-soon';
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const home = process.env.KORA_HOME || path.join(os.homedir(), '.kora');
  if (fileOverride?.home !== home) {
    let value: KoraSurface | null = null;
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      if (fs.readFileSync(path.join(home, 'kora-surface'), 'utf8').trim().toLowerCase() === 'on') value = 'on';
    } catch { /* no override file */ }
    fileOverride = { home, value };
  }
  return fileOverride.value;
}

/** What this daemon does with the Kora surface: the test setter, else the developer override, else the build's switch. */
export function koraSurface(): KoraSurface {
  return surfaceForTests ?? surfaceOverride() ?? KORA_SURFACE;
}

export const isKoraSurfaceOn = (): boolean => koraSurface() === 'on';

/** The one message every gated Kora entry point gives. */
export const KORA_COMING_SOON_MESSAGE = 'Kora is coming soon. This build ships Kora Code only.';

/** Tests of blob code that must run as if Kora were on (or off); null = back to the real switch. */
export function setKoraSurfaceForTests(next: KoraSurface | null): void {
  surfaceForTests = next;
}
