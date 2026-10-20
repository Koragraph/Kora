import { isAbsolutePath } from "~/thread/terminal-links";
import { isWin32AbsolutePath } from "@kora/shared/projectPaths";
import type { WorkspaceEntry } from "@kora/contracts";

export interface FileBreadcrumb {
  kind: "project" | "directory" | "file";
  label: string;
  path: string;
}

export interface FileBreadcrumbChild extends WorkspaceEntry {
  label: string;
}

/**
 * Crumbs for a workspace-relative path start at the project. An absolute host
 * path is outside the workspace, so its crumbs start at the filesystem root.
 */
export function fileBreadcrumbs(projectName: string, targetPath: string): FileBreadcrumb[] {
  const outsideWorkspace = isAbsolutePath(targetPath);
  const separator = isWin32AbsolutePath(targetPath) ? "\\" : "/";
  const segments = targetPath.split(/[\\/]/).filter(Boolean);
  let root = "";
  if (targetPath.startsWith("\\\\")) root = "\\\\";
  else if (outsideWorkspace && separator === "/") root = "/";

  const crumbs: FileBreadcrumb[] = outsideWorkspace
    ? []
    : [{ kind: "project", label: projectName, path: "" }];
  segments.forEach((segment, index) => {
    crumbs.push({
      path: root + segments.slice(0, index + 1).join(separator),
      kind: index === segments.length - 1 ? "file" : "directory",
      label: segment,
    });
  });
  return crumbs;
}

export function fileBreadcrumbChildren(
  workspaceEntries: readonly WorkspaceEntry[],
  folderPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const children: FileBreadcrumbChild[] = [];
  const prefix = folderPath ? `${folderPath}/` : "";
  for (const entry of workspaceEntries) {
    const label = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : "";
    if (label && !label.includes("/")) {
      children.push({ ...entry, label });
    }
  }
  return children.toSorted((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    collator ??= new Intl.Collator(undefined, {
      sensitivity: "base",
      numeric: true,
    });
    return collator.compare(left.label, right.label);
  });
}

export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) {
    return null;
  }
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}
