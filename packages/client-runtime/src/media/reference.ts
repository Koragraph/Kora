import { isWin32AbsolutePath } from "@kora/shared/projectPaths";

import { safeDecodeURIComponent } from "../markdown/links.ts";

export type MediaReference =
  | { kind: "file"; path: string; relativePath?: string }
  | { kind: "url"; url: string };

interface ParsedPath {
  readonly windows: boolean;
  readonly root: string;
  readonly segments: readonly string[];
}

const parsePath = (value: string): ParsedPath | null => {
  const windows = isWin32AbsolutePath(value) || value.startsWith("//");
  const flat = windows ? value.replaceAll("\\", "/") : value;
  let root: string;
  let rest: string;
  if (windows) {
    const drive = /^([a-zA-Z]:)\//.exec(flat);
    if (drive) {
      root = `${drive[1]!.toLowerCase()}/`;
      rest = flat.slice(drive[0].length);
    } else {
      const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(flat);
      if (!unc) return null;
      root = `//${unc[1]}/${unc[2]}`.toLowerCase();
      rest = flat.slice(unc[0].length);
    }
  } else {
    if (!flat.startsWith("/")) return null;
    root = "/";
    rest = flat.slice(1);
  }

  const segments: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "..") {
      segments.pop();
    } else if (part !== "" && part !== ".") {
      segments.push(part);
    }
  }
  return { windows, root, segments };
};

type FileReference = Extract<MediaReference, { kind: "file" }>;
type UrlReference = Extract<MediaReference, { kind: "url" }>;

export function mediaFileReference(path: string, workspaceRoot?: string | null): FileReference {
  const plain = { kind: "file", path } as const;
  if (!workspaceRoot) return plain;
  const target = parsePath(path);
  const workspace = parsePath(workspaceRoot);
  if (!target || !workspace) return plain;
  if (target.windows !== workspace.windows || target.root !== workspace.root) return plain;
  if (target.segments.length <= workspace.segments.length) return plain;

  const same = (a: string, b: string) =>
    target.windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!workspace.segments.every((segment, i) => same(segment, target.segments[i]!))) return plain;
  return { ...plain, relativePath: target.segments.slice(workspace.segments.length).join("/") };
}

export function mediaUrlReference(url: string): UrlReference | undefined {
  if (!/^(?:https?:)?\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { kind: "url", url };
}

export function mediaReferenceFileName(reference: MediaReference): string | undefined {
  if (reference.kind === "file") {
    const pattern = isWin32AbsolutePath(reference.path) ? /[/\\]/ : /\//;
    return reference.path.split(pattern).pop() || undefined;
  }
  try {
    const last = new URL(
      reference.url.startsWith("//") ? `https:${reference.url}` : reference.url,
    ).pathname
      .split("/")
      .pop();
    return last ? safeDecodeURIComponent(last) || undefined : undefined;
  } catch {
    return undefined;
  }
}
