import { describe, expect, it } from "vite-plus/test";

import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "./transcriptAnchor.ts";

type Entry = { key: string; pinnable: boolean };

const entry = (key: string, pinnable = true): Entry => ({ key, pinnable });
const keyOf = (item: Entry) => (item.pinnable ? item.key : null);

const list = [entry("top"), entry("note", false), entry("newest")];

const resolve = (items: ReadonlyArray<Entry>, wanted: string | null, offset?: number) =>
  resolveChatListAnchoredEndSpace(
    items,
    wanted,
    keyOf,
    offset === undefined ? undefined : { anchorOffset: offset },
  );

describe("chat list end space", () => {
  it("reserves space when the wanted key is the first pinnable entry", () => {
    expect(resolve(list, "top")).toEqual({ anchorIndex: 0, anchorOffset: CHAT_LIST_ANCHOR_OFFSET });
  });

  it("uses a caller-provided offset", () => {
    expect(resolve(list, "top", 96)).toEqual({ anchorIndex: 0, anchorOffset: 96 });
  });

  it("reserves nothing for a pinnable entry that is not the first", () => {
    expect(resolve(list, "newest")).toBeUndefined();
  });

  it("counts the index past leading entries that cannot pin", () => {
    expect(resolve([entry("note", false), entry("newest")], "newest")).toEqual({
      anchorIndex: 1,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    });
  });

  it.each([["note"], ["absent"], [null]])("returns undefined for %s", (wanted) => {
    expect(resolve(list, wanted)).toBeUndefined();
  });
});
