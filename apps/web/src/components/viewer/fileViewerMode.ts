import { isAbsolutePath } from "~/thread/terminal-links";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export function shouldShowFileExplorer(input: {
  readonly relativePath: string | null;
  readonly attachmentOpen: boolean;
  readonly explorerOpen: boolean;
}): boolean {
  const { relativePath, attachmentOpen, explorerOpen } = input;
  const outsideWorkspace = relativePath ? isAbsolutePath(relativePath) : false;
  if (attachmentOpen || outsideWorkspace) {
    return false;
  }
  return explorerOpen || relativePath === null;
}

export function setMarkdownTaskChecked(source: string, offset: number, isChecked: boolean): string {
  const at = offset;
  const looksLikeTask =
    at >= 0 && source[at] === "[" && /[ xX]/.test(source[at + 1] ?? "") && source[at + 2] === "]";
  if (!looksLikeTask) {
    return source;
  }
  const mark = isChecked ? "x" : " ";
  return source.slice(0, at + 1) + mark + source.slice(at + 2);
}
