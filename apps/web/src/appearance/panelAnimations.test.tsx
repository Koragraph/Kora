import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { usePanelNavigationSuppression } from "./panelAnimations";

let tree: ReactTestRenderer | null = null;
let frames: FrameRequestCallback[] = [];
let seen: boolean[] = [];

function Probe({ route }: { route: string }) {
  const suppressed = usePanelNavigationSuppression(route);
  useLayoutEffect(() => void seen.push(suppressed), [suppressed]);
  return null;
}

beforeEach(() => {
  frames = [];
  seen = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    cancelAnimationFrame: vi.fn(),
    requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => frames.push(cb)),
  });
});

afterEach(async () => {
  await act(() => tree?.unmount());
  vi.unstubAllGlobals();
});

const flushOneFrame = () => act(() => frames.shift()?.(0));
const latest = () => seen.at(-1);

test("panel animations stay suppressed for two animation frames after the first mount and after each navigation", async () => {
  await act(() => {
    tree = create(<Probe route="/thread/one" />);
  });
  expect(latest()).toBe(true);

  await flushOneFrame();
  expect(latest()).toBe(true);
  await flushOneFrame();
  expect(latest()).toBe(false);

  await act(() => tree?.update(<Probe route="/thread/two" />));
  expect(latest()).toBe(true);

  await flushOneFrame();
  expect(latest()).toBe(true);
  await flushOneFrame();
  expect(latest()).toBe(false);
});
