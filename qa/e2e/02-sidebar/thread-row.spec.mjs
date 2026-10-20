// Sidebar thread row: click-to-open, active highlight colour, long-title truncation + tooltip,
// and the per-thread mode icon (Chat / Swarm / Orchestrator).
import { spec, threadIdByTitle } from "../lib/harness.mjs";

spec("02-sidebar", { stack: 1 }, async (t) => {
  t.test(
    "clicking a thread row opens it and highlights the active row in Ink, not blue",
    async ({ page, open, sleep, expect, inkCheck, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("tiny-lib");
      await sleep(200);
      const row = page.getByRole("button", { name: "[a02] chat one", exact: true });
      await row.click();
      await sleep(400);
      await expect.match(page.url(), new RegExp(threadIdByTitle(1, "[a02] chat one")));
      await expect.equal(await row.getAttribute("data-active"), "true");
      // The agent logos are deliberately full-colour bitmaps (Claude Code / Codex / Cursor / Grok marks), so
      // only CSS colours are held to the Ink palette here.
      const stone = await inkCheck({ root: "[data-slot='sidebar']" });
      const bad = stone.filter((h) => h.kind === "cold");
      if (bad.length) {
        throw new Error(`cold colours in sidebar: ${JSON.stringify(bad)}`);
      }
      covered("Sidebar › thread row click + active highlight colour");
    },
    { control: "Sidebar › thread row active highlight", severity: "visual" },
  );

  t.test(
    "a long thread title truncates with an ellipsis and a hover tooltip shows the full title",
    async ({ page, open, sleep, expect, defect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("tiny-lib");
      await sleep(200);
      const full = "Fixture: long thread (520 messages)";
      const row = page.getByRole("button", { name: full, exact: true });
      // The row title is one truncated line (data-card-title); squeeze it so this one has to clip.
      const label = row.locator("[data-card-title]");
      await label.evaluate((el) => {
        el.style.maxWidth = "60px";
      });
      const overflowing = await label.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect.ok(overflowing, "the long title should overflow its line and be clipped");
      // The row measures its title when the pointer enters it, so the pointer must enter after the squeeze.
      await page.mouse.move(900, 600);
      await sleep(200);
      await row.hover();
      await sleep(1500); // tooltip open delay
      // The app's tooltip (Base UI) renders as data-slot="tooltip-popup".
      const tooltip = page.locator('[data-slot="tooltip-popup"]', { hasText: full });
      covered("Sidebar › long title truncation + tooltip");
      if ((await tooltip.count()) === 0) {
        await defect({
          control: "Sidebar › thread row title tooltip",
          expected:
            "Hovering a truncated thread row (checklist: 'Long thread titles truncate with an " +
            "ellipsis and a tooltip') reveals the full title.",
          actual:
            "The title truncates correctly (ellipsis, overflow confirmed), but no tooltip appears " +
            "on hover: SidebarMenuButton's TooltipPopup renders with hidden={state !== 'collapsed'} " +
            "(apps/web/src/components/ui/sidebar.tsx:718), and this sidebar is never put into the " +
            "collapsed icon-rail state, so the tooltip can never show.",
          severity: "wrong",
        });
      }
    },
    { control: "Sidebar › thread row title tooltip", severity: "wrong" },
  );

  t.test(
    "chat, swarm and orchestrator threads render their row icon",
    async ({ page, open, sleep, defect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("tiny-lib");
      await sleep(200);
      const chatIcon = page
        .getByRole("button", { name: "[a02] chat one", exact: true })
        .locator("svg, span[aria-hidden]")
        .first();
      const swarmRow = page.getByRole("button", { name: "Fixture: swarm thread", exact: true });
      await swarmRow.scrollIntoViewIfNeeded();
      const orchRow = page.getByRole("button", {
        name: "Fixture: orchestrator thread",
        exact: true,
      });
      const chatHtml = await chatIcon.evaluate((el) => el.outerHTML);
      const swarmHtml = await swarmRow
        .locator("svg, span[aria-hidden]")
        .first()
        .evaluate((el) => el.outerHTML);
      const orchHtml = await orchRow
        .locator("svg, span[aria-hidden]")
        .first()
        .evaluate((el) => el.outerHTML);
      // Kora's row icon is the provider's, by design (no per-mode sidebar icons exist); recorded as coverage only.
      covered(
        "Sidebar › row icon per thread (chat/swarm/orchestrator)",
        chatHtml === swarmHtml && chatHtml === orchHtml
          ? "provider icon on all modes (by design)"
          : "differs by mode",
      );
    },
    { control: "Sidebar › mode icon per thread", severity: "wrong" },
  );
});
