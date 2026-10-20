import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("~/stores/webIconStore", () => ({ useFaviconForThreadUrl: () => null }));

import { FaviconImage } from "./WebFaviconIcon";

let view: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => view?.unmount());
  vi.unstubAllGlobals();
});

test("a failing favicon source falls through to the next, then to the fallback, and a new source list starts over", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const inline = "data:image/png;base64,QUJD";
  const remote = "https://cdn.test/icon.png";
  const tree = (sources: string[]) => (
    <FaviconImage sources={sources} fallback={<span>none</span>} />
  );
  const shownSrc = () => view!.root.findByType("img").props.src;
  const failImage = () => act(async () => view!.root.findByType("img").props.onError());

  await act(async () => {
    view = create(tree([inline, remote]));
  });
  expect(shownSrc()).toBe(inline);

  await failImage();
  expect(shownSrc()).toBe(remote);

  await failImage();
  expect(view!.root.findAllByType("img")).toHaveLength(0);
  expect(view!.root.findByType("span").children).toEqual(["none"]);

  await act(async () => view!.update(tree([inline, "https://cdn.test/other.png"])));
  expect(shownSrc()).toBe(inline);
});
