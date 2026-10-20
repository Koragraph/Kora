export interface FileTreeExpansionModel {
  getItem(path: string): unknown;
}

interface DirectoryHandle {
  collapse(): void;
  expand(): void;
  isDirectory(): boolean;
  isExpanded(): boolean;
}

const DIRECTORY_METHODS = ["isDirectory", "isExpanded", "expand", "collapse"] as const;

function asDirectoryHandle(item: unknown): DirectoryHandle | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (DIRECTORY_METHODS.some((method) => typeof record[method] !== "function")) {
    return null;
  }
  const handle = item as DirectoryHandle;
  return handle.isDirectory() ? handle : null;
}

export function areAllDirectoriesExpanded(
  tree: FileTreeExpansionModel,
  directoryPaths: readonly string[],
): boolean {
  if (directoryPaths.length === 0) {
    return false;
  }
  return directoryPaths.every(
    (path) => asDirectoryHandle(tree.getItem(path))?.isExpanded() === true,
  );
}

export function setAllDirectoriesExpanded(
  tree: FileTreeExpansionModel,
  directoryPaths: readonly string[],
  expanded: boolean,
): void {
  directoryPaths.forEach((path) => {
    const handle = asDirectoryHandle(tree.getItem(path));
    if (handle === null || handle.isExpanded() === expanded) {
      return;
    }
    if (expanded) handle.expand();
    else handle.collapse();
  });
}
