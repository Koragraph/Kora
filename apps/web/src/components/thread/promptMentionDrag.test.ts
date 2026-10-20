import { describe, expect, it } from "@effect/vitest";

import * as Drag from "./promptMentionDrag.ts";

const MENTION_TYPE = Drag.PROMPT_MENTION_DRAG_TYPE;

/** A drag event that logs which propagation calls it received. */
function dragOf(
  payload = "[notes.md](docs/notes.md)",
  types: string[] = [MENTION_TYPE, "text/plain"],
) {
  const trail: string[] = [];
  const event = {
    preventDefault: () => void trail.push("prevent"),
    stopPropagation: () => void trail.push("stop"),
    nativeEvent: { stopPropagation: () => void trail.push("native-stop") },
    dataTransfer: {
      types,
      dropEffect: "none",
      getData: (format: string) => (format === MENTION_TYPE ? payload : ""),
    },
  };
  return { event, trail };
}

/** A composer host that records what the handlers asked of it. */
function composer(accepts = true) {
  const calls: string[] = [];
  const host: Drag.PromptMentionDropHost = {
    setDragActive: (active) => void calls.push(active ? "highlight" : "unhighlight"),
    insertMentionAtEnd: (text) => (calls.push(`insert ${text}`), accepts),
    onInsertRejected: () => void calls.push("rejected"),
  };
  return { calls, handlers: Drag.makePromptMentionDragHandlers(host) };
}

describe("mention drag handlers", () => {
  it("highlights on enter, then inserts the mention plus a space on drop", () => {
    const { calls, handlers } = composer();
    handlers.onDragEnter(dragOf().event);
    handlers.onDrop(dragOf().event);
    expect(calls).toEqual(["highlight", "unhighlight", "insert [notes.md](docs/notes.md) "]);
  });

  it("says when the composer refused the insert", () => {
    const { calls, handlers } = composer(false);
    handlers.onDrop(dragOf().event);
    expect(calls.at(-1)).toBe("rejected");
  });

  it("only clears the highlight for an empty payload", () => {
    const { calls, handlers } = composer();
    handlers.onDrop(dragOf("").event);
    expect(calls).toEqual(["unhighlight"]);
  });

  it("asks for the move effect the file tree allows", () => {
    const { calls, handlers } = composer();
    const { event } = dragOf();
    handlers.onDragOver(event);
    expect(event.dataTransfer.dropEffect).toBe("move");
    expect(calls).toEqual(["highlight"]);
  });

  it("stops the native event as well as the React one", () => {
    const { handlers } = composer();
    const { event, trail } = dragOf();
    handlers.onDrop(event);
    expect(trail.toSorted()).toEqual(["native-stop", "prevent", "stop"]);
  });

  it("does not touch drags that carry no mention", () => {
    const { calls, handlers } = composer();
    const { event, trail } = dragOf("", ["Files"]);
    for (const handle of [handlers.onDragEnter, handlers.onDragOver, handlers.onDrop])
      handle(event);
    expect([calls, trail]).toEqual([[], []]);
    expect(event.dataTransfer.dropEffect).toBe("none");
  });
});

describe("mention payload helpers", () => {
  it("recognises the mention type among drag types", () => {
    expect(Drag.dataTransferHasPromptMention(["text/plain", MENTION_TYPE])).toBe(true);
    expect(Drag.dataTransferHasPromptMention(["text/uri-list"])).toBe(false);
    expect(Drag.dataTransferHasPromptMention([])).toBe(false);
  });

  it.each([
    ["src/main.ts", "[main.ts](src/main.ts)"],
    ["src/components/", "[components](src/components)"],
    ["", null],
    ["//", null],
  ])("turns tree path %j into %j", (path, mention) => {
    expect(Drag.promptMentionFromTreePath(path)).toBe(mention);
  });
});
