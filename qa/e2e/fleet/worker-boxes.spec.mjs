// Worker panes (docs/fleet/WORKER-BOXES.md, approved mock docs/fleet/worker-panes-v2-mock.html "A · Grid of windows"):
// the grid beside an orchestrator lead and the window a sprite opens, driven by a FAKE fleet.
//
// No model spend and no real workers: the page's RPC websocket is routed through Playwright. Every `fleet.*` request is
// answered here (a roster snapshot, per-worker feeds, steer / respondApproval acks) and everything else passes through
// to the stack's daemon untouched. Wire format = Effect RPC JSON (`Request` → `Chunk` / `Exit`), one message per frame.
//
//   KORA_QA_DIR=<scratch> KORA_QA_SEED_OFFLINE=1 node qa/stacks/stack.cjs seed 1   # OFFLINE: inside an agent session
//   KORA_QA_DIR=<scratch> node qa/stacks/stack.cjs up 1
//   KORA_QA_DIR=<scratch> node qa/e2e/fleet/worker-boxes.spec.mjs
//   node qa/stacks/stack.cjs down 1
import fs from "node:fs";
import { spec, threadIdByTitle, openDockGroup } from "../lib/harness.mjs";

// The canonical swarm worker (decoded strictly by contracts/src/swarm.test.ts): OpenCode in a PTY, with a report.
const SWARM_SAMPLE = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../packages/contracts/src/fixtures/fleet-worker-swarm.sample.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const HOST = "kora-local";
const STACK = 1;
const THREAD = threadIdByTitle(STACK, "Fixture: orchestrator thread");

// ── the fake fleet ──────────────────────────────────────────────────────────────────────────────────────────────────
function worker(paneId, agent, title, extra = {}) {
  const now = Date.now();
  return {
    paneId,
    terminalId: `worker:${paneId}`,
    agent,
    account: null,
    title,
    state: "working",
    blocker: null,
    steered: false,
    steeredAt: null,
    cwd: "/tmp/qa-fleet",
    worktree: {
      path: `/tmp/qa-fleet/${paneId}`,
      branch: `kora/${paneId}`,
      mainRoot: "/tmp/qa-fleet",
      ahead: 1,
      dirty: 0,
    },
    costUsd: 0.04,
    contextPct: 12,
    exitCode: null,
    createdAt: now - 90_000,
    lastOutputAt: now - 2_000,
    model: null,
    surface: "gui",
    pendingApproval: null,
    retrying: null,
    ...extra,
  };
}

/** One fake fleet per test: roster + feeds + the fleet.* calls the page made. */
function fakeFleet() {
  const t0 = Date.now() - 60_000;
  const workers = [
    worker("w-claude", "claude", "Add a mean test", {
      state: "blocked",
      model: "claude-sonnet-5",
      pendingApproval: { requestId: "req-1", title: "Run npm test" },
    }),
    worker("w-codex", "codex", "Refactor clamp", { model: "gpt-5.5-codex" }),
    worker("w-agy", "antigravity", "Write docs", { state: "idle" }),
  ];
  const feeds = {
    "w-claude": [
      { id: "c1", at: t0, kind: "user", text: "Add a unit test for `mean`.", source: "leader" },
      {
        id: "c2",
        at: t0 + 1000,
        kind: "tool",
        tool: "Read",
        title: "Read src/math.js",
        detail: null,
        status: "done",
        added: null,
        removed: null,
      },
      {
        id: "c3",
        at: t0 + 2000,
        kind: "assistant",
        text: "Test written in **test/mean.test.js**. Running it next.",
        streaming: false,
      },
      {
        id: "c4",
        at: t0 + 3000,
        kind: "approval",
        requestId: "req-1",
        title: "Run npm test",
        detail: "npm test -- mean",
        status: "open",
      },
    ],
    "w-codex": [
      { id: "x1", at: t0, kind: "user", text: "Refactor `clamp`.", source: "leader" },
      {
        id: "x2",
        at: t0 + 1000,
        kind: "tool",
        tool: "Bash",
        title: "rg clamp",
        detail: null,
        status: "running",
        added: null,
        removed: null,
      },
    ],
    "w-agy": [
      { id: "a1", at: t0, kind: "user", text: "Document the helpers.", source: "leader" },
      { id: "a2", at: t0 + 1000, kind: "notice", text: "Waiting for the lead." },
    ],
  };
  return { workers, feeds, calls: [], snapshotSubs: new Set(), feedSubs: new Map() };
}

function snapshotEvent(fleet) {
  return {
    type: "snapshot",
    snapshot: {
      threadId: THREAD,
      orchestratorId: "qa-orchestrator",
      workers: fleet.workers,
      plan: "",
      events: [],
      lastVerdict: null,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Routes the page's RPC socket: fleet.* answered from `fleet`, the rest forwarded to the daemon. */
async function routeFleet(page, fleet) {
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    const mine = new Set(); // request ids answered here (their Ack / Interrupt never reach the daemon)
    const send = (msg) => ws.send(JSON.stringify(msg));
    const chunk = (requestId, value) => send({ _tag: "Chunk", requestId, values: [value] });
    const ok = (requestId) =>
      send({ _tag: "Exit", requestId, exit: { _tag: "Success", value: null } });
    const pushSnapshot = () => {
      for (const id of fleet.snapshotSubs) chunk(id, snapshotEvent(fleet));
    };
    const pushItem = (paneId, item) => {
      fleet.feeds[paneId].push(item);
      for (const [id, p] of fleet.feedSubs)
        if (p === paneId) chunk(id, { type: "upsert", paneId, item });
    };
    fleet.pushSnapshot = pushSnapshot;
    ws.onMessage((raw) => {
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        server.send(raw);
        return;
      }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      const pass = [];
      for (const m of msgs) {
        if ((m._tag === "Ack" || m._tag === "Interrupt") && mine.has(m.requestId)) {
          if (m._tag === "Interrupt") {
            fleet.snapshotSubs.delete(m.requestId);
            fleet.feedSubs.delete(m.requestId);
          }
          continue;
        }
        if (m._tag !== "Request" || !String(m.tag).startsWith("fleet.")) {
          pass.push(m);
          continue;
        }
        mine.add(m.id);
        fleet.calls.push({ tag: m.tag, payload: m.payload });
        switch (m.tag) {
          case "fleet.subscribe":
            fleet.snapshotSubs.add(m.id);
            chunk(m.id, snapshotEvent(fleet));
            break;
          case "fleet.subscribeWorker": {
            const paneId = m.payload.paneId;
            fleet.feedSubs.set(m.id, paneId);
            chunk(m.id, { type: "snapshot", paneId, items: fleet.feeds[paneId] ?? [] });
            break;
          }
          case "fleet.respondApproval": {
            ok(m.id);
            const { paneId, requestId, decision } = m.payload;
            const card = fleet.feeds[paneId].find(
              (i) => i.kind === "approval" && i.requestId === requestId,
            );
            if (card)
              pushItem(paneId, {
                ...card,
                status: decision === "decline" ? "declined" : "accepted",
              });
            const w = fleet.workers.find((x) => x.paneId === paneId);
            if (w) Object.assign(w, { state: "working", pendingApproval: null });
            pushSnapshot();
            break;
          }
          case "fleet.steer": {
            ok(m.id);
            const { paneId, text } = m.payload;
            pushItem(paneId, {
              id: `steer-${fleet.calls.length}`,
              at: Date.now(),
              kind: "user",
              text,
              source: "human",
            });
            break;
          }
          case "fleet.kill": {
            ok(m.id);
            const w = fleet.workers.find((x) => x.paneId === m.payload.paneId);
            if (w) Object.assign(w, { state: "exited", stoppedByUser: true, exitCode: 0 });
            pushSnapshot();
            break;
          }
          default:
            ok(m.id); // merge / verify are not exercised here
        }
      }
      if (pass.length) server.send(JSON.stringify(Array.isArray(parsed) ? pass : pass[0]));
    });
    server.onMessage((m) => ws.send(m));
  });
}

async function openFleet(ctx, fleet) {
  await routeFleet(ctx.page, fleet);
  await ctx.open(`/${HOST}/${THREAD}`);
  await openDockGroup(ctx.page, "workers");
  await ctx.page.locator("[data-worker-boxes]").waitFor({ state: "visible", timeout: 15_000 });
}

const box = (page, paneId) => page.locator(`[data-worker-pane="${paneId}"]`);

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────────
spec("fleet", { stack: STACK }, async (t) => {
  t.test(
    "worker boxes render in the dock with per-agent identity",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      await openFleet(ctx, fleet);
      ctx.step("three GUI boxes: claude / codex / antigravity");
      await page.locator("[data-worker-pane]").nth(2).waitFor({ state: "visible" });
      expect.equal(
        await page.locator("[data-worker-boxes]").getAttribute("data-worker-boxes"),
        "3",
      );
      const identity = await page.$$eval("[data-worker-pane]", (els) =>
        els.map((el) => ({
          pane: el.getAttribute("data-worker-pane"),
          agent: el.getAttribute("data-agent"),
          surface: el.getAttribute("data-worker-surface"),
          radius: getComputedStyle(el).borderTopLeftRadius,
          family: [...el.classList].find((c) => c.startsWith("f-")),
        })),
      );
      expect.deepEqual(identity, [
        { pane: "w-claude", agent: "claude", surface: "gui", radius: "18px", family: "f-claude" },
        { pane: "w-codex", agent: "codex", surface: "gui", radius: "6px", family: "f-codex" },
        { pane: "w-agy", agent: "antigravity", surface: "gui", radius: "12px", family: "f-agy" },
      ]);
      ctx.step("state pills follow the roster");
      expect.equal(
        await box(page, "w-claude")
          .locator("[data-worker-state]")
          .first()
          .getAttribute("data-worker-state"),
        "needs",
      );
      expect.equal(
        await box(page, "w-codex")
          .locator("[data-worker-state]")
          .first()
          .getAttribute("data-worker-state"),
        "working",
      );
      ctx.covered("worker box identity", "data-agent, f-<family>, --wb-radius");
    },
    { control: "Worker boxes — Side grid + identity", severity: "broken" },
  );

  t.test(
    "minimize collapses a box to a strip and the strip expands it back",
    async (ctx) => {
      const { page, expect } = ctx;
      await openFleet(ctx, fakeFleet());
      await box(page, "w-codex").waitFor({ state: "visible" });
      ctx.step("minimize the codex box");
      await box(page, "w-codex").getByRole("button", { name: "Minimize" }).click();
      const strip = page.locator('[data-worker-strip="w-codex"]');
      await strip.waitFor({ state: "visible", timeout: 5000 });
      expect.equal(await box(page, "w-codex").count(), 0, "the box leaves the grid");
      expect.match((await strip.textContent()) ?? "", /Refactor clamp/);
      ctx.step("click the strip to restore it");
      await strip.click();
      await box(page, "w-codex").waitFor({ state: "visible", timeout: 5000 });
      expect.equal(await strip.count(), 0, "the strip is gone once restored");
      ctx.covered("worker box minimize / restore");
    },
    { control: "Worker boxes — minimize to strip", severity: "broken" },
  );

  t.test(
    "a GUI box shows its feed and the approval card answers through fleet.respondApproval",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      await openFleet(ctx, fleet);
      const claude = box(page, "w-claude");
      ctx.step("feed items from fleet.subscribeWorker");
      for (const id of ["c1", "c2", "c3"])
        await claude
          .locator(`[data-feed-item="${id}"]`)
          .waitFor({ state: "visible", timeout: 10_000 });
      expect.match(
        (await claude.locator('[data-feed-item="c3"]').textContent()) ?? "",
        /test\/mean\.test\.js/,
      );
      const card = claude.locator('[data-approval="req-1"]');
      await card.waitFor({ state: "visible" });
      expect.match((await card.textContent()) ?? "", /Run npm test/);
      ctx.step("an open approval is pinned above the steer box, not in the scrolling feed");
      expect.equal(await claude.locator('.wb-pinned [data-approval="req-1"]').count(), 1);
      expect.equal(await claude.locator('[data-worker-feed] [data-approval="req-1"]').count(), 0);
      // Regression: the box is short here (3 stacked boxes), so the card sits near the feed's bottom; the mousedown
      // re-render once re-stuck the feed and the click landed beside the button (no respondApproval sent).
      ctx.step("scroll the card into view and Allow");
      const allow = card.getByRole("button", { name: "Allow", exact: true });
      await allow.scrollIntoViewIfNeeded();
      await ctx.sleep(300); // let the scroll event land (the feed's stick-to-bottom reads it)
      const hit = await allow.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
      });
      expect.ok(hit, "the Allow button is not covered once scrolled into view");
      await allow.click();
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-worker-pane="w-claude"] [data-approval="req-1"] .wb-btns'),
        null,
        { timeout: 5000 },
      );
      const calls = fleet.calls.filter((c) => c.tag === "fleet.respondApproval");
      expect.deepEqual(
        calls.map((c) => c.payload),
        [{ threadId: THREAD, paneId: "w-claude", requestId: "req-1", decision: "accept" }],
      );
      ctx.step("the box leaves Needs you once answered; the answered card moves into the feed");
      await claude.locator('[data-worker-state="working"]').first().waitFor({ timeout: 5000 });
      await claude.locator('[data-worker-feed] [data-approval="req-1"]').waitFor({ timeout: 5000 });
      expect.equal(await claude.locator(".wb-pinned").count(), 0, "nothing left pinned");
      ctx.covered("worker box approval card", "Allow → fleet.respondApproval accept");
    },
    { control: "Worker boxes — feed + approval card", severity: "broken" },
  );

  t.test(
    "the steer input submits to fleet.steer and the steer shows in the feed",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      await openFleet(ctx, fleet);
      const input = page.getByRole("textbox", { name: "Steer worker w-codex" });
      await input.waitFor({ state: "visible" });
      ctx.step("type a steer and press Enter");
      await input.fill("Keep the old signature.");
      await input.press("Enter");
      for (let i = 0; i < 40 && !fleet.calls.some((c) => c.tag === "fleet.steer"); i++)
        await ctx.sleep(100);
      const steer = fleet.calls.find((c) => c.tag === "fleet.steer");
      expect.ok(steer, "fleet.steer was called");
      expect.equal(steer.payload.paneId, "w-codex");
      expect.equal(steer.payload.text, "Keep the old signature.");
      await box(page, "w-codex").getByText("Keep the old signature.").waitFor({ timeout: 5000 });
      expect.equal(await input.inputValue(), "", "the input clears after a successful steer");
      ctx.covered("worker box steer input");
    },
    { control: "Worker boxes — steer", severity: "broken" },
  );

  t.test(
    "the worker dock passes inkCheck; only the brand edge + mark carry hue",
    async (ctx) => {
      const { page, expect } = ctx;
      await openFleet(ctx, fakeFleet());
      await box(page, "w-agy")
        .locator('[data-feed-item="a2"]')
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.mouse.move(2, 2); // no pane hovered: the traffic lights rest grey
      await ctx.sleep(400); // let pill animations / fonts settle
      const hits = await ctx.inkCheck({ root: "[data-worker-boxes]" });
      const cold = hits.filter((h) => h.kind === "cold");
      expect.deepEqual(cold, [], `cold hues outside the brand exception: ${JSON.stringify(cold)}`);
      // Warm hues only where they mean something: Needs you (amber), done/failed/diffs (green/red), the macOS lights.
      const SEMANTIC =
        /wb-state|is-ask|is-attn|wbox|wb-add|wb-del|wb-light|wb-stopconfirm|is-error|t-ok|t-bad/;
      // SVG icons have no string className for inkCheck to name: match them by the semantic colour itself.
      const SEMANTIC_RGB = new Set([
        "rgb(227, 163, 59)", // amber: needs you / ask
        "rgb(255, 139, 139)", // red: failed / stop
        "rgb(126, 226, 168)", // green: done / added
      ]);
      const stray = hits.filter(
        (h) => h.kind === "accent" && !SEMANTIC.test(h.element) && !SEMANTIC_RGB.has(h.value),
      );
      expect.deepEqual(stray, [], `accent hues off the semantic list: ${JSON.stringify(stray)}`);
      ctx.step("the exception is real: each box's edge carries its agent's brand colour");
      const edges = await page.$$eval("[data-worker-pane] > .wb-edge[data-brand-hue]", (els) =>
        els.map((el) => getComputedStyle(el).backgroundColor),
      );
      expect.deepEqual(edges, ["rgb(217, 119, 87)", "rgb(242, 242, 244)", "rgb(110, 160, 255)"]);
      ctx.step("hovering a pane lights its traffic lights in the macOS colours");
      await box(page, "w-codex").hover();
      await ctx.sleep(250);
      const lit = await box(page, "w-codex")
        .locator(".wb-light")
        .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
      expect.deepEqual(lit, ["rgb(255, 95, 87)", "rgb(254, 188, 46)", "rgb(40, 200, 64)"]);
      ctx.covered("worker dock ink palette", "data-brand-hue exception + semantic list");
    },
    { control: "Worker boxes — Ink palette", severity: "visual" },
  );

  t.test(
    "each pane is a window: lights, task title, Name · model, logo, meta row",
    async (ctx) => {
      const { page, expect } = ctx;
      await openFleet(ctx, fakeFleet());
      const claude = box(page, "w-claude");
      await claude.waitFor({ state: "visible" });
      ctx.step("three lights in order, labelled, in the title bar");
      expect.deepEqual(
        await claude
          .locator(".whead .wb-light")
          .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))),
        ["Stop worker", "Minimize", "Expand"],
      );
      ctx.step("title = the task; second line = Name · model");
      expect.equal(
        (await claude.locator(".whead .who b").textContent())?.trim(),
        "Add a mean test",
      );
      expect.equal(
        (await claude.locator(".whead .who small").textContent())?.trim(),
        "Claude · claude-sonnet-5",
      );
      expect.equal(
        (await box(page, "w-codex").locator(".whead .who small").textContent())?.trim(),
        "codex · gpt-5.5-codex",
      );
      ctx.step("the real agent logos (AgentIcon), never the old pixel marks");
      for (const id of ["w-claude", "w-codex", "w-agy"]) {
        expect.equal(
          await box(page, id).locator(".whead .wb-mk img, .whead .wb-mk svg").count(),
          1,
        );
      }
      ctx.step("the meta row sits under the body: branch, ctx, cost, elapsed");
      const meta = (await claude.locator(".wsub").textContent()) ?? "";
      expect.match(meta, /w-claude ↑1/);
      expect.match(meta, /ctx 12%/);
      expect.match(meta, /\$0\.04/);
      expect.match(meta, /\dm \d\ds|\d+s/);
      const order = await claude.evaluate((el) =>
        [...el.children].map((c) => c.className.split(" ")[0]),
      );
      const at = (c) => order.indexOf(c);
      expect.ok(
        at("whead") < at("wb-bodywrap") &&
          at("wb-bodywrap") < at("wb-pinned") &&
          at("wb-pinned") < at("wsub") &&
          at("wsub") < at("wsteer"),
        `pane order: ${order.join(" > ")}`,
      );
      ctx.covered("worker pane chrome", "lights + title + subline + meta order");
    },
    { control: "Worker panes — window chrome", severity: "broken" },
  );

  t.test(
    "yellow tucks a pane into the shelf as a chip; green fills the dock and Esc returns",
    async (ctx) => {
      const { page, expect } = ctx;
      await openFleet(ctx, fakeFleet());
      const codex = box(page, "w-codex");
      await codex.waitFor({ state: "visible" });
      ctx.step("yellow → shelf chip with task + last action + state");
      await codex.hover();
      await codex.locator('[data-light="minimize"]').click();
      const chip = page.locator('[data-worker-strip="w-codex"]');
      await chip.waitFor({ state: "visible", timeout: 5000 });
      expect.equal(await codex.count(), 0);
      const chipText = (await chip.textContent()) ?? "";
      expect.match(chipText, /Refactor clamp/);
      expect.match(chipText, /rg clamp/, "the chip shows the last action");
      expect.equal(
        await chip.locator("[data-worker-state]").getAttribute("data-worker-state"),
        "working",
      );
      ctx.step("the two left share the grid; restore puts codex back");
      expect.equal(await page.locator("[data-worker-pane]").count(), 2);
      await chip.click();
      await codex.waitFor({ state: "visible", timeout: 5000 });
      ctx.step("green fills the dock with one pane, the others become chips");
      await box(page, "w-agy").hover();
      await box(page, "w-agy").locator('[data-light="zoom"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-worker-pane]").length === 1,
      );
      expect.equal(
        await box(page, "w-agy").locator('[data-light="zoom"]').getAttribute("aria-label"),
        "Back to the grid",
      );
      ctx.step("Esc goes back to the grid");
      await box(page, "w-agy").locator(".whead .who b").click();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.querySelectorAll("[data-worker-pane]").length === 3,
      );
      ctx.step("green twice also goes back");
      await box(page, "w-agy").locator('[data-light="zoom"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-worker-pane]").length === 1,
      );
      await box(page, "w-agy").locator('[data-light="zoom"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-worker-pane]").length === 3,
      );
      ctx.covered("worker pane yellow/green lights", "shelf chip, zoom, Esc");
    },
    { control: "Worker panes — minimize + zoom lights", severity: "broken" },
  );

  t.test(
    "red stops a worker only after a confirm, through fleet.kill",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      await openFleet(ctx, fleet);
      const codex = box(page, "w-codex");
      await codex.hover();
      ctx.step("first red click arms; nothing is sent");
      await codex.locator('[data-light="stop"]').click();
      const confirm = codex.getByRole("button", { name: "Confirm stop" });
      await confirm.waitFor({ state: "visible", timeout: 3000 });
      await ctx.sleep(300);
      expect.equal(fleet.calls.filter((c) => c.tag === "fleet.kill").length, 0);
      ctx.step("the arm times out on its own");
      await ctx.sleep(4300);
      expect.equal(await confirm.count(), 0, "Stop? goes away after 4 s");
      ctx.step("arm again, confirm with the Stop? pill");
      await codex.hover();
      await codex.locator('[data-light="stop"]').click();
      await codex.getByRole("button", { name: "Confirm stop" }).click();
      for (let i = 0; i < 30 && !fleet.calls.some((c) => c.tag === "fleet.kill"); i++)
        await ctx.sleep(100);
      expect.deepEqual(
        fleet.calls.filter((c) => c.tag === "fleet.kill").map((c) => c.payload),
        [{ threadId: THREAD, paneId: "w-codex" }],
      );
      ctx.step("a stopped worker's red light is dead");
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-worker-pane="w-codex"] [data-light="stop"]');
        return !el || el.disabled;
      });
      ctx.covered("worker pane red light", "two-click stop → fleet.kill");
    },
    { control: "Worker panes — stop light", severity: "broken" },
  );

  t.test(
    "Codex runs show as $ command blocks; Claude keeps tool rows",
    async (ctx) => {
      const { page, expect } = ctx;
      await openFleet(ctx, fakeFleet());
      const exec = box(page, "w-codex").locator('.wb-exec[data-feed-item="x2"]');
      await exec.waitFor({ state: "visible", timeout: 10_000 });
      expect.match((await exec.textContent()) ?? "", /\$\s*rg clamp/);
      expect.equal(
        await exec.locator('[aria-label="running"]').count(),
        1,
        "a running command shows dots",
      );
      const read = box(page, "w-claude").locator('[data-feed-item="c2"]');
      await read.waitFor({ state: "visible" });
      expect.equal(await read.evaluate((el) => el.classList.contains("toolrow")), true);
      ctx.covered("worker pane codex exec blocks");
    },
    { control: "Worker panes — per-agent feed", severity: "visual" },
  );

  t.test(
    "the sprite dock: still sprites in their agent's accessory, working on top, finished ones in a pile",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      fleet.workers.push(
        worker("w-done", "claude", "Ship the changelog", { state: "exited", exitCode: 0 }),
      );
      await routeFleet(page, fleet);
      await ctx.open(`/${HOST}/${THREAD}`);
      const sprites = page.locator(".swarm-blob");
      await sprites.first().waitFor({ state: "visible", timeout: 15_000 });
      ctx.step("working first, then needs you, then idle; the finished worker is not standing");
      expect.deepEqual(await sprites.evaluateAll((els) => els.map((el) => el.dataset.paneId)), [
        "w-codex",
        "w-claude",
        "w-agy",
      ]);
      ctx.step("each wears its agent's accessory; nothing moves");
      expect.deepEqual(
        await sprites.evaluateAll((els) =>
          els.map((el) => el.querySelector("[data-accessory]")?.getAttribute("data-accessory")),
        ),
        ["shades", "phones", "cap"],
      );
      expect.equal(
        await sprites.evaluateAll((els) =>
          els.every((el) => el.querySelector(".px-sprite--still") !== null),
        ),
        true,
        "every sprite is still",
      );
      expect.equal(
        await page
          .locator('.swarm-blob[data-pane-id="w-claude"] .swarm-blob__dot[data-dot="attn"]')
          .count(),
        1,
        "needs you = the amber dot",
      );
      ctx.step("the pile: a count; a click lays it out");
      const pile = page.getByRole("button", { name: "1 finished worker" });
      expect.match((await pile.textContent()) ?? "", /\+1/);
      await pile.click();
      await page.locator('.swarm-blob[data-pane-id="w-done"]').waitFor({ state: "visible" });
      ctx.step("the window's title line: lights, logo, what it is doing — no model, no pill");
      await page.getByRole("button", { name: /^Worker: Add a mean test/ }).click();
      const win = page.locator('[data-worker-window="w-claude"]');
      await win.waitFor({ state: "visible", timeout: 5000 });
      const doing = win.locator(".whead [data-doing]");
      expect.equal((await doing.textContent())?.trim(), "Needs you · Run npm test");
      expect.equal(await doing.getAttribute("data-tone"), "attn");
      expect.equal(await win.locator(".whead [data-worker-state]").count(), 0, "no state pill");
      expect.ok(
        !((await win.locator(".whead").textContent()) ?? "").includes("claude-sonnet-5"),
        "the model is not in the title bar",
      );
      ctx.covered("sprite dock", "order, accessories, still, pile, window title line");
    },
    { control: "Worker dock — sprites + pile", severity: "broken" },
  );

  t.test(
    "clicking a worker's sprite opens its window: the feed, never a raw terminal",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      await routeFleet(page, fleet);
      await ctx.open(`/${HOST}/${THREAD}`);
      ctx.step("the sprite dock (dock closed) shows one sprite per worker");
      const sprite = page.getByRole("button", { name: /^Worker: Refactor clamp/ });
      await sprite.waitFor({ state: "visible", timeout: 15_000 });
      await sprite.click();
      const win = page.locator('[data-worker-window="w-codex"]');
      await win.waitFor({ state: "visible", timeout: 5000 });
      const pane = win.locator('[data-worker-pane="w-codex"]');
      expect.equal(await pane.getAttribute("data-variant"), "window");
      expect.equal(await pane.getAttribute("data-worker-body"), "feed");
      expect.equal(
        await win.locator("[data-worker-terminal]").count(),
        0,
        "no terminal for a GUI worker",
      );
      await win.locator('[data-feed-item="x2"]').waitFor({ state: "visible", timeout: 10_000 });
      expect.deepEqual(
        await win
          .locator(".wb-light")
          .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))),
        ["Stop worker", "Minimize worker window", "Maximize worker window"],
      );
      ctx.step("steer from the window");
      const input = win.getByRole("textbox", { name: "Steer worker w-codex" });
      await input.fill("Use Math.min/max.");
      await input.press("Enter");
      await win.getByText("Use Math.min/max.").waitFor({ timeout: 5000 });
      expect.equal(
        fleet.calls.filter((c) => c.tag === "fleet.steer").at(-1)?.payload.paneId,
        "w-codex",
      );
      ctx.step("green maximizes, green again restores");
      const before = await win.boundingBox();
      await win.locator('[data-light="zoom"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-worker-window="w-codex"]')
            ?.getAttribute("data-maximized") === "true",
      );
      await ctx.sleep(300);
      const max = await win.boundingBox();
      expect.ok(max.width > before.width && max.height > before.height, "the window grew");
      await win.locator('[data-light="zoom"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-worker-window="w-codex"]')
            ?.getAttribute("data-maximized") === "false",
      );
      ctx.step("drag the title bar moves the window");
      await ctx.sleep(300);
      const b0 = await win.boundingBox();
      const title = win.locator(".whead .who");
      const tb = await title.boundingBox();
      await page.mouse.move(tb.x + 10, tb.y + 6);
      await page.mouse.down();
      await page.mouse.move(tb.x - 110, tb.y + 66, { steps: 6 });
      await page.mouse.up();
      await ctx.sleep(300);
      const b1 = await win.boundingBox();
      expect.ok(
        Math.abs(b1.x - (b0.x - 120)) < 4 && Math.abs(b1.y - (b0.y + 60)) < 4,
        `moved to ${b1.x},${b1.y} from ${b0.x},${b0.y}`,
      );
      ctx.step("yellow tucks it back into the sprite");
      await win.locator('[data-light="minimize"]').click();
      await win.waitFor({ state: "detached", timeout: 3000 });
      ctx.step("another sprite opens that worker; Esc closes");
      await page.getByRole("button", { name: /^Worker: Add a mean test/ }).click();
      const win2 = page.locator('[data-worker-window="w-claude"]');
      await win2.waitFor({ state: "visible", timeout: 5000 });
      await win2.locator('.wb-pinned [data-approval="req-1"]').waitFor({ timeout: 10_000 });
      await win2.locator(".whead .who b").click();
      await page.keyboard.press("Escape");
      await win2.waitFor({ state: "detached", timeout: 3000 });
      ctx.covered("sprite → worker window", "feed, steer, lights, drag, Esc");
    },
    { control: "Worker window — sprite click", severity: "broken" },
  );

  t.test(
    "the window answers approvals and stops through the same lights",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      await routeFleet(page, fleet);
      await ctx.open(`/${HOST}/${THREAD}`);
      await page.getByRole("button", { name: /^Worker: Add a mean test/ }).click();
      const win = page.locator('[data-worker-window="w-claude"]');
      const allow = win
        .locator('[data-approval="req-1"]')
        .getByRole("button", { name: "Allow", exact: true });
      await allow.waitFor({ state: "visible", timeout: 10_000 });
      await allow.click();
      for (let i = 0; i < 30 && !fleet.calls.some((c) => c.tag === "fleet.respondApproval"); i++)
        await ctx.sleep(100);
      expect.equal(
        fleet.calls.find((c) => c.tag === "fleet.respondApproval")?.payload.decision,
        "accept",
      );
      ctx.step(
        "red → Stop? → fleet.kill; the window goes back into its sprite (the grid shelves a stopped pane too)",
      );
      await win.locator('[data-light="stop"]').click();
      await win.getByRole("button", { name: "Confirm stop" }).click();
      for (let i = 0; i < 30 && !fleet.calls.some((c) => c.tag === "fleet.kill"); i++)
        await ctx.sleep(100);
      expect.equal(fleet.calls.find((c) => c.tag === "fleet.kill")?.payload.paneId, "w-claude");
      await win.waitFor({ state: "detached", timeout: 3000 });
      ctx.covered("worker window approval + stop");
    },
    { control: "Worker window — approvals + stop", severity: "broken" },
  );

  t.test(
    "a swarm worker's window has Terminal and Report tabs; Terminal shows its PTY, Activity its feed",
    async (ctx) => {
      const { page, expect } = ctx;
      const fleet = fakeFleet();
      fleet.workers.push({
        ...SWARM_SAMPLE,
        paneId: "w-oc",
        terminalId: "worker:w-oc",
        title: "Find dead exports",
        surface: "gui",
        createdAt: Date.now() - 60_000,
        lastOutputAt: Date.now() - 1000,
      });
      fleet.feeds["w-oc"] = [
        { id: "o1", at: Date.now(), kind: "user", text: "List dead exports.", source: "leader" },
      ];
      await routeFleet(page, fleet);
      await ctx.open(`/${HOST}/${THREAD}`);
      ctx.step("its task is done, so its sprite rests in the folded pile: lay the pile out first");
      await page.locator(".swarm-blob-dock__pile").click();
      await page.getByRole("button", { name: /^Worker: Find dead exports/ }).click();
      const win = page.locator('[data-worker-window="w-oc"]');
      await win.waitFor({ state: "visible", timeout: 5000 });
      const tabs = await win.getByRole("tab").evaluateAll((els) => els.map((el) => el.dataset.tab));
      expect.deepEqual(tabs.slice(0, 3), ["activity", "terminal", "report"]);
      expect.match((await win.locator('[data-tab="report"]').textContent()) ?? "", /Report · /);
      const pane = win.locator('[data-worker-pane="w-oc"]');
      expect.equal(await pane.getAttribute("data-worker-body"), "feed");
      ctx.step("Terminal tab → the PTY viewport");
      await win.locator('[data-tab="terminal"]').click();
      await win.locator('[data-worker-terminal="worker:w-oc"]').waitFor({ timeout: 5000 });
      expect.equal(await pane.getAttribute("data-worker-body"), "terminal");
      ctx.step("Activity tab → back to the feed");
      await win.locator('[data-tab="activity"]').click();
      await win.locator('[data-feed-item="o1"]').waitFor({ timeout: 5000 });
      expect.equal(await win.locator("[data-worker-terminal]").count(), 0);
      ctx.covered("worker window tabs", "activity / terminal / report");
    },
    { control: "Worker window — swarm tabs", severity: "broken" },
  );
});
