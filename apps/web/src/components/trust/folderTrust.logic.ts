import type { FolderTrustStatus } from "@kora/contracts";

/** One line: what trusting a folder allows. */
export const TRUST_PROMPT_TITLE = "Trust this folder?";
export const TRUST_PROMPT_DESCRIPTION =
  "Trusting lets agents run this project's own setup — its .claude hooks, MCP servers, plugins and tools. Until then they run in restricted mode.";

/**
 * Show the "Trust this folder?" prompt for this status? Only for a real, trustable, untrusted folder the user has
 * not set aside with "Not now" — never on the assistant lane (Kora's own folders) or while the status is unknown.
 */
export function shouldShowTrustPrompt(input: {
  readonly status: FolderTrustStatus | null;
  readonly isAssistantLane: boolean;
  readonly dismissedRoots: ReadonlySet<string>;
}): boolean {
  const { status } = input;
  if (input.isAssistantLane || status === null) return false;
  if (status.trusted || !status.canTrust) return false;
  return !input.dismissedRoots.has(status.root);
}

/** `/Users/me/code/app` → `~/code/app`. */
export function displayFolder(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** How a trusted folder came to be trusted, for the settings list. */
export function trustSourceLabel(source: FolderTrustStatus["source"]): string {
  switch (source) {
    case "migration":
      return "in use before folder trust";
    case "cli":
      return "kora setup --trust";
    case "kora":
      return "Kora's own folder";
    default:
      return "trusted by you";
  }
}
