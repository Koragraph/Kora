// B17 in the composer: a message that is only "who calls X / where is X defined / what breaks if I rename X" is answered from the
// code graph by the daemon with no agent turn (about 100 tokens instead of a 100k-context turn). The answer shows as a card in the
// banner stack with "Send to agent anyway"; the daemon also queues it as a one-shot note for the thread's next agent turn.
// The daemon's parser is the strict one (null = send it to the agent); this file only pre-filters so an ordinary message never
// costs a round trip. Any failure or timeout falls through to a normal send.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NetworkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { fetchPrimaryHost } from "../../hosts/primary/shellAuth";
import type { PromptBannerStackItem } from "./PromptBannerStack";

const QUICK_START = /^\s*(who|what|where|callers\b|find\b|locate\b|go to\b|show me\b|blast\b)/i;
const ASK_TIMEOUT_MS = 8000;

/** Cheap client-side gate: short, one line, not a slash command, starting like one of the fixed phrasings. */
export function looksLikeQuickQuestion(text: string): boolean {
  const t = text.trim();
  return (
    t.length > 0 &&
    t.length <= 160 &&
    !t.includes("\n") &&
    !t.startsWith("/") &&
    QUICK_START.test(t)
  );
}

export interface QuickAnswerCard {
  readonly id: string;
  readonly question: string;
  readonly text: string;
  readonly approxTokens: number;
}

export interface QuickAnswerApi {
  /** True when the question was answered here (the caller clears the composer and sends nothing). */
  readonly tryAnswer: (text: string) => Promise<boolean>;
}

export function useQuickAnswer(args: {
  readonly enabled: boolean;
  readonly threadId: string;
  readonly httpBaseUrl: string | null;
  /** sends the question to the agent as an ordinary message */
  readonly sendToAgent: (text: string) => void;
}): { readonly api: QuickAnswerApi; readonly items: PromptBannerStackItem[] } {
  const { enabled, threadId, httpBaseUrl, sendToAgent } = args;
  const [card, setCard] = useState<QuickAnswerCard | null>(null);
  const inFlight = useRef(false);
  const lastThread = useRef(threadId);
  useEffect(() => {
    if (lastThread.current === threadId) return;
    lastThread.current = threadId;
    setCard(null);
  }, [threadId]);

  const post = useCallback(
    async (body: Record<string, unknown>, signal?: AbortSignal) => {
      if (!httpBaseUrl) return null;
      const res = await fetchPrimaryHost(
        new URL("/api/graph/quick-answer", httpBaseUrl).toString(),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      );
      return res.ok
        ? ((await res.json()) as {
            answer?: (Omit<QuickAnswerCard, "id" | "question"> & { name?: string }) | null;
          })
        : null;
    },
    [httpBaseUrl],
  );

  const tryAnswer = useCallback(
    async (text: string): Promise<boolean> => {
      if (!enabled || !httpBaseUrl || inFlight.current || !looksLikeQuickQuestion(text))
        return false;
      inFlight.current = true;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), ASK_TIMEOUT_MS);
      try {
        const j = await post({ threadId, text: text.trim() }, abort.signal);
        const a = j?.answer;
        if (!a || typeof a.text !== "string" || a.text.length === 0) return false;
        setCard({
          id: `quick-answer:${threadId}:${Date.now()}`,
          question: text.trim(),
          text: a.text,
          approxTokens: typeof a.approxTokens === "number" ? a.approxTokens : 0,
        });
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        inFlight.current = false;
      }
    },
    [enabled, httpBaseUrl, post, threadId],
  );

  const sendAnyway = useCallback(() => {
    if (!card) return;
    const question = card.question;
    setCard(null);
    // The daemon drops the queued answer first, so the agent is not told twice.
    void post({ threadId, discard: true })
      .catch(() => null)
      .then(() => sendToAgent(question));
  }, [card, post, sendToAgent, threadId]);

  const items = useMemo<PromptBannerStackItem[]>(() => {
    if (!card || !enabled) return [];
    return [
      {
        id: card.id,
        variant: "info",
        priority: "notice",
        icon: <NetworkIcon className="size-4" />,
        title: "Answered from the code graph",
        // The banner row is one line (title + a truncated description); the answer itself goes in `children`, which the
        // stack renders as its own block under the row (found 2026-10-14: as a description it was squeezed into the row).
        description: card.question,
        children: (
          <div className="ps-7 pe-2 pb-1 sm:ps-6" data-slot="quick-answer-body">
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5">
              {card.text.replace(/^Graph answer \(no agent turn\) — /, "")}
            </pre>
            <span className="mt-1 block text-muted-foreground">
              No agent turn was used. Your next message to the agent will include this answer.
            </span>
          </div>
        ),
        actions: (
          <Button size="xs" variant="ghost" onClick={sendAnyway}>
            Send to agent anyway
          </Button>
        ),
        dismissLabel: "Dismiss",
        onDismiss: () => setCard(null),
      },
    ];
  }, [card, enabled, sendAnyway]);

  return { api: { tryAnswer }, items };
}
