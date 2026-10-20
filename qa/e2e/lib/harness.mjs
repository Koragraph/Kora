// Kora QA harness: one small shared library for every spec under qa/e2e/<area>/*.spec.mjs.
//
//   import { spec, stackOf, seedOf } from '../lib/harness.mjs';
//   spec('02-sidebar', { stack: 1 }, async (t) => {
//     await t.test('pin a thread', async ({ page, open, defect, covered, expect }) => { ... });
//   });
//
// Every test gets a fresh Chromium page (login-free: the stack's Vite proxy injects the UI token), with console
// errors, page errors, failed requests (4xx/5xx, network failures) and websocket closes captured. A failed
// assertion or an unexpected console/page/network error becomes a defect line in qa/findings/<area>.jsonl with a
// screenshot. Chromium instances are capped at 4 machine-wide via mkdir slot locks in /tmp/kora-qa-locks.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const QA_ROOT = path.resolve(HERE, "../.."); // <repo>/qa
// playwright-core is no longer a dependency of any workspace package (removed in the 2026-09-29 local-only cleanup), so fall back
// to the copy in the pnpm store.
function playwrightCorePaths() {
  const store = path.resolve(QA_ROOT, "../node_modules/.pnpm");
  const pnpm = fs.existsSync(store)
    ? fs
        .readdirSync(store)
        .filter((d) => d.startsWith("playwright-core@"))
        .map((d) => path.join(store, d, "node_modules"))
    : [];
  return [path.resolve(QA_ROOT, "../apps/desktop"), QA_ROOT, ...pnpm];
}
const { chromium } = require(require.resolve("playwright-core", { paths: playwrightCorePaths() }));
const { stack: stackEnv, privateDir } = require(path.join(QA_ROOT, "stacks/env.cjs"));

// Use the Chromium already cached in ~/Library/Caches/ms-playwright (never download). The newest headless shell wins.
function cachedChromium() {
  if (process.env.KORA_QA_CHROMIUM) return process.env.KORA_QA_CHROMIUM;
  const cache = path.join(process.env.HOME, "Library/Caches/ms-playwright");
  const dirs = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((d) => d.startsWith("chromium_headless_shell-"))
        .sort()
        .reverse()
    : [];
  for (const d of dirs) {
    const exe = path.join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
    if (fs.existsSync(exe)) return exe;
  }
  return undefined; // let playwright-core resolve its own
}

export const ROUND = process.env.KORA_QA_ROUND || "r1";
const LOCKS = process.env.KORA_QA_LOCKS || "/tmp/kora-qa-locks";
const MAX_BROWSERS = Number(process.env.KORA_QA_BROWSERS || 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// KORA_QA_STACK pins every spec in this process to one stack, so a tester that owns a single stack can run any area on
// it (seed that stack with the areas' namespaces: KORA_QA_SEED_AREAS, qa/stacks/seed.cjs).
const PINNED_STACK = process.env.KORA_QA_STACK ? Number(process.env.KORA_QA_STACK) : null;
const pinStack = (n) => PINNED_STACK ?? n;

export function stackOf(n) {
  return stackEnv(pinStack(n));
}
export function seedOf(n) {
  const s = stackEnv(pinStack(n));
  return JSON.parse(fs.readFileSync(path.join(s.base, "seed.json"), "utf8"));
}
// Seeded thread ids are random per seeding, so specs address fixtures by title, never by a pasted UUID.
export function threadIdByTitle(n, title) {
  const hit = seedOf(n).threads.find((t) => t.title === title);
  if (!hit) throw new Error(`stack${n} seed has no thread titled "${title}"`);
  return hit.id;
}

// ── Chromium slot lock ───────────────────────────────────────────────────────────
async function acquireBrowserSlot() {
  // Owned by this user and 0700, never a symlink: a pre-created shared /tmp dir must not steer the locks.
  privateDir(LOCKS);
  for (;;) {
    for (let i = 1; i <= MAX_BROWSERS; i++) {
      const d = path.join(LOCKS, `chromium-${i}`);
      try {
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, "pid"), String(process.pid));
        return d;
      } catch {
        /* taken */
      }
      try {
        const owner = Number(fs.readFileSync(path.join(d, "pid"), "utf8"));
        if (owner && owner !== process.pid) {
          try {
            process.kill(owner, 0);
          } catch {
            fs.rmSync(d, { recursive: true, force: true });
          }
        }
      } catch {
        /* racing writer */
      }
    }
    await sleep(1000);
  }
}

// ── Ink palette checker ───────────────────────────────────────────────────────
// Runs in the page: every visible element's computed colours are painted onto a 1×1 canvas (normalises rgb/oklch/
// color-mix/color()), converted to OKLCH, and flagged when they carry visible hue:
//   cold   — hue 180°–330° (cyan/blue/violet) with chroma > 0.03: never allowed in Ink
//   accent — any other hue with chroma > 0.08: allowed only for semantic status (error/warning/success/diff)
// `rasters: true` also reports raster marks drawn inside an SVG (<svg><image>): a full-colour logo
// bitmap slips past the colour-property scan (it was how orange/violet provider marks reached the sidebar).
// ── Right dock ───────────────────────────────────────────────────────────────────
// The side panel opens from one toggle at the top bar's right end ([data-dock-toggle]); its header
// switches groups ("workers" | "files" | "browser" | "terminal") with a segmented tab row
// ([data-dock-tabs]). This opens the panel if it is hidden, picks the group's tab if another group
// is showing, then waits for the header to report the group.
export async function openDockGroup(page, group, { timeout = 8000 } = {}) {
  const header = page.locator(`[data-dock-tabbar][data-dock-group="${group}"]`);
  if ((await header.count()) === 0 || !(await header.first().isVisible())) {
    const anyHeader = page.locator("[data-dock-tabbar]").filter({ visible: true });
    if ((await anyHeader.count()) === 0) {
      await page.locator("[data-dock-toggle]").first().click();
      await anyHeader.first().waitFor({ state: "visible", timeout });
    }
    if ((await header.count()) === 0 || !(await header.first().isVisible())) {
      await page.locator(`[data-dock-tabs] [data-dock-group="${group}"]`).first().click();
    }
  }
  await header.first().waitFor({ state: "visible", timeout });
  return header.first();
}

/** Opens the side panel (if hidden) so its group tabs can be inspected. */
export async function openDockPanel(page, { timeout = 8000 } = {}) {
  const anyHeader = page.locator("[data-dock-tabbar]").filter({ visible: true });
  if ((await anyHeader.count()) === 0) await page.locator("[data-dock-toggle]").first().click();
  await anyHeader.first().waitFor({ state: "visible", timeout });
  return page.locator("[data-dock-tabs]").first();
}

export async function inkCheck(page, { root = "body", max = 4000, rasters = false } = {}) {
  return page.evaluate(
    ({ root, max, rasters }) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      const cache = new Map();
      const toRgba = (c) => {
        if (cache.has(c)) return cache.get(c);
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = "#000";
        cx.fillStyle = c;
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        const v = [d[0], d[1], d[2], d[3] / 255];
        cache.set(c, v);
        return v;
      };
      const lin = (u) => {
        u /= 255;
        return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
      };
      const oklch = ([r, g, b]) => {
        const R = lin(r),
          G = lin(g),
          B = lin(b);
        const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
        const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
        const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
        const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
        const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
        const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
        const C = Math.hypot(A, Bb);
        let H = (Math.atan2(Bb, A) * 180) / Math.PI;
        if (H < 0) H += 360;
        return { L, C, H };
      };
      const describe = (el) => {
        const id = el.id ? `#${el.id}` : "";
        const cls =
          typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
            : "";
        const label = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 40);
        return `${el.tagName.toLowerCase()}${id}${cls === "." ? "" : cls} "${label}"`;
      };
      const out = [];
      const seen = new Set();
      const els = [...document.querySelectorAll(`${root}, ${root} *`)].slice(0, max);
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (rasters && el.tagName.toLowerCase() === "image" && el.closest("svg")) {
          out.push({
            kind: "raster",
            prop: "href",
            value: "raster",
            oklch: "",
            element: describe(el),
          });
          continue;
        }
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0)
          continue;
        // The one approved hue exception (docs/fleet/WORKER-BOXES.md): a worker box's 2px brand edge and its pixel
        // mark carry the agent's colour. Only those elements are tagged; everything around them is still checked.
        if (el.closest("[data-brand-hue]")) continue;
        // Syntax-highlight tokens (Shiki, pierre theme) are code colouring, not UI chrome: the transcript and the file
        // viewer both ship them, and their specs assert highlighting is present.
        if (el.closest(".shiki, .reply-md-shiki")) continue;
        const props = [
          "color",
          "background-color",
          "border-top-color",
          "outline-color",
          "fill",
          "stroke",
          "text-decoration-color",
        ];
        for (const p of props) {
          const v = cs.getPropertyValue(p);
          if (!v || v === "none" || v === "transparent" || v.startsWith("url(")) continue;
          if (p === "border-top-color" && parseFloat(cs.borderTopWidth) === 0) continue;
          if (
            p === "outline-color" &&
            (cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) === 0)
          )
            continue;
          if ((p === "fill" || p === "stroke") && !(el instanceof SVGElement)) continue;
          if (p === "text-decoration-color" && !cs.textDecorationLine.includes("underline"))
            continue;
          const rgba = toRgba(v);
          if (rgba[3] < 0.08) continue;
          const { L, C, H } = oklch(rgba);
          const cold = C > 0.03 && H >= 180 && H <= 330;
          const accent = !cold && C > 0.08;
          if (!cold && !accent) continue;
          const key = `${p}|${v}|${describe(el)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            kind: cold ? "cold" : "accent",
            prop: p,
            value: v,
            oklch: `L${L.toFixed(2)} C${C.toFixed(3)} H${H.toFixed(0)}`,
            element: describe(el),
          });
        }
      }
      return out;
    },
    { root, max, rasters },
  );
}

// WCAG contrast of two CSS colours (resolved in-page).
export async function contrast(page, fg, bg) {
  return page.evaluate(
    ({ fg, bg }) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const cx = cv.getContext("2d");
      const rgb = (c) => {
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = c;
        cx.fillRect(0, 0, 1, 1);
        return [...cx.getImageData(0, 0, 1, 1).data];
      };
      const lum = ([r, g, b]) => {
        const f = (u) => {
          u /= 255;
          return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const B = rgb(bg);
      const F0 = rgb(fg);
      const a = F0[3] / 255;
      const F = [0, 1, 2].map((i) => F0[i] * a + B[i] * (1 - a));
      const l1 = lum(F),
        l2 = lum(B);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    },
    { fg, bg },
  );
}

// ── findings ────────────────────────────────────────────────────────────────────
const SEVERITIES = ["crash", "broken", "wrong", "visual", "copy"];
function findingsFile(area) {
  return path.join(QA_ROOT, "findings", `${area}.jsonl`);
}
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

// Console noise that is not a product defect (dev-server chatter). Keep this list short and specific.
// A 404 from GET /api/chat/threads/:id is the contract for "not on the daemon yet" (a fresh draft): the client defers to
// the socket (kora-chat.ts getThreadDetail). Chrome logs it as a generic "Failed to load resource" line with no URL,
// so that line is ignored here and the URL-specific filter below covers the network evidence.
const IGNORED_CONSOLE = [
  /\[vite\]/i,
  /Download the React DevTools/i,
  /Failed to load resource: the server responded with a status of 404/,
];
const IGNORED_NETWORK = [/\/api\/chat\/threads\/[^/?]+$/];

export function spec(
  area,
  { stack = 1, url = null, viewport = { width: 1440, height: 900 } } = {},
  body,
) {
  // `url` points a spec at a non-stack UI (the model tests use the credentialed swarm-e2e daemon's web server).
  stack = pinStack(stack);
  const s = url ? { ...stackEnv(1), n: "custom", url } : stackEnv(stack);
  const runDir = path.join(QA_ROOT, "runs", ROUND, area);
  fs.mkdirSync(runDir, { recursive: true });
  const results = [];
  const tests = [];
  const t = { test: (name, fn, opts = {}) => tests.push({ name, fn, opts }) };

  const main = async () => {
    await body(t);
    const only = process.env.KORA_QA_GREP ? new RegExp(process.env.KORA_QA_GREP, "i") : null;
    const slot = await acquireBrowserSlot();
    let browser;
    try {
      browser = await chromium.launch({ headless: true, executablePath: cachedChromium() });
      for (const tc of tests) {
        if (only && !only.test(tc.name)) continue;
        results.push(await runOne(browser, tc));
      }
    } finally {
      await browser?.close().catch(() => {});
      fs.rmSync(slot, { recursive: true, force: true });
    }
    fs.writeFileSync(
      path.join(runDir, "results.json"),
      JSON.stringify({ area, round: ROUND, stack, at: new Date().toISOString(), results }, null, 2),
    );
    const failed = results.filter((r) => r.status !== "pass");
    console.log(
      `${area} [${ROUND}] ${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map((f) => f.name).join("; ") : ""}`,
    );
    process.exitCode = failed.length ? 1 : 0;
  };

  async function runOne(browser, tc) {
    const vp = tc.opts.viewport || viewport;
    const context = await browser.newContext({
      viewport: vp,
      colorScheme: "dark",
      deviceScaleFactor: 1,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    // The app's real first-run surface is Blobs; the other areas' specs were written against Code, so they start there
    // (as a user who last used Code) unless a spec asks for the true first run with `{ firstRun: true }`.
    if (!tc.opts.firstRun) {
      await context.addInitScript(() => {
        try {
          if (window.localStorage.getItem("kora.surface.v1") === null)
            window.localStorage.setItem("kora.surface.v1", '"code"');
        } catch {
          /* storage blocked */
        }
      });
    }
    const page = await context.newPage();
    const evidence = { console: [], pageErrors: [], network: [], ws: [] };
    const allowed = { console: tc.opts.allowConsole || [], network: tc.opts.allowNetwork || [] };
    page.on("console", (m) => {
      if (m.type() !== "error" && m.type() !== "warning") return;
      const text = m.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      evidence.console.push({ type: m.type(), text: text.slice(0, 600) });
    });
    page.on("pageerror", (e) => evidence.pageErrors.push(String(e?.stack || e).slice(0, 800)));
    page.on("requestfailed", (r) => {
      const f = r.failure()?.errorText || "";
      if (/ERR_ABORTED/.test(f)) return; // navigations/cancelled fetches
      evidence.network.push({ url: r.url(), failure: f });
    });
    page.on("response", (r) => {
      if (r.status() === 404 && IGNORED_NETWORK.some((re) => re.test(r.url()))) return;
      if (r.status() >= 400) evidence.network.push({ url: r.url(), status: r.status() });
    });
    page.on("websocket", (ws) => {
      if (!/\/ws/.test(ws.url())) return;
      ws.on("close", () => evidence.ws.push({ url: ws.url(), closedAt: Date.now() }));
      ws.on("socketerror", (e) => evidence.ws.push({ url: ws.url(), error: String(e) }));
    });
    const steps = [];
    const defects = [];
    const coveredControls = [];
    const ctx = {
      page,
      context,
      stack: s,
      seed: () => seedOf(stack),
      expect: assert,
      sleep,
      step: (text) => steps.push(text),
      open: async (route = "/", opts = {}) => {
        steps.push(`open ${route}`);
        await page.goto(s.url + route, { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (opts.wait !== false) await ctx.ready();
        // `/` only mounts the sidebar, then drops into a draft for the active surface's project once the shells
        // bootstrap (or shows the open-a-project hero). A spec that acts before that redirect races it.
        if (route === "/" && opts.wait !== false) {
          await page
            .waitForFunction(
              () => location.pathname !== "/" || !!document.querySelector("main h1"),
              null,
              { timeout: 20_000 },
            )
            .catch(() => {});
          await ctx.ready();
        }
      },
      // Ready = the app has mounted (sidebar filter, composer or a settings page) and the DOM has stopped growing.
      ready: async (timeout = 45_000) => {
        await page.waitForFunction(
          () =>
            !!document.querySelector(
              'input[aria-label="Search chats"], [contenteditable="true"], [data-settings-page], main h1, [role="alert"]',
            ),
          null,
          { timeout },
        );
        let last = -1;
        for (let i = 0; i < 40; i++) {
          const n = await page.evaluate(() => document.getElementsByTagName("*").length);
          if (n === last) break;
          last = n;
          await sleep(250);
        }
      },
      covered: (control, note) => coveredControls.push({ control, note: note ?? null }),
      defect: async (d) => {
        const shot = path.join(runDir, `${slug(tc.name)}-${defects.length + 1}.png`);
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        const rec = normalizeDefect(
          area,
          tc.name,
          {
            ...d,
            steps: d.steps ?? [...steps],
            screenshot: path.relative(path.resolve(QA_ROOT, ".."), shot),
          },
          evidence,
        );
        defects.push(rec);
        appendJsonl(findingsFile(area), rec);
      },
      inkCheck: (opts) => inkCheck(page, opts),
      contrast: (fg, bg) => contrast(page, fg, bg),
      // Evidence collected so far (for tests that assert "no errors" themselves).
      evidence,
      clearEvidence: () => {
        evidence.console.length = 0;
        evidence.pageErrors.length = 0;
        evidence.network.length = 0;
        evidence.ws.length = 0;
      },
    };
    const t0 = Date.now();
    let status = "pass";
    let error = null;
    try {
      await tc.fn(ctx);
    } catch (e) {
      status = "fail";
      error = String(e?.message || e).slice(0, 1500);
      await ctx.defect({
        control: tc.opts.control || tc.name,
        expected: tc.opts.expected || "the assertion holds",
        actual: error,
        severity: tc.opts.severity || "wrong",
      });
    }
    // Unexpected console/page/network errors are defects of their own, even when the assertions passed.
    const unexpected = {
      console: evidence.console.filter(
        (c) => c.type === "error" && !allowed.console.some((re) => re.test(c.text)),
      ),
      pageErrors: evidence.pageErrors,
      network: evidence.network.filter(
        (n) => !allowed.network.some((re) => re.test(n.url + " " + (n.status ?? n.failure))),
      ),
    };
    // A test that recorded a defect has failed, even when its assertions passed: the suite must not read green
    // while it is logging defects.
    if (status === "pass" && defects.length > 0) status = "fail";
    if (
      !tc.opts.ignoreErrors &&
      (unexpected.console.length || unexpected.pageErrors.length || unexpected.network.length)
    ) {
      if (status === "pass") status = "fail";
      await ctx.defect({
        control: tc.opts.control || tc.name,
        expected: "no console errors, page errors or failed requests",
        actual: [
          unexpected.pageErrors[0] && `pageerror: ${unexpected.pageErrors[0].split("\n")[0]}`,
          unexpected.console[0] && `console: ${unexpected.console[0].text.split("\n")[0]}`,
          unexpected.network[0] &&
            `network: ${unexpected.network[0].url} ${unexpected.network[0].status ?? unexpected.network[0].failure}`,
        ]
          .filter(Boolean)
          .join(" | "),
        severity: unexpected.pageErrors.length ? "crash" : "wrong",
      });
    }
    await context.close().catch(() => {});
    for (const c of coveredControls)
      appendJsonl(path.join(QA_ROOT, "findings", `${area}.coverage.jsonl`), {
        area,
        round: ROUND,
        test: tc.name,
        ...c,
        status,
      });
    return {
      name: tc.name,
      status,
      ms: Date.now() - t0,
      error,
      defects: defects.length,
      covered: coveredControls.map((c) => c.control),
    };
  }

  main().catch((e) => {
    console.error(`${area}: harness error`, e);
    process.exitCode = 2;
  });
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function normalizeDefect(area, test, d, evidence) {
  const severity = SEVERITIES.includes(d.severity) ? d.severity : "wrong";
  return {
    area,
    round: ROUND,
    test,
    page: d.page ?? null,
    control: d.control ?? test,
    steps: d.steps ?? [],
    expected: d.expected ?? "",
    actual: d.actual ?? "",
    evidence: d.evidence ?? {
      console: evidence.console.slice(0, 5),
      pageErrors: evidence.pageErrors.slice(0, 3),
      network: evidence.network.slice(0, 5),
      ws: evidence.ws.slice(0, 5),
    },
    screenshot: d.screenshot ?? null,
    severity,
    at: new Date().toISOString(),
  };
}
