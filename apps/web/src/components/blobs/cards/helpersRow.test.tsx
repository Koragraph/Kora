// "Popo used 2 helpers": one quiet line for a blob's helper activity, never worker / swarm rows or "[kora]" prompts.
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BlobCardRef } from "../../../thread/timeline";

vi.mock("../chat/blobSkin", () => ({
  useBlobSkin: () => ({ blobId: "b", name: "Popo", title: "Researcher", chief: false, outfit: {} }),
}));

import { HelpersRow, helpersLine, parseHelpers } from "./HelpersRow";

const ref = (payload: Record<string, unknown>): BlobCardRef => ({
  cardId: "helpers:t",
  version: 0,
  payload: { cardKind: "helpers", ...payload },
});
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");

describe("helpers row", () => {
  it("says what happened in plain words: is using / used, a helper / N helpers", () => {
    expect(helpersLine("Popo", { count: 2, working: 0, titles: [] })).toBe("Popo used 2 helpers");
    expect(helpersLine("Popo", { count: 1, working: 0, titles: [] })).toBe("Popo used a helper");
    expect(helpersLine("Popo", { count: 3, working: 1, titles: [] })).toBe(
      "Popo is using 3 helpers",
    );
    expect(parseHelpers(ref({ count: 2, working: 5, titles: ["a", 7, ""] }))).toEqual({
      count: 2,
      working: 2,
      titles: ["a"],
    });
    expect(parseHelpers({ cardId: "x", version: 0, payload: { cardKind: "memory" } })).toBeNull();
  });
  it("renders one muted line; the helper tasks sit behind a click", () => {
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(
        <HelpersRow
          card={ref({
            count: 2,
            working: 0,
            titles: ["Read the pricing pages", "Check the claims"],
          })}
        />,
      );
    });
    expect(text(r.root.findAll((n) => n.props["data-helpers-line"] !== undefined)[0]!)).toBe(
      "Popo used 2 helpers",
    );
    expect(text(r.root)).not.toMatch(/swarm|worker|\[kora\]/i);
    expect(text(r.root)).not.toContain("Read the pricing pages");
    act(() => {
      r.root.findAll((n) => n.type === "button")[0]!.props.onClick();
    });
    expect(text(r.root)).toContain("Read the pricing pages");
  });
});
