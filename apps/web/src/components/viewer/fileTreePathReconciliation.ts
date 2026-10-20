import type { FileTreeBatchOperation } from "@pierre/trees";

const depthOf = (path: string): number => path.split("/").filter(Boolean).length;
const shallowFirst = (left: string, right: string): number => depthOf(left) - depthOf(right);

export function buildFileTreePathUpdates(
  oldPaths: readonly string[],
  newPaths: readonly string[],
): FileTreeBatchOperation[] {
  const stillThere = new Set(newPaths);
  const wasThere = new Set(oldPaths);
  const removedDirectoryRoots: string[] = [];
  const updates: FileTreeBatchOperation[] = [];

  for (const path of oldPaths.filter((p) => !stillThere.has(p)).toSorted(shallowFirst)) {
    if (removedDirectoryRoots.some((directory) => path.startsWith(directory))) {
      continue;
    }
    const isDirectory = path.endsWith("/");
    updates.push({ type: "remove", path, ...(isDirectory ? { recursive: true } : {}) });
    if (isDirectory) {
      removedDirectoryRoots.push(path);
    }
  }

  for (const path of newPaths.filter((p) => !wasThere.has(p)).toSorted(shallowFirst)) {
    updates.push({ path, type: "add" });
  }

  return updates;
}
