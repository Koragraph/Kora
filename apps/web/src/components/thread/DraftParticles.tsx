// The new-thread hero: the kora sprite drawn in dots. The pointer pushes them away and they spring home; a press throws
// them out in a shockwave and they gather into the next kora: plain, then each accessory in turn (crown, glasses, hats...).
// Every version is sampled to the same N points, each taking the grey of the sprite pixel it lands on, and a change pairs
// dots to new homes by angle round the middle so the swarm sweeps rather than crossing itself. The rAF loop parks the
// moment every dot is home, so an idle hero costs nothing.
import { useEffect, useRef } from "react";

import {
  ACCESSORY_IDS,
  GRID,
  MONO,
  composeRows,
  usePrefersReducedMotion,
  type SpriteAccessory,
} from "../sprite";

// Drawing space; the canvas is shown at CSS_W and every coordinate is scaled to it.
const W = 480;
const H = 400;
const CX = W / 2;
const CY = H / 2;
const CSS_W = 300;
const N = 720;
const DOT_R = 2.6;
const CELL = 32;

const VERSIONS: readonly (SpriteAccessory | null)[] = [null, ...ACCESSORY_IDS];
type Home = readonly [x: number, y: number, colour: string];
type Dot = { hx: number; hy: number; x: number; y: number; vx: number; vy: number; c: string };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const angle = (x: number, y: number) => Math.atan2(y - CY, x - CX);

const homeCache = new Map<SpriteAccessory | null, Home[]>();

/** N points spread evenly over one kora version: a hex grid spaced to hold about N over its lit pixels, then thinned
 *  or repeated to exactly N. Eyes (K) and blanks are holes. */
function homes(version: SpriteAccessory | null): Home[] {
  const cached = homeCache.get(version);
  if (cached) return cached;
  const rows = composeRows("idle", version);
  const ox = CX - (GRID * CELL) / 2;
  const oy = CY - (GRID * CELL) / 2;
  const colourAt = (x: number, y: number): string | null => {
    const ch = rows[Math.floor((y - oy) / CELL)]?.[Math.floor((x - ox) / CELL)];
    return ch && ch !== "." && ch !== "K" ? (MONO[ch] ?? null) : null;
  };
  const lit = rows.join("").replace(/[.K]/g, "").length;
  const sp = Math.sqrt(((lit * CELL * CELL) / N) * (2 / Math.sqrt(3)));
  const rowH = (sp * Math.sqrt(3)) / 2;
  const pts: Home[] = [];
  for (let y = rowH / 2, row = 0; y < H; y += rowH, row++)
    for (let x = sp / 2 + (row % 2) * (sp / 2); x < W; x += sp) {
      const c = colourAt(x, y);
      if (c) pts.push([x, y, c]);
    }
  if (!pts.length) return [];
  const out = Array.from({ length: N }, (_, i) => pts[Math.floor((i * pts.length) / N)]!);
  homeCache.set(version, out);
  return out;
}

export function DraftParticles({ className }: { readonly className?: string }) {
  const still = usePrefersReducedMotion();
  const cv = useRef<HTMLCanvasElement | null>(null);
  const dots = useRef<Dot[]>([]);
  const at = useRef(0);
  const hand = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);

  const become = (v: number) => {
    at.current = v;
    const next = homes(VERSIONS[v] ?? null);
    const ds = dots.current;
    if (!next.length) return;
    if (!ds.length) {
      dots.current = next.map(([x, y, c]) => ({ hx: x, hy: y, x, y, vx: 0, vy: 0, c }));
      return;
    }
    const a = ds.map((d, i) => [angle(d.x, d.y), i] as const).sort((p, q) => p[0] - q[0]);
    const b = next.map((h, i) => [angle(h[0], h[1]), i] as const).sort((p, q) => p[0] - q[0]);
    a.forEach(([, di], k) => {
      const h = next[b[k]![1]]!;
      const d = ds[di]!;
      d.hx = h[0];
      d.hy = h[1];
      d.c = h[2];
      if (still) {
        d.x = h[0];
        d.y = h[1];
      }
    });
  };

  const draw = () => {
    const c = cv.current;
    const x = c?.getContext("2d");
    if (!c || !x) return;
    const k = c.width / W;
    x.setTransform(k, 0, 0, k, 0, 0);
    x.clearRect(0, 0, W, H);
    // one path per grey, a handful of fills a frame
    const byColour = new Map<string, Dot[]>();
    for (const d of dots.current) byColour.set(d.c, [...(byColour.get(d.c) ?? []), d]);
    for (const [colour, group] of byColour) {
      x.fillStyle = colour;
      x.beginPath();
      for (const d of group) {
        const sp = Math.hypot(d.vx, d.vy);
        if (sp < 0.3) {
          x.moveTo(d.x + DOT_R, d.y);
          x.arc(d.x, d.y, DOT_R, 0, Math.PI * 2);
        } else {
          // a moving dot is drawn long along its path, a little thin across it
          const s = Math.min(2.6, 1 + sp * 0.12);
          const rot = Math.atan2(d.vy, d.vx);
          x.moveTo(d.x + Math.cos(rot) * DOT_R * s, d.y + Math.sin(rot) * DOT_R * s);
          x.ellipse(d.x, d.y, DOT_R * s, DOT_R / Math.sqrt(s), rot, 0, Math.PI * 2);
        }
      }
      x.fill();
    }
  };

  const run = () => {
    if (raf.current) return;
    let prev = 0;
    const tick = (t: number) => {
      // frames, not ms: damping is raised to dt so a dropped frame decays as much as the two it replaced
      const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      const h = hand.current;
      const reach = 80;
      const push = 0.6 * 11;
      let busy = !!h;
      for (const d of dots.current) {
        if (h) {
          const dx = d.x - h.x;
          const dy = d.y - h.y;
          const distance = Math.hypot(dx, dy);
          if (distance < reach && distance > 0.01) {
            const f = (1 - distance / reach) ** 2 * push;
            d.vx += (dx / distance) * f * dt;
            d.vy += (dy / distance) * f * dt;
          }
        }
        d.vx = (d.vx + (d.hx - d.x) * 0.05 * dt) * 0.84 ** dt;
        d.vy = (d.vy + (d.hy - d.y) * 0.05 * dt) * 0.84 ** dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        if (
          Math.abs(d.hx - d.x) < 0.05 &&
          Math.abs(d.hy - d.y) < 0.05 &&
          Math.abs(d.vx) < 0.02 &&
          Math.abs(d.vy) < 0.02
        ) {
          d.x = d.hx;
          d.y = d.hy;
          d.vx = 0;
          d.vy = 0;
        } else busy = true;
      }
      draw();
      raf.current = busy ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(CSS_W * dpr);
    c.height = Math.round(((CSS_W * H) / W) * dpr);
    become(at.current);
    draw();
    return () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, []);

  const where = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = r.width / W;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  return (
    <canvas
      ref={cv}
      aria-hidden="true"
      className={className}
      style={{ width: CSS_W, height: (CSS_W * H) / W }}
      onPointerMove={(e) => {
        if (still) return;
        hand.current = where(e);
        run();
      }}
      onPointerLeave={() => {
        hand.current = null;
        run();
      }}
      onPointerDown={(e) => {
        const p = where(e);
        if (!still) {
          for (const d of dots.current) {
            const dx = d.x - p.x;
            const dy = d.y - p.y;
            const distance = Math.hypot(dx, dy);
            if (distance > 200 || distance < 0.01) continue;
            const f = (1 - distance / 200) * 30 * 1.12;
            d.vx += (dx / distance) * f;
            d.vy += (dy / distance) * f;
          }
        }
        become((at.current + 1) % VERSIONS.length);
        draw();
        run();
      }}
    />
  );
}
