import { blobRowClassName, bubbleShapeClassName } from "./skinClasses";
import { BUBBLE_GROUP_GAP_MS, deriveBubbleGroups, sameBubbleGroups } from "./grouping";
import { BlobAssistantFrame, BlobBubble, BlobMessageMeta, BlobTypingRow } from "./BlobBubbles";
import type { BlobSkin } from "../chat/blobSkin";
import type { TranscriptRowEntry } from "../../thread/ThreadTranscript.logic";

import type { ChatMessage } from "../../../types";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemId } from "@kora/contracts";

const skin: BlobSkin = {
  chief: false,
  outfit: { head: "beanie" },
  title: "Researcher",
  name: "Popo",
  blobId: "blob_popo",
};

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 9, 10, 0, 0) + seconds * 1000).toISOString();

function messageRow(
  id: string,
  role: "user" | "assistant",
  seconds: number,
  streaming = false,
): TranscriptRowEntry {
  const message = {
    streaming,
    updatedAt: at(seconds),
    createdAt: at(seconds),
    turnId: null,
    text: id,
    role,
    id: ItemId.make(id),
  } as ChatMessage;
  return {
    assistantCopyStreaming: false,
    showAssistantCopyButton: false,
    showAssistantMeta: false,
    durationStart: at(seconds),
    message,
    createdAt: at(seconds),
    id,
    kind: "message",
  };
}
const rowOf = (
  kind: "work-toggle" | "blob-card" | "thinking" | "assistant-meta",
  id: string,
): TranscriptRowEntry => {
  switch (kind) {
    case "thinking":
      return { kind, id, createdAt: at(0) };
    case "blob-card":
      return {
        label: id,
        card: { cardId: id, version: 1, payload: {} },
        createdAt: at(0),
        id,
        kind,
      };
    default:
      throw new Error("unused");
  }
};

describe("bubbles render only with a skin", () => {
  const child = <p>Hello there</p>;

  it("offers the show-steps toggle only when the reply has a turn", () => {
    const withTurn = renderToStaticMarkup(
      <BlobMessageMeta
        skin={skin}
        resting
        time={null}
        copy={null}
        onToggleSteps={() => undefined}
      />,
    );
    expect(withTurn).toContain("Show what Popo did");
    const without = renderToStaticMarkup(
      <BlobMessageMeta skin={skin} resting={false} time={null} copy={null} onToggleSteps={null} />,
    );
    expect(without).not.toContain("Show what Popo did");
  });

  it("shows the thinking avatar in the typing row", () => {
    const html = renderToStaticMarkup(<BlobTypingRow skin={skin} />);
    expect(html).toContain('data-visual-state="thinking"');
    expect(html).toContain("Popo is thinking");
  });

  it("wraps the reply in a bubble", () => {
    const html = renderToStaticMarkup(
      <BlobBubble skin={skin} position={undefined}>
        {child}
      </BlobBubble>,
    );
    expect(html).toContain('data-blob-bubble="assistant"');
    expect(html).toContain("Hello there");
  });

  it("draws the avatar once, in the first reply of a burst, and a spacer after", () => {
    const first = renderToStaticMarkup(
      <BlobAssistantFrame
        skin={skin}
        position={{ role: "assistant", first: true, last: false, streaming: false }}
      >
        {child}
      </BlobAssistantFrame>,
    );
    expect(first).toContain('data-blob-gutter="avatar"');
    expect(first).toContain("<svg");
    const next = renderToStaticMarkup(
      <BlobAssistantFrame
        skin={skin}
        position={{ role: "assistant", first: false, last: true, streaming: false }}
      >
        {child}
      </BlobAssistantFrame>,
    );
    expect(next).toContain('data-blob-gutter="spacer"');
    expect(next).not.toContain("<svg");
  });

  it("passes children straight through on Chat and Code", () => {
    expect(
      renderToStaticMarkup(
        <BlobAssistantFrame skin={null} position={undefined}>
          {child}
        </BlobAssistantFrame>,
      ),
    ).toBe("<p>Hello there</p>");
    expect(
      renderToStaticMarkup(
        <BlobBubble skin={null} position={undefined}>
          {child}
        </BlobBubble>,
      ),
    ).toBe("<p>Hello there</p>");
  });
});

describe("skin classes", () => {
  it("joins bubble corners after the first of a burst", () => {
    expect(
      bubbleShapeClassName("left", {
        streaming: false,
        last: false,
        first: true,
        role: "assistant",
      }),
    ).toContain("rounded-bl-");
    expect(
      bubbleShapeClassName("left", {
        streaming: false,
        last: true,
        first: false,
        role: "assistant",
      }),
    ).toContain("rounded-l-");
    expect(bubbleShapeClassName("right", undefined)).toContain("rounded-br-");
  });

  it("tightens spacing inside a burst and indents tool rows and cards under the bubbles", () => {
    const groups = deriveBubbleGroups([
      messageRow("a1", "assistant", 0),
      messageRow("a2", "assistant", 2),
    ]);
    expect(blobRowClassName(messageRow("a1", "assistant", 0), skin, groups)).toBe("pb-0.5");
    expect(blobRowClassName(messageRow("a2", "assistant", 2), skin, groups)).toBe("pb-3");
    expect(blobRowClassName(rowOf("blob-card", "c"), skin, groups)).toContain("pl-[2.375rem]");
  });
  it("adds nothing without a skin", () => {
    const row = messageRow("a1", "assistant", 0);
    expect(blobRowClassName(row, null, null)).toBeUndefined();
    expect(blobRowClassName(rowOf("blob-card", "c"), null, null)).toBeUndefined();
  });
});

describe("deriveBubbleGroups", () => {
  it("reports streaming for the whole burst and compares equal while only text grows", () => {
    const a = deriveBubbleGroups([messageRow("a1", "assistant", 0, true)]);
    expect(a.get("a1")?.streaming).toBe(true);
    const b = deriveBubbleGroups([messageRow("a1", "assistant", 0, true)]);
    expect(sameBubbleGroups(a, b)).toBe(true);
    const done = deriveBubbleGroups([messageRow("a1", "assistant", 0, false)]);
    expect(sameBubbleGroups(a, done)).toBe(false);
  });

  it("starts a new burst after a long pause", () => {
    const groups = deriveBubbleGroups([
      messageRow("a1", "assistant", 0),
      messageRow("a2", "assistant", BUBBLE_GROUP_GAP_MS / 1000 + 5),
    ]);
    expect(groups.get("a1")?.last).toBe(true);
    expect(groups.get("a2")?.first).toBe(true);
  });

  it("lets tool rows sit between bubbles of one burst, but not a card", () => {
    const tools = deriveBubbleGroups([
      messageRow("a1", "assistant", 0),
      rowOf("thinking", "t"),
      messageRow("a2", "assistant", 4),
    ]);
    expect(tools.get("a1")?.last).toBe(false);
    expect(tools.get("a2")?.first).toBe(false);
    const carded = deriveBubbleGroups([
      messageRow("a1", "assistant", 0),
      rowOf("blob-card", "c"),
      messageRow("a2", "assistant", 4),
    ]);
    expect(carded.get("a1")?.last).toBe(true);
    expect(carded.get("a2")?.first).toBe(true);
  });
  it("joins consecutive messages from one author and marks first / last", () => {
    const groups = deriveBubbleGroups([
      messageRow("u1", "user", 0),
      messageRow("a1", "assistant", 5),
      messageRow("a2", "assistant", 9),
      messageRow("a3", "assistant", 12),
      messageRow("u2", "user", 40),
    ]);
    expect(groups.get("u1")).toMatchObject({ first: true, last: true, role: "user" });
    expect(groups.get("a1")).toMatchObject({ first: true, last: false });
    expect(groups.get("a2")).toMatchObject({ first: false, last: false });
    expect(groups.get("a3")).toMatchObject({ first: false, last: true });
    expect(groups.get("u2")).toMatchObject({ first: true, last: true });
  });
});
