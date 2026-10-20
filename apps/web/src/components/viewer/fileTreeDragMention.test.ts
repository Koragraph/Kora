import { describe, expect, it, vi } from "vite-plus/test";

import { PROMPT_MENTION_DRAG_TYPE } from "~/components/thread/promptMentionDrag";
import {
  createFileTreeDragMentionController,
  type FileTreeDragStartEvent,
} from "./fileTreeDragMention";

function createFakeDataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: vi.fn((format: string, data: string) => {
      store.set(format, data);
    }),
    get: (format: string) => store.get(format),
  };
}

function createTreeElement(itemPath?: string) {
  return {
    getAttribute(attr: string) {
      return attr === "data-item-path" ? (itemPath ?? null) : null;
    },
  };
}

describe("fileTreeDragMention", () => {
  it("defaults to idle drag state and handles drag end safely when idle", () => {
    const deselectSpy = vi.fn();
    const controller = createFileTreeDragMentionController({ deselect: deselectSpy });

    expect(controller.isDragInProgress()).toBe(false);
    controller.handleDragEnd();
    expect(deselectSpy).not.toHaveBeenCalled();
  });

  it("populates drag transfer with single item when dragged target is unselected", () => {
    const deselect = vi.fn();
    const controller = createFileTreeDragMentionController({ deselect });
    controller.handleSelectionChange(["packages/core/index.ts"]);

    const transfer = createFakeDataTransfer();
    const event: FileTreeDragStartEvent = {
      dataTransfer: transfer,
      composedPath: () => [createTreeElement("packages/cli/bin.ts")],
    };

    controller.handleDragStart(event);

    expect(controller.isDragInProgress()).toBe(true);
    expect(transfer.setData).toHaveBeenCalledWith(
      PROMPT_MENTION_DRAG_TYPE,
      "[bin.ts](packages/cli/bin.ts)",
    );

    controller.handleDragEnd();
    expect(deselect).toHaveBeenCalledTimes(1);
    expect(deselect).toHaveBeenCalledWith("packages/cli/bin.ts");
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("drags entire active selection when dragged target is among selected items", () => {
    const deselect = vi.fn();
    const controller = createFileTreeDragMentionController({ deselect });
    const activePaths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    controller.handleSelectionChange(activePaths);

    const transfer = createFakeDataTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [createTreeElement("src/b.ts")],
    });

    expect(transfer.get(PROMPT_MENTION_DRAG_TYPE)).toBe(
      "[a.ts](src/a.ts) [b.ts](src/b.ts) [c.ts](src/c.ts)",
    );
    expect(controller.isDragInProgress()).toBe(true);

    controller.handleDragEnd();
    expect(deselect).toHaveBeenCalledTimes(3);
    expect(deselect).toHaveBeenNthCalledWith(1, "src/a.ts");
    expect(deselect).toHaveBeenNthCalledWith(2, "src/b.ts");
    expect(deselect).toHaveBeenNthCalledWith(3, "src/c.ts");
    expect(controller.isDragInProgress()).toBe(false);

    // Subsequent drag-end call must be a no-op
    controller.handleDragEnd();
    expect(deselect).toHaveBeenCalledTimes(3);
  });

  it("ignores drag start when composed path does not contain a tree row", () => {
    const controller = createFileTreeDragMentionController({ deselect: vi.fn() });
    const transfer = createFakeDataTransfer();

    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [{}, { getAttribute: () => null }],
    });

    expect(transfer.setData).not.toHaveBeenCalled();
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("handles null dataTransfer gracefully", () => {
    const controller = createFileTreeDragMentionController({ deselect: vi.fn() });
    controller.handleDragStart({
      dataTransfer: null,
      composedPath: () => [createTreeElement("foo.ts")],
    });
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("formats directory tree rows stripping trailing slashes", () => {
    const controller = createFileTreeDragMentionController({ deselect: vi.fn() });
    const transfer = createFakeDataTransfer();

    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [createTreeElement("components/ui/")],
    });

    expect(transfer.get(PROMPT_MENTION_DRAG_TYPE)).toBe("[ui](components/ui)");
  });

  it("finds row node nested within shadow root event path", () => {
    const controller = createFileTreeDragMentionController({ deselect: vi.fn() });
    const transfer = createFakeDataTransfer();

    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [
        { className: "icon" },
        createTreeElement("lib/utils.ts"),
        { className: "row" },
      ],
    });

    expect(transfer.get(PROMPT_MENTION_DRAG_TYPE)).toBe("[utils.ts](lib/utils.ts)");
    expect(controller.isDragInProgress()).toBe(true);
  });
});
