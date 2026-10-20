interface LineGeometry {
  readonly height: number;
  readonly top: number;
}

interface CenteredFileLineScrollInput {
  readonly renderedLine?: LineGeometry;
  readonly estimatedLine: LineGeometry;
  readonly viewportHeight: number;
  readonly scrollHeight: number;
  readonly viewportTop: number;
  readonly scrollTop: number;
  readonly fileTop: number;
}

export function resolveCenteredFileLineScrollTop(input: CenteredFileLineScrollInput): number {
  const { renderedLine, estimatedLine } = input;
  const lineHeight = renderedLine?.height ?? estimatedLine.height;
  const lineTop = renderedLine
    ? input.scrollTop + renderedLine.top - input.viewportTop
    : input.fileTop + estimatedLine.top;
  const halfSlack = Math.max(0, (input.viewportHeight - lineHeight) / 2);
  const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
  return Math.min(Math.max(0, lineTop - halfSlack), maxTop);
}
