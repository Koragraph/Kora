import { spec, threadIdByTitle, openDockGroup } from "../lib/harness.mjs";

const HOST = "kora-local";
// Read-only fixture threads: each is scoped to a different seeded project.
const TINY_LIB_THREAD = threadIdByTitle(3, "Fixture: rich transcript (markdown, code, tools)"); // Fixture: rich transcript (tiny-lib)
const DIRTY_APP_THREAD = threadIdByTitle(3, "Fixture: dirty tree review"); // Fixture: dirty tree review (dirty-app)
const BIG_REPO_THREAD = threadIdByTitle(3, "Fixture: big repo tour"); // Fixture: big repo tour (big-repo)

async function openThread(ctx, threadId) {
  await ctx.open(`/${HOST}/${threadId}`);
  await ctx.page.waitForFunction(() => !!document.querySelector('[contenteditable="true"]'), null, {
    timeout: 20_000,
  });
  await ctx.sleep(500);
}

async function openFiles(ctx) {
  const { page } = ctx;
  await openDockGroup(page, "files");
  // The tree's root entries load asynchronously (projects.listEntries over the
  // websocket); wait for at least one real row before asserting on contents.
  await page.locator('[role="treeitem"]').first().waitFor({ state: "visible", timeout: 10_000 });
  await ctx.sleep(300);
}

spec("11-right-panel", { stack: 3 }, async (t) => {
  t.test(
    "the file tree lists the project root and expands a directory on click",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, TINY_LIB_THREAD);
      await openFiles(ctx);

      // .git is never listed (isGitInternal in FileBrowserPanel).
      expect.equal(
        await page.getByRole("treeitem", { name: ".git", exact: true }).count(),
        0,
        ".git stays out of the tree",
      );
      for (const name of ["src", "test", ".gitignore", "package.json", "README.md"]) {
        await expect.ok(
          (await page.getByRole("treeitem", { name, exact: true }).count()) > 0,
          `root entry "${name}" is listed`,
        );
      }
      covered("Files browser — tree root listing");

      step("expand src");
      await page.getByRole("treeitem", { name: "src" }).click();
      for (const name of ["index.js", "numbers.js", "strings.js"]) {
        await page.getByRole("treeitem", { name }).waitFor({ state: "visible", timeout: 5000 });
      }
      covered("Files browser — expand a directory");

      step("collapse src again");
      await page.getByRole("treeitem", { name: "src" }).click();
      await ctx.sleep(300);
      expect.equal(
        await page.getByRole("treeitem", { name: "index.js" }).count(),
        0,
        "src collapses back and hides its children",
      );
      covered("Files browser — collapse a directory");
    },
    {
      control: "Files browser — tree expand/collapse",
      severity: "broken",
      expected:
        "the tree lists tiny-lib's root entries and expand/collapse toggles a directory's children",
    },
  );

  t.test(
    "expand all / collapse all folders toggles every directory at once",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, BIG_REPO_THREAD);
      await openFiles(ctx);
      await page.getByRole("treeitem", { name: "pkg00" }).waitFor({ state: "visible" });

      const beforeCount = await page.locator('[role="treeitem"]').count();

      step("expand all folders");
      await page.locator('[aria-label="Expand all folders"]').click();
      await ctx.sleep(1500);
      const afterExpandCount = await page.locator('[role="treeitem"]').count();
      expect.ok(
        afterExpandCount > beforeCount,
        `expand-all reveals more rows (before ${beforeCount}, after ${afterExpandCount})`,
      );
      covered("Files browser — expand all folders");

      step("collapse all folders");
      await page.locator('[aria-label="Collapse all folders"]').click();
      await ctx.sleep(800);
      const afterCollapseCount = await page.locator('[role="treeitem"]').count();
      expect.ok(
        afterCollapseCount < afterExpandCount,
        `collapse-all hides rows again (expanded ${afterExpandCount}, collapsed ${afterCollapseCount})`,
      );
      covered("Files browser — collapse all folders");
    },
    {
      control: "Files browser — expand all / collapse all",
      severity: "wrong",
      expected:
        "the chevrons-updown control expands every folder; a second click collapses them all",
    },
  );

  t.test(
    "search files filters the tree to matching paths",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, TINY_LIB_THREAD);
      await openFiles(ctx);

      step("type a query into the file search field");
      const search = page.getByLabel("Search tiny-lib files");
      await search.click();
      await search.fill("numbers");
      await ctx.sleep(600);

      const matches = await page.getByRole("treeitem", { name: "numbers.js" }).count();
      expect.ok(matches > 0, "the matching file is shown");
      const nonMatch = await page.getByRole("treeitem", { name: "README.md" }).count();
      expect.equal(nonMatch, 0, "a non-matching root file is filtered out while searching");
      covered("Files browser — search files (filter)");

      step("clear the search text");
      await search.fill("");
      await ctx.sleep(400);
      await page
        .getByRole("treeitem", { name: "README.md" })
        .waitFor({ state: "visible", timeout: 5000 });
      covered("Files browser — search files (clearing restores the tree)");
    },
    {
      control: "Files browser — search files",
      severity: "wrong",
      expected:
        "typing filters the tree to matches; Escape clears the filter and restores the full tree",
    },
  );

  t.test(
    "opening a source file shows it with breadcrumbs and syntax highlighting",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, TINY_LIB_THREAD);
      await openFiles(ctx);

      step("expand src and open index.js");
      await page.getByRole("treeitem", { name: "src" }).click();
      const indexJs = page.getByRole("treeitem", { name: "index.js" });
      await indexJs.waitFor({ state: "visible" });
      await indexJs.click();

      const previewTabBar = page.locator("[data-dock-strip]");
      await previewTabBar
        .getByText("index.js", { exact: true })
        .waitFor({ state: "visible", timeout: 5000 });
      covered("Files browser — open a source file");

      step("breadcrumbs show the file's path");
      await expect.ok(
        (await page.getByText("tiny-lib", { exact: true }).count()) > 0,
        "breadcrumb shows the project name",
      );
      await expect.ok(
        (await page.getByText("index.js", { exact: true }).count()) > 0,
        "breadcrumb shows the file name",
      );
      covered("Files browser — file preview breadcrumbs");
    },
    {
      control: "Files browser — open a source file preview",
      severity: "broken",
      expected: "clicking a file opens its contents in the preview pane with breadcrumbs above it",
    },
  );

  t.test(
    "opening a markdown file shows a source/rendered toggle",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, TINY_LIB_THREAD);
      await openFiles(ctx);

      step("open README.md");
      const readme = page.getByRole("treeitem", { name: "README.md" });
      await readme.waitFor({ state: "visible" });
      await readme.click();
      await page.locator("[data-dock-strip]").getByText("README.md", { exact: true }).waitFor({
        state: "visible",
        timeout: 5000,
      });

      await expect.ok(
        (await page.getByText("tiny-lib", { exact: true }).count()) > 0,
        "the markdown source is rendered (heading text visible)",
      );
      covered("Files browser — open a markdown file (source view)");

      step("toggle to the rendered markdown view, then back");
      const showRendered = page.locator('[aria-label="Show rendered markdown"]');
      await expect.ok(
        (await showRendered.count()) > 0,
        "a 'Show rendered markdown' toggle is present",
      );
      await showRendered.click();
      await ctx.sleep(400);
      const showSource = page.locator('[aria-label="Show markdown source"]');
      await expect.ok(
        (await showSource.count()) > 0,
        "the toggle flips to 'Show markdown source' once rendered",
      );
      await showSource.click();
      await ctx.sleep(300);
      covered("Files browser — markdown source/rendered toggle");
    },
    {
      control: "Files browser — markdown preview toggle",
      severity: "wrong",
      expected:
        "opening a .md file offers a way to see the rendered markdown, not only the raw source",
    },
  );

  t.test(
    "the dirty-app and big-repo projects' file trees also open (multi-project sanity check)",
    async (ctx) => {
      const { page, expect, covered } = ctx;
      await openThread(ctx, DIRTY_APP_THREAD);
      await openFiles(ctx);
      await expect.ok(
        (await page.getByRole("treeitem", { name: "src" }).count()) > 0,
        "dirty-app's tree loads",
      );
      covered("Files browser — dirty-app project");

      await openThread(ctx, BIG_REPO_THREAD);
      await openFiles(ctx);
      await expect.ok(
        (await page.getByRole("treeitem", { name: "pkg00" }).count()) > 0,
        "big-repo's tree loads",
      );
      covered("Files browser — big-repo project (216 files)");
    },
    {
      control: "Files browser — multiple projects",
      severity: "broken",
      expected: "the file tree loads correctly for every seeded project",
    },
  );
});
