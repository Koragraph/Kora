import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ExternalLinkContextMenuAction,
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./externalLinkContextMenu";

const AT = { x: 7, y: 9 };
const DOCS = "https://docs.test/guide?part=2#menus";
const PULL = "https://forge.test/team/app/pull/77";

/** Runs the menu as if the user picked `choice`; every effect is a spy. */
async function pick(
  choice: ExternalLinkContextMenuAction | null,
  extra: Partial<Parameters<typeof showExternalLinkContextMenu>[0]> = {},
) {
  const effects = {
    reportFailure: vi.fn(),
    updateThreadLink: vi.fn(async () => {}),
    copyLink: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    openInPreview: vi.fn(async () => {}),
    showContextMenu: vi.fn(async () => choice),
  };
  await showExternalLinkContextMenu({ href: DOCS, position: AT, ...effects, ...extra });
  return effects;
}

const menuIds = (effects: Awaited<ReturnType<typeof pick>>) =>
  (
    effects.showContextMenu.mock.calls[0] as unknown as [Array<{ id: string; label: string }>]
  )[0].map(({ id }) => id);

describe("showExternalLinkContextMenu", () => {
  it("lists preview, system browser and copy at the click position, and does nothing when dismissed", async () => {
    const effects = await pick(null);
    const wording: Record<string, string> = {
      "copy-link": "Copy Link",
      "open-external": "Open in system browser",
      "open-in-preview": "Open in integrated browser",
    };
    const expected = ["open-in-preview", "open-external", "copy-link"].map((id) => ({
      label: wording[id],
      id,
    }));
    expect(effects.showContextMenu).toHaveBeenCalledWith(expected, AT);
    for (const effect of [effects.openInPreview, effects.openExternal, effects.copyLink]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it("drops the preview entry where there is no integrated browser", async () => {
    expect(menuIds(await pick(null, { canOpenInPreview: false }))).toEqual([
      "open-external",
      "copy-link",
    ]);
  });

  it.each([
    ["link-to-thread", "Link to chat"],
    ["unlink-from-thread", "Unlink from chat"],
  ] as const)("puts %s first with its own label", async (threadLinkAction, label) => {
    const effects = await pick(null, { href: PULL, threadLinkAction });
    expect(menuIds(effects)[0]).toBe(threadLinkAction);
    expect(effects.showContextMenu.mock.calls[0]).toContainEqual(
      expect.arrayContaining([{ id: threadLinkAction, label }]),
    );
  });

  it.each([
    ["open-in-preview", "openInPreview"],
    ["open-external", "openExternal"],
    ["copy-link", "copyLink"],
  ] as const)("%s hands the exact link to %s only", async (choice, effect) => {
    const effects = await pick(choice);
    expect(effects[effect]).toHaveBeenCalledExactlyOnceWith(DOCS);
    const others = (["openInPreview", "openExternal", "copyLink"] as const).filter(
      (name) => name !== effect,
    );
    for (const other of others) expect(effects[other]).not.toHaveBeenCalled();
  });

  it.each([
    ["link-to-thread", true],
    ["unlink-from-thread", false],
  ] as const)("%s updates the thread link to %s", async (choice, linked) => {
    const effects = await pick(choice, { href: PULL, threadLinkAction: choice });
    expect(effects.updateThreadLink).toHaveBeenCalledWith(PULL, linked);
  });

  it("reports a menu that could not open and runs nothing", async () => {
    const broken = new Error("no native menu");
    const effects = await pick(null, {
      showContextMenu: vi.fn(async () => {
        throw broken;
      }),
    });
    expect(effects.reportFailure).toHaveBeenCalledExactlyOnceWith("show-link-context-menu", broken);
    expect(effects.copyLink).not.toHaveBeenCalled();
  });

  it.each([
    ["copy-link", "copyLink", "copy-link"],
    ["open-external", "openExternal", "open-link-external"],
    ["open-in-preview", "openInPreview", "open-link-in-preview"],
    ["link-to-thread", "updateThreadLink", "link-pull-request-to-thread"],
    ["unlink-from-thread", "updateThreadLink", "unlink-pull-request-from-thread"],
  ] as const)("reports a failing %s as %s", async (choice, effect, operation) => {
    const boom = new Error(`${choice} broke`);
    const failing = vi.fn(async () => {
      throw boom;
    });
    const effects = await pick(choice, { [effect]: failing });
    expect(effects.reportFailure).toHaveBeenCalledExactlyOnceWith(operation, boom);
  });
});

describe("resolveExternalWebLinkHost", () => {
  it.each([
    ["https://docs.test/a", "docs.test"],
    ["http://127.0.0.1:8080/x", "127.0.0.1"],
    ["//media.test/v.webm?sig=1#t=3", "media.test"],
  ])("finds the host of web link %s", (href, host) => {
    expect(resolveExternalWebLinkHost(href)).toBe(host);
  });

  it.each([
    "//",
    "#top",
    "mailto:me@mail.test",
    "file:///etc/hosts",
    "javascript:alert(1)",
    "plain words",
    undefined,
    "",
  ])("has no host for %j", (href) => {
    expect(resolveExternalWebLinkHost(href)).toBeNull();
  });
});
