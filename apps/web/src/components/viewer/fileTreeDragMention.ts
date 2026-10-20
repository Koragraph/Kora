import {
  promptMentionFromTreePath,
  PROMPT_MENTION_DRAG_TYPE,
} from "~/components/thread/promptMentionDrag";

export interface FileTreeDragStartEvent {
  readonly dataTransfer: { setData(format: string, data: string): void } | null;
  composedPath(): ReadonlyArray<unknown>;
}

export interface FileTreeDragMentionController {
  handleDragEnd(): void;
  handleDragStart(event: FileTreeDragStartEvent): void;
  handleSelectionChange(selectedPaths: ReadonlyArray<string>): void;
  isDragInProgress(): boolean;
}

export interface FileTreeDragMentionHost {
  deselect(treePath: string): void;
}

function rowPathOf(node: unknown): string | null {
  const getAttribute = (node as { getAttribute?: (name: string) => string | null } | null)
    ?.getAttribute;
  if (typeof getAttribute !== "function") return null;
  return getAttribute.call(node, "data-item-path");
}

export function createFileTreeDragMentionController(
  treeHost: FileTreeDragMentionHost,
): FileTreeDragMentionController {
  let dragged: string[] = [];
  let selection: ReadonlyArray<string> = [];

  return {
    isDragInProgress: () => dragged.length > 0,

    handleSelectionChange(selectedPaths) {
      selection = [...selectedPaths];
    },

    handleDragStart(event) {
      if (!event.dataTransfer) return;
      // The tree lives in an open shadow root, so the row is found through the composed path.
      let rowPath: string | null = null;
      for (const node of event.composedPath()) {
        rowPath = rowPathOf(node);
        if (rowPath !== null) break;
      }
      if (rowPath === null) return;

      // Dragging a selected row moves the whole selection, exactly as the tree does.
      const paths = selection.includes(rowPath) ? [...selection] : [rowPath];
      const mentions: string[] = [];
      const draggedPaths: string[] = [];
      for (const path of paths) {
        const mention = promptMentionFromTreePath(path);
        if (mention === null) continue;
        mentions.push(mention);
        draggedPaths.push(path);
      }
      if (mentions.length === 0) return;

      dragged = draggedPaths;
      event.dataTransfer.setData(PROMPT_MENTION_DRAG_TYPE, mentions.join(" "));
    },

    handleDragEnd() {
      if (dragged.length === 0) return;
      const paths = dragged;
      dragged = [];
      for (const path of paths) treeHost.deselect(path);
    },
  };
}
