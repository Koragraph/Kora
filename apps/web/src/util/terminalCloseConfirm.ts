import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

const SINGLE_NOTE = "This stops the running process and clears its history.";

function closePrompt(names: readonly [string, ...string[]]): string {
  if (names.length === 1) return `Close terminal "${names[0]}"?\n${SINGLE_NOTE}`;
  const quoted = names.map((label) => `"${label}"`).join(", ");
  return [
    `Close ${names.length} terminals?`,
    `This stops their running processes and clears their histories: ${quoted}.`,
  ].join("\n");
}

/**
 * Confirmation for individual terminal close actions: drawer buttons, panel
 * buttons, and closing a terminal surface from
 * the tab strip. Auto-exit cleanup and bulk tab closes skip this path and close
 * directly.
 */
export async function confirmTerminalClose(
  names: readonly [string, ...string[]],
): Promise<boolean> {
  const dialogsHost = readLocalApi();
  if (dialogsHost === null || dialogsHost === undefined) return true;
  const localApi = dialogsHost;
  pendingConfirmations++;
  try {
    return await localApi.dialogs.confirm(closePrompt(names), { variant: "destructive" });
  } catch {
    return false;
  } finally {
    pendingConfirmations--;
  }
}
