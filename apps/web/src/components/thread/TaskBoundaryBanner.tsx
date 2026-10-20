// B5 in the composer's banner stack: when a long thread is about to start an unrelated task, offer "Compact first" or "Start a
// fresh thread with a brief" (never automatic); after a compaction this chip started, offer "Undo". The decision is pure
// (@kora/shared/taskBoundary) and runs on a store selector that only re-renders the thread when the verdict flips.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Minimize2Icon, Undo2Icon } from "lucide-react";
import {
  compactCommandText,
  compactionSaving,
  taskBoundaryVerdict,
} from "@kora/shared/taskBoundary";
import { Button } from "../ui/button";
import { usePromptDraftStore } from "../../stores/promptDraftStore";
import { fetchPrimaryHost } from "../../hosts/primary/shellAuth";
import type { PromptBannerStackItem } from "./PromptBannerStack";

export interface BoundaryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

const isCompactCmd = (m: BoundaryMessage): boolean =>
  m.role === "user" && /^\/compact(\s|$)/i.test(m.text.trim());
const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function useTaskBoundaryItems(args: {
  readonly enabled: boolean;
  readonly threadId: string;
  /** the composer's draft slot (a thread ref or a draft id) */
  readonly draftTarget: Parameters<
    ReturnType<typeof usePromptDraftStore.getState>["getComposerDraft"]
  >[0];
  readonly messages: ReadonlyArray<BoundaryMessage>;
  readonly usedTokens: number | null;
  readonly busy: boolean;
  readonly compacting: boolean;
  readonly compactUnavailable: boolean;
  readonly httpBaseUrl: string | null;
  /** sends `/compact <keep list>` as a turn */
  readonly compact: (text: string) => Promise<void>;
  /** opens a new thread in the same project and returns where its draft lives, or null */
  readonly openFresh: () => Promise<{
    readonly draftId: Parameters<ReturnType<typeof usePromptDraftStore.getState>["setPrompt"]>[0];
  } | null>;
  readonly notify: (title: string, description?: string) => void;
}): PromptBannerStackItem[] {
  const {
    enabled,
    threadId,
    draftTarget,
    messages,
    usedTokens,
    busy,
    compacting,
    httpBaseUrl,
    notify,
  } = args;
  const userTurns = useMemo(
    () => messages.filter((m) => m.role === "user" && !isCompactCmd(m)).length,
    [messages],
  );
  const recent = useMemo(() => {
    const real = messages.filter((m) => !isCompactCmd(m));
    return real.slice(-6).map((m) => m.text);
  }, [messages]);

  const offer = usePromptDraftStore((s) =>
    enabled && !busy && !compacting
      ? taskBoundaryVerdict({
          draft: s.getComposerDraft(draftTarget)?.prompt ?? "",
          recent,
          usedTokens,
          userTurns,
        }).offer
      : false,
  );

  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [compactedAt, setCompactedAt] = useState<number | null>(null);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [briefing, setBriefing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const lastThread = useRef(threadId);
  useEffect(() => {
    if (lastThread.current === threadId) return;
    lastThread.current = threadId;
    setDismissedAt(null);
    setCompactedAt(null);
    setUndoAvailable(false);
    setBriefing(false);
    setUndoing(false);
  }, [threadId]);

  // After this chip's compaction has finished, ask whether the daemon kept a snapshot to go back to.
  useEffect(() => {
    if (compactedAt === null || compacting || !httpBaseUrl) return;
    let cancelled = false;
    const url = new URL("/api/thread/compact-undo", httpBaseUrl);
    url.searchParams.set("threadId", threadId);
    void fetchPrimaryHost(url.toString())
      .then(async (res) => (res.ok ? ((await res.json()) as { available?: boolean }) : null))
      .then((j) => {
        if (!cancelled) setUndoAvailable(j?.available === true);
      })
      .catch(() => {
        if (!cancelled) setUndoAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [compactedAt, compacting, httpBaseUrl, threadId]);

  const compactNow = useCallback(async () => {
    setCompactedAt(userTurns);
    await args.compact(compactCommandText());
  }, [args, userTurns]);

  const freshWithBrief = useCallback(async () => {
    if (!httpBaseUrl || briefing) return;
    setBriefing(true);
    try {
      const draftText = usePromptDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
      const url = new URL("/api/thread/brief", httpBaseUrl);
      url.searchParams.set("threadId", threadId);
      const res = await fetchPrimaryHost(url.toString(), { method: "POST" });
      const j = res.ok ? ((await res.json()) as { brief?: string }) : null;
      if (!j?.brief) {
        notify("Couldn't write a brief", "Try compacting instead, or start a new chat yourself.");
        return;
      }
      const opened = await args.openFresh();
      if (!opened) {
        notify("Couldn't open a new chat");
        return;
      }
      usePromptDraftStore
        .getState()
        .setPrompt(opened.draftId, draftText ? `${j.brief}\n\n${draftText}` : j.brief);
    } catch {
      notify("Couldn't write a brief", "Try compacting instead, or start a new chat yourself.");
    } finally {
      setBriefing(false);
    }
  }, [args, briefing, draftTarget, httpBaseUrl, notify, threadId]);

  const undo = useCallback(async () => {
    if (!httpBaseUrl || undoing) return;
    setUndoing(true);
    try {
      const url = new URL("/api/thread/compact-undo", httpBaseUrl);
      url.searchParams.set("threadId", threadId);
      const res = await fetchPrimaryHost(url.toString(), { method: "POST" });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string } | null;
      if (j?.ok) {
        notify(
          "Compaction undone",
          "Your next message continues from the conversation as it was before.",
        );
        setCompactedAt(null);
        setUndoAvailable(false);
      } else notify("Couldn't undo the compaction", j?.reason ?? undefined);
    } catch {
      notify("Couldn't undo the compaction");
    } finally {
      setUndoing(false);
    }
  }, [httpBaseUrl, notify, threadId, undoing]);

  return useMemo(() => {
    const items: PromptBannerStackItem[] = [];
    if (!enabled) return items;
    if (offer && dismissedAt !== userTurns) {
      const saved = compactionSaving(usedTokens ?? 0);
      const actions: ReactNode = (
        <>
          <Button
            disabled={args.compactUnavailable}
            size="xs"
            variant="ghost"
            onClick={() => void compactNow()}
          >
            Compact first
          </Button>
          <Button
            disabled={briefing || !httpBaseUrl}
            size="xs"
            variant="ghost"
            onClick={() => void freshWithBrief()}
          >
            {briefing ? "Writing a brief…" : "Fresh chat with a brief"}
          </Button>
        </>
      );
      items.push({
        id: `task-boundary:${threadId}:${userTurns}`,
        variant: "info",
        icon: <Minimize2Icon className="size-4" />,
        title: "This looks like a new task",
        description: `This thread carries ${kTokens(usedTokens ?? 0)} tokens into every message. Compacting saves about ${kTokens(saved)} per message; a fresh thread starts at about 1k.`,
        actions,
        dismissLabel: "Keep going in this chat",
        onDismiss: () => setDismissedAt(userTurns),
      });
    }
    if (compactedAt !== null && compactedAt === userTurns && !compacting && undoAvailable) {
      items.push({
        id: `compact-undo:${threadId}:${compactedAt}`,
        variant: "info",
        icon: <Undo2Icon className="size-4" />,
        title: "Context compacted",
        description:
          "If the summary lost something you need, go back to the conversation as it was.",
        actions: (
          <Button disabled={undoing} size="xs" variant="ghost" onClick={() => void undo()}>
            {undoing ? "Undoing…" : "Undo"}
          </Button>
        ),
        dismissLabel: "Keep the compacted version",
        onDismiss: () => {
          setCompactedAt(null);
          setUndoAvailable(false);
        },
      });
    }
    return items;
  }, [
    args.compactUnavailable,
    briefing,
    compactNow,
    compactedAt,
    compacting,
    dismissedAt,
    enabled,
    freshWithBrief,
    httpBaseUrl,
    offer,
    threadId,
    undo,
    undoAvailable,
    undoing,
    usedTokens,
    userTurns,
  ]);
}
