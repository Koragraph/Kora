// @effect-diagnostics nodeBuiltinImport:off -- plain path maths on a blob's folder.
// Outside access (`kora mcp --team`): a blob thread as the compact rows an outside client may read. Pure: the chat engine hands
// over a thread's messages and activities. Tool calls become ONE summary line (never arguments or output), an `attach_output`
// becomes an output by name, an unanswered approval marks the row that raised it. Raw model reasoning, memory cards and
// approval details never leave.
import * as NodePath from "node:path";

import type { ChatThreadActivity, ThreadMessage } from "@kora/contracts";

export interface OutsideRowOut {
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  at: number | null;
  tool?: { name: string; summary: string };
  outputs?: Array<{
    path: string;
    name: string;
    bytes: number | null;
    at: number | null;
    threadId: string | null;
    caption?: string | null;
  }>;
  via?: string;
  needsYou?: string;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}...` : t;
};

const stamp = (iso: string | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** A path relative to the blob's folder when it lies inside it, else just the file name (never an absolute path of the user's disk). */
function relativeOutput(filePath: string, workspace: string): string {
  if (!filePath) return "";
  if (!NodePath.isAbsolute(filePath)) return filePath.replace(/^\.\//, "");
  const rel = NodePath.relative(workspace, filePath);
  return rel && !rel.startsWith("..") && !NodePath.isAbsolute(rel)
    ? rel.split(NodePath.sep).join("/")
    : NodePath.basename(filePath);
}

export function outsideRowsOf(i: {
  messages: readonly ThreadMessage[];
  activities: readonly ChatThreadActivity[];
  workspace: string;
}): OutsideRowOut[] {
  type Timed = { at: number; order: number; row: OutsideRowOut };
  const rows: Timed[] = [];
  let order = 0;

  for (const m of i.messages) {
    if (m.notice || m.role === "system" || m.kind === "note") continue;
    const text = m.text.trim();
    if (!text) continue;
    rows.push({
      at: stamp(m.createdAt) ?? 0,
      order: order++,
      row: {
        role: m.role === "user" ? "user" : "assistant",
        text,
        at: stamp(m.createdAt),
        ...(m.via ? { via: m.via } : {}),
      },
    });
  }

  const open = new Map<string, { title: string; at: number }>();
  for (const a of i.activities) {
    const kind = String(a.kind);
    const payload = (a.payload ?? null) as Record<string, unknown> | null;
    const at = stamp(String(a.createdAt)) ?? 0;
    if (kind === "approval.requested" || kind === "user-input.requested") {
      const id = typeof payload?.requestId === "string" ? payload.requestId : null;
      if (id) open.set(id, { title: clip(String(a.summary), 160), at });
      continue;
    }
    if (kind === "approval.resolved" || kind === "user-input.resolved") {
      const id = typeof payload?.requestId === "string" ? payload.requestId : null;
      if (id) open.delete(id);
      continue;
    }
    if (a.tone !== "tool" || kind === "tool_result") continue;
    const toolName = typeof payload?.toolName === "string" ? payload.toolName : kind;
    if (toolName === "attach_output") {
      const input = (payload?.input ?? null) as Record<string, unknown> | null;
      const file =
        typeof input?.file_path === "string"
          ? input.file_path
          : typeof input?.path === "string"
            ? input.path
            : "";
      const rel = relativeOutput(file, i.workspace);
      if (rel) {
        const caption = String(a.summary).includes(" - ")
          ? (String(a.summary).split(" - ")[0] ?? null)
          : null;
        rows.push({
          at,
          order: order++,
          row: {
            role: "tool",
            text: "",
            at,
            tool: { name: "attach_output", summary: clip(`Shared ${NodePath.basename(rel)}`, 160) },
            outputs: [
              {
                path: rel,
                name: NodePath.basename(rel),
                bytes: null,
                at,
                threadId: null,
                ...(caption ? { caption: clip(caption, 120) } : {}),
              },
            ],
          },
        });
      }
      continue;
    }
    rows.push({
      at,
      order: order++,
      row: {
        role: "tool",
        text: "",
        at,
        tool: { name: clip(toolName, 60), summary: clip(String(a.summary) || toolName, 160) },
      },
    });
  }

  rows.sort((a, b) => a.at - b.at || a.order - b.order);
  const out = rows.map((r) => r.row);
  // an unanswered approval: the row it belongs to carries the question, else a closing note says the thread is waiting
  for (const q of open.values()) {
    let idx = -1;
    for (let k = out.length - 1; k >= 0; k--) {
      const at = out[k]!.at;
      if (at !== null && at <= q.at) {
        idx = k;
        break;
      }
    }
    const row = idx >= 0 ? out[idx] : undefined;
    if (row && row.role === "tool") row.needsYou = q.title;
    else
      out.push({
        role: "note",
        text: `Waiting for you in Kora: ${q.title}`,
        at: q.at,
        needsYou: q.title,
      });
  }
  return out;
}
