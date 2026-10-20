import { spec, threadIdByTitle, openDockGroup, openDockPanel } from "../lib/harness.mjs";

const HOST = "kora-local";
const ORCHESTRATOR_THREAD = threadIdByTitle(3, "[a11] orchestrator"); // [a11] orchestrator

async function openThread(ctx, threadId) {
  await ctx.open(`/${HOST}/${threadId}`);
  await ctx.page.waitForFunction(() => !!document.querySelector('[contenteditable="true"]'), null, {
    timeout: 20_000,
  });
  await ctx.sleep(500);
}

spec("11-right-panel", { stack: 3 }, async (t) => {
  t.test(
    "Workers opens the fleet's panes from the dock on an Orchestrator thread",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, ORCHESTRATOR_THREAD);

      step("the panel offers Workers on a fleet thread");
      await openDockPanel(page);
      const workers = page.locator('[data-dock-tabs] [data-dock-group="workers"]');
      await workers.waitFor({ state: "visible", timeout: 5000 });
      covered("Dock tabs › Workers is offered from an orchestrator thread");

      step("open Workers");
      await openDockGroup(page, "workers");
      covered("Dock panel › Workers (orchestrator thread)");

      step("there is no Agents (native subagents) surface anywhere");
      expect.equal(
        await page.locator('[data-dock-tabs] [data-dock-group="agents"]').count(),
        0,
        "no Agents tab",
      );
    },
    {
      control: "Dock — Workers on an orchestrator thread",
      severity: "wrong",
      expected:
        "Workers opens without error even with no live workers yet; no Agents surface exists",
    },
  );
});
