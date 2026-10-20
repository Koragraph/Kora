// Shared helpers for the Phase 4 / 5 specs: make a blob through the editor (pinned model: the isolated stack has no signed-in
// engine), open its side panel on a tab, and read what the daemon wrote to the stack's home.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { loadBlob } from "./blobSeed.mjs";

const { stack: stackEnv, childEnv } = createRequire(import.meta.url)("../../stacks/env.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);
export const home = () => stackEnv(STACK).home;
export const uiPort = () => stackEnv(STACK).uiPort;
/** The webhook receiver: the UI port + 3 (the daemon's default). */
export const webhookBase = () => `http://127.0.0.1:${uiPort() + 3}`;
export const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(home(), ...p), "utf8"));
export const blobHomeFile = (blobId, file) => path.join(home(), "blobs", blobId, file);

/** Create a blob through the editor and return its profile (found on disk by name). */
export async function createBlob(page, open, name) {
  await open("/blobs", { wait: false });
  await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
  await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
  await page.locator("[data-blob-editor]").waitFor();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.locator('[data-editor-section="model"]').click();
  await page.locator('[data-model-mode="pick"]').click();
  await page.locator("[data-editor-save]").click();
  await page.locator(`[data-blob-id] [data-blob-row][aria-label^="${name}"]`).first().waitFor({ timeout: 20_000 });
  // The /blobs landing is still forwarding to a thread; a click on the new blob's row while it does can leave the second landing on
  // its spinner (two navigations racing, see BlobLanding). Let the first one finish.
  await page.waitForFunction(() => /^\/(draft|kora-local)\//.test(location.pathname), null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
  return loadBlob(STACK, name);
}

/** Open a blob and its side panel on `tab`. The panel state is a localStorage convenience, set before the page loads. */
export async function openPanel(page, open, blobId, tab) {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("kora.blobs.panel.v1", JSON.stringify({ open: true, tab: t }));
    } catch {
      /* private mode */
    }
  }, tab);
  await open(`/blobs/${blobId}`, { wait: false });
  await page.locator("[data-blob-panel-tabbar]").waitFor({ timeout: 60_000 });
  await page.locator(`[data-blob-panel-tab="${tab}"]`).click();
}

/**
 * Hire a starter exactly as the daemon's gallery Hire does (the runtime's own `hireTemplate`, which writes the suggested routines
 * paused), straight into the stack's home while its daemon is stopped, then bring the daemon back. For specs that need a
 * starter but are not about the gallery (that is gallery.spec.mjs).
 */
export function hireStarterOnDisk(templateId, name) {
  try {
    return loadBlob(STACK, name);
  } catch {
    /* not hired yet */
  }
  const ctl = (cmd) => execFileSync(process.execPath, [path.join(ROOT, "qa/stacks/stack.cjs"), cmd, String(STACK)], { stdio: "ignore", timeout: 90_000 });
  ctl("stop");
  const code = `
    const { BlobStore } = require(${JSON.stringify(path.join(ROOT, "packages/runtime/dist/blobs/store"))});
    const { hireTemplate } = require(${JSON.stringify(path.join(ROOT, "packages/runtime/dist/blobs/templates"))});
    const r = hireTemplate(new BlobStore(), ${JSON.stringify(templateId)}, { defaultEngine: { instanceId: "claude", model: "sonnet", effort: null } });
    if (!r.profile) { console.error(JSON.stringify(r)); process.exit(1); }`;
  execFileSync(process.execPath, ["-e", code], { env: childEnv(stackEnv(STACK)), stdio: "inherit", timeout: 60_000 });
  ctl("start");
  return loadBlob(STACK, name);
}
