import { act, StrictMode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePromptMenuState } from "./usePromptMenuState";

/** Records every committed `open` value and counts popup closes (open effects cleaned up). */
function harness() {
  const seen: boolean[] = [];
  const closed = vi.fn();
  let request: (open: boolean) => void = () => {};

  function Menu({ hidden }: { hidden: boolean }) {
    const [open, setOpen] = usePromptMenuState(hidden);
    useLayoutEffect(() => {
      request = setOpen;
      seen.push(open);
      return open ? closed : undefined;
    }, [open, setOpen]);
    return null;
  }

  let tree: ReactTestRenderer | undefined;
  const show = (hidden: boolean) =>
    act(() => {
      const element = (
        <StrictMode>
          <Menu hidden={hidden} />
        </StrictMode>
      );
      if (tree) tree.update(element);
      else tree = create(element);
    });

  return {
    seen,
    closed,
    show,
    ask: (open: boolean) => act(() => request(open)),
    unmount: () => act(() => tree?.unmount()),
  };
}

let menu: ReturnType<typeof harness>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  menu = harness();
});

afterEach(async () => {
  await menu.unmount();
  vi.unstubAllGlobals();
});

describe("usePromptMenuState", () => {
  it("never shows a menu opened while its trigger was hidden", async () => {
    await menu.show(true);
    await menu.ask(true);
    await menu.show(false);

    expect(menu.seen).not.toContain(true);
    expect(menu.closed).not.toHaveBeenCalled();
  });

  it("closes the menu when the trigger hides and keeps it closed when it comes back", async () => {
    await menu.show(false);
    await menu.ask(true);
    expect(menu.seen.at(-1)).toBe(true);

    await menu.show(true);
    expect(menu.seen.at(-1)).toBe(false);
    expect(menu.closed).toHaveBeenCalledOnce();

    const before = menu.seen.length;
    await menu.show(false);
    // Revealing the trigger changes nothing: the stored state was reset too.
    expect(menu.seen.length).toBe(before);
  });

  it("opens and closes normally while visible", async () => {
    await menu.show(false);
    await menu.ask(true);
    await menu.ask(false);
    expect(menu.seen.slice(-2)).toEqual([true, false]);
    expect(menu.closed).toHaveBeenCalledOnce();
  });
});
