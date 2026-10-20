// Settings › Agents (route /settings/providers): On / Off groups of agent cards, each opening into
// Setup / Models / Environment. Turning an agent on and off writes this stack's daemon settings only.
import { spec } from "../lib/harness.mjs";

async function openAgents(ctx) {
  await ctx.open("/settings/providers");
  await ctx.page.locator("[data-agent-card]").first().waitFor({ timeout: 15_000 });
  await ctx.sleep(300);
}

const card = (page, id) => page.locator(`[data-agent-card="${id}"]`);

spec("14-settings-defaults", { stack: 3 }, async (t) => {
  t.test(
    "the Agents page groups agents into On and Off with a readiness line each",
    async (ctx) => {
      const { page, expect, covered } = ctx;
      await openAgents(ctx);
      expect.ok(
        (await page.getByRole("heading", { name: /^On · \d+$/ }).count()) === 1,
        "an On group heading with a count",
      );
      for (const id of ["claude", "codex"]) {
        expect.equal(await card(page, id).count(), 1, `${id} has a card`);
      }
      expect.equal(await page.getByRole("switch").count(), 0, "the list has no on/off switches");
      expect.equal(
        await page.getByRole("button", { name: "Settings scope" }).count(),
        0,
        "agents are machine state: no project scope picker",
      );
      covered("Settings › Agents — On / Off groups");
    },
    {
      control: "Settings › Agents page",
      severity: "wrong",
      expected: "agents listed as cards in On / Off groups, no list switches, no scope picker",
    },
  );

  t.test(
    "a card opens into Setup / Models / Environment tabs",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openAgents(ctx);
      const claude = card(page, "claude");
      await claude.locator("button[aria-expanded]").first().click();
      await claude.getByRole("tab", { name: "Setup" }).waitFor();
      expect.ok(
        (await claude.getByText("Name in the picker", { exact: true }).count()) === 1,
        "Setup shows the picker name field",
      );
      covered("Settings › Agents › card › Setup");

      step("Models");
      await claude.getByRole("tab", { name: "Models" }).click();
      await claude.getByText(/Star the models you reach for/).waitFor();
      covered("Settings › Agents › card › Models");

      step("Environment");
      await claude.getByRole("tab", { name: "Environment" }).click();
      await claude.getByRole("button", { name: "Add variable" }).waitFor();
      covered("Settings › Agents › card › Environment");
    },
    {
      control: "Settings › Agents › agent card",
      severity: "broken",
      expected: "opening a card shows its Setup, Models and Environment tabs",
    },
  );

  t.test(
    "Turn on moves an agent to On and Turn off moves it back",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openAgents(ctx);
      const off = page.getByRole("list", { name: "Agents that are off" });
      const firstOff = off.locator("[data-agent-card]").first();
      const id = await firstOff.getAttribute("data-agent-card");
      expect.ok(id, "there is an agent that is off");

      step(`turn ${id} on`);
      await firstOff.getByRole("button", { name: /^Turn on / }).click();
      const on = page.getByRole("list", { name: "Agents that are on" });
      await on.locator(`[data-agent-card="${id}"]`).waitFor({ timeout: 8000 });
      covered("Settings › Agents › Turn on");

      step(`turn ${id} off again from its Setup tab`);
      const moved = on.locator(`[data-agent-card="${id}"]`);
      await moved.locator("button[aria-expanded]").first().click();
      await moved.getByRole("button", { name: /^Turn off / }).click();
      await off.locator(`[data-agent-card="${id}"]`).waitFor({ timeout: 8000 });
      covered("Settings › Agents › Turn off");
    },
    {
      control: "Settings › Agents › Turn on / Turn off",
      severity: "broken",
      expected: "turning an agent on moves its card to On; turning it off moves it back to Off",
    },
  );
});
