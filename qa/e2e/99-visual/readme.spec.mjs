// The README's screenshots (docs/media/*.png), from a demo-seeded stack. No model spend: the workers are a fake fleet
// answered on the page's RPC socket (the same technique as qa/e2e/fleet/worker-boxes.spec.mjs).
//
//   KORA_QA_DIR=<scratch> KORA_QA_SEED_DEMO=1 KORA_QA_SEED_OFFLINE=1 node qa/stacks/stack.cjs seed 1
//   KORA_QA_DIR=<scratch> node qa/stacks/stack.cjs up 1
//   KORA_QA_DIR=<scratch> node qa/e2e/99-visual/readme.spec.mjs
//   node qa/stacks/stack.cjs down 1
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spec, threadIdByTitle, openDockGroup } from "../lib/harness.mjs";

const STACK = 1;
const HOST = "kora-local";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/media");
const LEAD = "Ship rate limiting for the public API";
fs.mkdirSync(OUT, { recursive: true });

const minutesAgo = (m) => Date.now() - m * 60_000;

function worker(paneId, agent, title, model, extra = {}) {
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
    cwd: "/Users/dev/acme-api",
    worktree: {
      path: `/Users/dev/.kora/worktrees/acme-api/${paneId}`,
      branch: `kora/${paneId}`,
      mainRoot: "/Users/dev/acme-api",
      ahead: 2,
      dirty: 1,
    },
    costUsd: 0,
    contextPct: 18,
    exitCode: null,
    createdAt: minutesAgo(4),
    lastOutputAt: Date.now() - 1500,
    model,
    surface: "gui",
    pendingApproval: null,
    retrying: null,
    ...extra,
  };
}

const t = (m) => minutesAgo(m);
const tool = (id, at, name, title, status = "done", extra = {}) => ({
  id,
  at,
  kind: "tool",
  tool: name,
  title,
  detail: null,
  status,
  added: null,
  removed: null,
  ...extra,
});

function demoFleet() {
  const workers = [
    worker("limiter", "claude", "Token-bucket limiter middleware", "claude-sonnet-5-5", {
      costUsd: 0.21,
      contextPct: 24,
    }),
    worker("routes", "codex", "Per-route limits + config schema", "gpt-6-luna", {
      costUsd: 0.06,
      contextPct: 11,
    }),
    worker("tests", "opencode", "Tests for 429 + Retry-After", "opencode/big-pickle", {
      surface: "gui",
      state: "blocked",
      pendingApproval: { requestId: "ap-1", title: "Run the test suite" },
    }),
  ];
  const feeds = {
    limiter: [
      {
        id: "l1",
        at: t(4),
        kind: "user",
        text: "Token bucket per API key in `src/middleware/rateLimit.ts`; refill rate and burst from config. Don't touch routes.ts.",
        source: "leader",
      },
      tool("l2", t(3.8), "Graph", "explore auth middleware"),
      tool("l3", t(3.5), "Read", "Read src/middleware/auth.ts"),
      tool("l4", t(2.4), "Edit", "Create src/middleware/rateLimit.ts", "done", {
        added: 64,
        removed: 0,
      }),
      {
        id: "l5",
        at: t(1.2),
        kind: "assistant",
        text: "Limiter in place: one bucket per key, refills lazily on read so idle keys cost nothing. Exporting `rateLimit(opts)` for routes.ts.",
        streaming: false,
      },
      tool("l6", t(0.3), "Bash", "pnpm tsc --noEmit", "running"),
    ],
    routes: [
      {
        id: "r1",
        at: t(4),
        kind: "user",
        text: "Add `limits` to the route table and its config schema; default 60/min, 600/min for /health.",
        source: "leader",
      },
      tool("r2", t(3.6), "Read", "Read src/routes.ts"),
      tool("r3", t(2.1), "Edit", "Edit src/routes.ts", "done", { added: 18, removed: 3 }),
      {
        id: "r4",
        at: t(0.8),
        kind: "assistant",
        text: "Route limits added; `/health` gets the higher ceiling. Waiting on `rateLimit` from the limiter slice to wire it in.",
        streaming: false,
      },
    ],
    tests: [
      {
        id: "x1",
        at: t(4),
        kind: "user",
        text: "Tests: 429 after the burst, Retry-After header, separate buckets per key.",
        source: "leader",
      },
      tool("x2", t(3.2), "Write", "Create test/rateLimit.test.ts", "done", {
        added: 71,
        removed: 0,
      }),
      {
        id: "x3",
        at: t(0.5),
        kind: "approval",
        requestId: "ap-1",
        title: "Run the test suite",
        detail: "pnpm test -- rateLimit",
        status: "open",
      },
    ],
  };
  return { workers, feeds };
}

async function routeFleet(page, fleet, threadId) {
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    const mine = new Set();
    const chunk = (requestId, value) =>
      ws.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
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
        if ((m._tag === "Ack" || m._tag === "Interrupt") && mine.has(m.requestId)) continue;
        if (m._tag !== "Request" || !String(m.tag).startsWith("fleet.")) {
          pass.push(m);
          continue;
        }
        mine.add(m.id);
        if (m.tag === "fleet.subscribe") {
          chunk(m.id, {
            type: "snapshot",
            snapshot: {
              threadId,
              orchestratorId: "lead",
              workers: fleet.workers,
              plan: "",
              events: [],
              lastVerdict: null,
              updatedAt: new Date().toISOString(),
            },
          });
        } else if (m.tag === "fleet.subscribeWorker") {
          chunk(m.id, {
            type: "snapshot",
            paneId: m.payload.paneId,
            items: fleet.feeds[m.payload.paneId] ?? [],
          });
        } else {
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: m.id,
              exit: { _tag: "Success", value: null },
            }),
          );
        }
      }
      if (pass.length) server.send(JSON.stringify(Array.isArray(parsed) ? pass : pass[0]));
    });
    server.onMessage((m) => ws.send(m));
  });
}

/** A crisp (2x) page for one shot, sharing the stack's origin and storage setup. */
async function retina(ctx) {
  const browser = ctx.page.context().browser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("kora.surface.v1", '"code"');
    } catch {
      /* blocked */
    }
  });
  return { page: await context.newPage(), close: () => context.close() };
}

const settle = (page) => page.waitForTimeout(1200); // fonts, sprites, list virtualization

spec("readme", { stack: STACK }, async (tt) => {
  tt.test("fleet: a lead thread with three workers", async (ctx) => {
    const threadId = threadIdByTitle(STACK, "Rate limiting: three workers running");
    const { page, close } = await retina(ctx);
    try {
      await routeFleet(page, demoFleet(), threadId);
      await page.goto(`${ctx.stack.url}/${HOST}/${threadId}`, { waitUntil: "domcontentloaded" });
      await openDockGroup(page, "workers");
      await page
        .locator("[data-worker-pane]")
        .nth(2)
        .waitFor({ state: "visible", timeout: 20_000 });
      await settle(page);
      await page.screenshot({ path: path.join(OUT, "fleet.png") });
    } finally {
      await close();
    }
  });

  tt.test("worker picker: the lead's proposal", async (ctx) => {
    const threadId = threadIdByTitle(STACK, LEAD);
    const { page, close } = await retina(ctx);
    try {
      await page.goto(`${ctx.stack.url}/${HOST}/${threadId}`, { waitUntil: "domcontentloaded" });
      const picker = page.locator("[data-worker-picker]");
      await picker.waitFor({ state: "visible", timeout: 20_000 });
      await settle(page);
      await page.screenshot({ path: path.join(OUT, "worker-picker.png") });
    } finally {
      await close();
    }
  });

  tt.test("token savings settings", async (ctx) => {
    const { page, close } = await retina(ctx);
    try {
      await page.goto(`${ctx.stack.url}/settings/token-savings`, { waitUntil: "domcontentloaded" });
      await page
        .getByRole("heading", { name: /token savings/i })
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      await settle(page);
      await page.screenshot({ path: path.join(OUT, "savings.png") });
    } finally {
      await close();
    }
  });

  tt.test("extensions settings", async (ctx) => {
    const { page, close } = await retina(ctx);
    try {
      await page.goto(`${ctx.stack.url}/settings/extensions`, { waitUntil: "domcontentloaded" });
      // The list and the catalog arrive over RPC after the page shell: wait for a server row and a catalog card.
      await page
        .getByText("playwright", { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      await page
        .getByText("Context7", { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      // Servers found in the agents' own configs come from the machine running the stack: never in a published picture.
      await page.addStyleTag({ content: "#extensions-found { display: none !important; }" });
      await settle(page);
      await page.screenshot({ path: path.join(OUT, "extensions.png") });
    } finally {
      await close();
    }
  });
});
