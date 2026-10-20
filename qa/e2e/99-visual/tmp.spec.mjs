import { spec } from "../lib/harness.mjs";
spec("99-tmp", { stack: 3 }, async (t) => {
  t.test("settings", async ({ page, open }) => {
    await open("/settings/zzz", { wait: false });
    await page.waitForTimeout(5000);
    const url = page.url().replace("http://localhost:5730", "");
    if (url !== "/settings/general") throw new Error("url=" + url);
  });
});
