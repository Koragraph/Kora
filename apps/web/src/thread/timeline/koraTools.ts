import type { ChatThreadActivity, ToolLifecycleItemType } from "@kora/contracts";

import { fields, text } from "./read";

// ── This daemon's tool activities ─────────────────────────────────────────────
// Kora records a tool call as an activity whose KIND is the tool kind (`command_execution`, `file_change`, ...) with
// `{ itemId, toolName, input }`, followed by a `tool_result` `{ itemId, status, output }`. The work log understands the
// provider-runtime shape (`tool.updated` / `tool.completed` with `itemType`, `toolCallId` and `data.item`), so they
// are translated once here: each call becomes ONE row (the result merges into it by toolCallId) whose expanded body
// holds the command and its output, or the file path and what was written.
const KORA_TOOL_ITEM_TYPE: Readonly<Record<string, ToolLifecycleItemType>> = {
  command_execution: "command_execution",
  file_change: "file_change",
  mcp_tool_call: "mcp_tool_call",
  web_search: "web_search",
  dynamic_tool_call: "dynamic_tool_call",
  file_read: "dynamic_tool_call",
};
const MAX_WRITTEN_PREVIEW_CHARS = 4000;

function koraToolStartItemType(act: ChatThreadActivity): ToolLifecycleItemType | null {
  if (act.tone !== "tool") return null;
  const entryKind = KORA_TOOL_ITEM_TYPE[act.kind];
  if (!entryKind) return null;
  const payload = fields(act.payload);
  return typeof payload?.itemId === "string" && "toolName" in (payload ?? {}) ? entryKind : null;
}

function clipPreview(str: string): string {
  return str.length > MAX_WRITTEN_PREVIEW_CHARS
    ? `${str.slice(0, MAX_WRITTEN_PREVIEW_CHARS)}\n… (${str.length - MAX_WRITTEN_PREVIEW_CHARS} more characters)`
    : str;
}

/** What a file-changing tool wrote: the new file for Write, `-old / +new` for Edit, one hunk per MultiEdit edit. */
function fileChangePreview(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const contentBody = text(input.content);
  if (contentBody) return clipPreview(contentBody);
  const hunk = (oldText: unknown, newText: unknown) => {
    const earlier = typeof oldText === "string" ? oldText : "";
    const after = typeof newText === "string" ? newText : "";
    if (!earlier && !after) return null;
    const lines = (str: string, sign: string) =>
      str.length === 0 ? [] : str.split("\n").map((ln) => `${sign} ${ln}`);
    return [...lines(earlier, "-"), ...lines(after, "+")].join("\n");
  };
  if (Array.isArray(input.edits)) {
    const hunks = input.edits.flatMap((edit) => {
      const editFields = fields(edit);
      const str = editFields ? hunk(editFields.old_string, editFields.new_string) : null;
      return str ? [str] : [];
    });
    return hunks.length > 0 ? clipPreview(hunks.join("\n\n")) : null;
  }
  const single = hunk(input.old_string, input.new_string);
  return single ? clipPreview(single) : null;
}

const koraToolAdaptCache = new WeakMap<ChatThreadActivity, ChatThreadActivity>();

export function adaptKoraToolActivities(
  ranked: ReadonlyArray<ChatThreadActivity>,
): ReadonlyArray<ChatThreadActivity> {
  const started = new Map<
    string,
    { activity: ChatThreadActivity; itemType: ToolLifecycleItemType }
  >();
  for (const act of ranked) {
    const entryKind = koraToolStartItemType(act);
    const itemId = text(fields(act.payload)?.itemId);
    if (entryKind && itemId) started.set(itemId, { activity: act, itemType: entryKind });
  }
  return ranked.flatMap((act) => {
    const cached = koraToolAdaptCache.get(act);
    if (cached) return [cached];
    const payload = fields(act.payload);
    const itemId = text(payload?.itemId);
    let adapted: ChatThreadActivity = act;
    if (itemId && koraToolStartItemType(act)) {
      const begin = started.get(itemId)!;
      const toolInput = fields(payload?.input);
      const filePath =
        text(toolInput?.file_path) ?? text(toolInput?.notebook_path) ?? text(toolInput?.path);
      adapted = {
        ...act,
        kind: "tool.updated",
        payload: {
          itemType: begin.itemType,
          title: act.summary,
          toolCallId: itemId,
          status: "inProgress",
          data: {
            toolName: payload?.toolName,
            item: {
              ...(typeof toolInput?.command === "string" ? { command: toolInput.command } : {}),
              ...(toolInput ? { input: toolInput } : {}),
              ...(begin.itemType === "file_change" && filePath
                ? { changes: [{ path: filePath }] }
                : {}),
            },
          },
          ...(begin.itemType === "file_change" && fileChangePreview(toolInput)
            ? { detail: fileChangePreview(toolInput) }
            : {}),
        },
      };
    } else if (act.kind === "tool_result" && itemId && started.has(itemId)) {
      const begin = started.get(itemId)!;
      const startPayload = fields(begin.activity.payload);
      const toolInput = fields(startPayload?.input);
      const phase = text(payload?.status);
      const failed = phase === "error" || phase === "failed";
      const emitted = text(payload?.output);
      const isCommand = begin.itemType === "command_execution";
      adapted = {
        ...act,
        kind: "tool.completed",
        summary: begin.activity.summary,
        payload: {
          itemType: begin.itemType,
          title: begin.activity.summary,
          toolCallId: itemId,
          status: failed ? "failed" : "completed",
          // A command's output is what the row is for; a file write's "File created successfully" is noise, so the
          // start row's preview of what was written stays. Anything else keeps its output as the body.
          ...(begin.itemType === "file_change" && !failed
            ? {}
            : emitted
              ? { detail: clipPreview(emitted) }
              : {}),
          data: {
            toolName: startPayload?.toolName,
            item: {
              ...(typeof toolInput?.command === "string" ? { command: toolInput.command } : {}),
              ...(isCommand && emitted ? { aggregatedOutput: emitted } : {}),
              ...(fields(payload?.bounded) ? { bounded: fields(payload?.bounded) } : {}),
            },
          },
        },
      };
    }
    // A result whose call has no row of its own (the worker spawn is shown as the worker row): a bare "Tool" line
    // says nothing, so a successful one is dropped and a failed one stays visible with its output.
    if (adapted === act && act.kind === "tool_result") {
      const phase = text(payload?.status);
      if (phase !== "error" && phase !== "failed") return [];
      const emitted = text(payload?.output);
      adapted = {
        ...act,
        kind: "tool.completed",
        summary: "Tool failed",
        tone: "error",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool failed",
          status: "failed",
          ...(emitted ? { detail: clipPreview(emitted) } : {}),
        },
      };
    }
    koraToolAdaptCache.set(act, adapted);
    return [adapted];
  });
}
