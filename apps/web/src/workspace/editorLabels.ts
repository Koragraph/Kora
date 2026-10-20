import { EDITORS, type ExternalEditorId } from "@kora/contracts";

import { getLocalFileManagerName } from "~/util/utils";

const editorLabels = new Map<ExternalEditorId, string>(EDITORS.map((ed) => [ed.id, ed.label]));

export function editorLabelForPlatform(editorId: ExternalEditorId, hostOs: string): string {
  if (editorId === "file-manager") {
    return getLocalFileManagerName(hostOs);
  }

  return editorLabels.get(editorId) ?? "Editor";
}

export function openInEditorMenuLabel(editorId: ExternalEditorId | null): string {
  if (editorId === null || editorId === "file-manager") return "Open in editor";
  return `Open in ${editorLabels.get(editorId) ?? "Editor"}`;
}
