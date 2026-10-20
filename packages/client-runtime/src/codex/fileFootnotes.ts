export interface CodexFileFootnoteLink {
  readonly lineRangeStart?: number;
  readonly label: string;
  readonly href: string;
  readonly path: string;
}

export type CodexFileFootnoteAttributes = Readonly<Record<string, string | null | undefined>>;

function positiveInteger(value: string | null | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return parsed > 0 && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function footnoteLabel(path: string): string {
  const unixStyle = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = unixStyle.slice(unixStyle.lastIndexOf("/") + 1);
  return base || unixStyle || "File";
}

function markdownDestinationPath(path: string): string {
  const escapes: ReadonlyArray<readonly [string, string]> = [
    ["%", "%25"],
    ["#", "%23"],
    ["?", "%3F"],
  ];
  return escapes.reduce((encoded, [raw, escaped]) => encoded.replaceAll(raw, escaped), path);
}

export function resolveCodexFileFootnoteLink(
  attributes: CodexFileFootnoteAttributes | null | undefined,
): CodexFileFootnoteLink | null {
  const path = attributes?.path?.trim();
  if (!path) return null;

  const destination = markdownDestinationPath(path);
  const lineRangeStart = positiveInteger(attributes?.line_range_start);
  const anchor = lineRangeStart === undefined ? "" : "#L" + lineRangeStart;
  return {
    path,
    href: destination + anchor,
    label: footnoteLabel(path),
    ...(lineRangeStart === undefined ? {} : { lineRangeStart }),
  };
}

const markdownLabel = (value: string): string => value.replace(/[\\[\]*_`<&]/g, "\\$&");

const DESTINATION_ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ["<", "%3C"],
  [">", "%3E"],
  ["\r", "%0D"],
  ["\n", "%0A"],
];

const markdownDestination = (value: string): string =>
  DESTINATION_ESCAPES.reduce((escaped, [raw, encoded]) => escaped.replaceAll(raw, encoded), value);

export function codexFileFootnoteMarkdown(citation: CodexFileFootnoteLink): string {
  return `[${markdownLabel(citation.label)}](<${markdownDestination(citation.href)}>)`;
}
