import type { SelectedLineRange, LineAnnotation } from "@pierre/diffs";

export interface FileCommentAnnotationEntry {
  id: string;
  text: string;
  kind: "comment" | "draft";
  endLine: number;
  startLine: number;
}

export type FileCommentLineAnnotation = LineAnnotation<FileCommentAnnotationGroup>;

export interface FileCommentAnnotationGroup {
  entries: FileCommentAnnotationEntry[];
}

let commentCounter = 0;

export function nextFileCommentId(): string {
  commentCounter += 1;
  return `file-comment-${Date.now()}-${commentCounter}`;
}

export function normalizeFileCommentRange(range: SelectedLineRange): {
  endLine: number;
  startLine: number;
} {
  const { start, end } = range;
  return {
    endLine: Math.max(start, end),
    startLine: Math.min(start, end),
  };
}

export function formatFileCommentRange(startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `L${startLine}`;
  }
  return `L${startLine} to L${endLine}`;
}

export function remapFileCommentAnnotations(
  lineAnnotations: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentLineAnnotation[] {
  const moveEntry = (entry: FileCommentAnnotationEntry, lineNumber: number) => {
    const span = entry.endLine - entry.startLine;
    return { ...entry, startLine: Math.max(1, lineNumber - span), endLine: lineNumber };
  };
  return lineAnnotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((e) => moveEntry(e, annotation.lineNumber)),
    },
  }));
}
