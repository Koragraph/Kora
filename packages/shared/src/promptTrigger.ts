export type PromptTriggerKind = "path" | "slash-command" | "slash-model" | "skill";
export type PromptSlashCommand = "model" | "plan" | "default";

export interface PromptTrigger {
  rangeEnd: number;
  rangeStart: number;
  query: string;
  kind: PromptTriggerKind;
}

const promptFileLinkBasename = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

const escapeMarkdownLinkLabel = (label: string): string =>
  label.replace(/[\\[\]]/g, (char) => (char === "\\" ? "\\\\" : "\\" + char));

const DESTINATION_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\(/g, "%28"],
  [/\)/g, "%29"],
  [/#/g, "%23"],
  [/\?/g, "%3F"],
  [/\\/g, "%5C"],
];

const encodeMarkdownLinkDestination = (path: string): string =>
  DESTINATION_ESCAPES.reduce(
    (encoded, [pattern, token]) => encoded.replace(pattern, token),
    encodeURI(path),
  );

export function serializePromptFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(promptFileLinkBasename(path));
  return "[" + label + "](" + encodeMarkdownLinkDestination(path) + ")";
}
