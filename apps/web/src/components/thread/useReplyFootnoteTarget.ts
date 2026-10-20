import type { TranscriptRowEntry } from "./ThreadTranscript.logic";
import type { ReplyFootnoteRequest, ReplyFootnoteTarget } from "./ReplyFootnoteSource";
import { toastManager } from "../ui/toast";
import type { TranscriptItem } from "../../thread/timeline";
import type { TurnId } from "@kora/contracts";
import { type RefObject, useEffect, useState, useRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";

export interface FootnoteHistoryPage {
  readonly onLoadEarlier: () => void;
  readonly cursor?: string | null;
  readonly loading: boolean;
}

const MAX_HISTORY_PAGES = 20;

type Navigation = {
  target: ReplyFootnoteTarget;
  requestedPages: Set<string>;
  done: boolean;
};

const LOAD_FAILED_TITLE = "Could not load the cited response";
const LOAD_FAILED_HINT =
  "Load earlier turns, then click the citation to try again. Your saved quote is unchanged.";

const CANCEL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function useReplyFootnoteTarget(args: {
  listRef: RefObject<LegendListRef | null>;
  rows: ReadonlyArray<TranscriptRowEntry>;
  loadEarlier: FootnoteHistoryPage | null;
  onExpandTurn: (turnId: TurnId) => void;
  entries: ReadonlyArray<TranscriptItem>;
  request: ReplyFootnoteRequest | null;
  onManualNavigation: () => void;
  viewport: HTMLElement | null;
  historyLoading: boolean;
}): {
  target: ReplyFootnoteTarget | null;
  positioning: boolean;
  onListLoad: () => void;
  alwaysRender: { keys: string[] } | undefined;
} {
  const {
    onManualNavigation,
    historyLoading,
    onExpandTurn,
    loadEarlier,
    viewport,
    request,
    listRef,
    entries,
    rows,
  } = args;

  const [ready, setReady] = useState<ReplyFootnoteTarget | null>(null);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const navigationRef = useRef<Navigation | null>(null);

  // Latest callbacks without re-running the navigation effect on every parent render.
  const manualRef = useRef(onManualNavigation);
  manualRef.current = onManualNavigation;

  useEffect(() => {
    const previous = navigationRef.current;
    if (previous && previous.target.key !== request?.key) {
      const activation = previous.target.activationRef.current;
      activation.dismissed = true;
      activation.cancelScroll?.();
    }

    if (!request) {
      setFinishedKey(null);
      setReady(null);
      navigationRef.current = null;
      return;
    }

    let navigation = navigationRef.current;
    if (!navigation || navigation.target.key !== request.key) {
      const created: Navigation = {
        requestedPages: new Set(),
        done: false,
        target: {
          ...request,
          activationRef: { current: { scrolled: false, dismissed: false } },
          onComplete: () => {
            if (navigationRef.current !== created) return;
            created.done = true;
            // ThreadView's thread-open effect may run after the first opt-out of auto-follow.
            manualRef.current();
            setFinishedKey(request.key);
          },
        },
      };
      navigationRef.current = created;
      navigation = created;
      setReady(null);
      manualRef.current();
    }

    if (!viewport || historyLoading) return;
    if (navigation.done || navigation.target.activationRef.current.dismissed) {
      return;
    }

    const fail = (title: string, description: string) => {
      navigation.done = true;
      setFinishedKey(request.key);
      toastManager.add({ type: "warning", title, description });
    };

    const source = entries.find(
      (entry) => entry.kind === "message" && entry.id === request.citation.messageId,
    );
    if (!source) {
      if (!loadEarlier) {
        return fail(
          "The cited response is unavailable",
          "It may have been removed. The selected text is still saved in your citation.",
        );
      }
      if (loadEarlier.loading) return;
      const cursor = loadEarlier.cursor ?? entries[0]?.id ?? "first";
      if (
        navigation.requestedPages.has(cursor) ||
        navigation.requestedPages.size >= MAX_HISTORY_PAGES
      ) {
        return fail(LOAD_FAILED_TITLE, LOAD_FAILED_HINT);
      }
      const { requestedPages } = navigation;
      requestedPages.add(cursor);
      loadEarlier.onLoadEarlier();
      return;
    }

    if (source.kind !== "message" || source.message.role !== "assistant") {
      return fail(
        "The citation does not refer to an assistant response",
        "The selected text is still saved in your citation.",
      );
    }

    const row = rows.find(
      (candidate) => candidate.kind === "message" && candidate.id === source.id,
    );
    if (!row) {
      // Folded away: unfold its turn and wait for the next pass.
      if (source.message.turnId) onExpandTurn(source.message.turnId);
      return;
    }
    if (listLoaded && listRef.current) {
      setReady(navigation.target);
    }
  }, [
    viewport,
    rows,
    request,
    onExpandTurn,
    loadEarlier,
    listRef,
    listLoaded,
    historyLoading,
    entries,
  ]);

  // Any user navigation takes over from the programmatic jump.
  useEffect(() => {
    if (!request || !viewport) return;
    const dismiss = () => {
      const navigation = navigationRef.current;
      if (!navigation || navigation.target.key !== request.key) {
        return;
      }
      const activation = navigation.target.activationRef.current;
      if (activation.dismissed || activation.scrolled || navigation.done) return;
      activation.dismissed = true;
      activation.cancelScroll?.();
      manualRef.current();
      setReady(null);
      setFinishedKey(request.key);
      navigation.done = true;
    };
    const onCancelKey = (event: KeyboardEvent) => {
      const inside = event.target instanceof Node && viewport.contains(event.target);
      if (inside && CANCEL_KEYS.has(event.key)) dismiss();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) dismiss();
    };
    document.addEventListener("keydown", onCancelKey);
    document.addEventListener("pointerdown", dismiss, true);
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchmove", dismiss, { passive: true });
    return () => {
      document.removeEventListener("keydown", onCancelKey);
      document.removeEventListener("pointerdown", dismiss, true);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchmove", dismiss);
    };
  }, [request, viewport]);

  const target = ready && request && ready.key === request.key ? ready : null;
  const positioning = request !== null && finishedKey !== request.key;
  return {
    target,
    positioning,
    onListLoad: () => setListLoaded(true),
    alwaysRender:
      positioning && target
        ? {
            keys: rows
              .filter((row) => row.kind === "message" && row.id === target.citation.messageId)
              .map((row) => row.id),
          }
        : undefined,
  };
}
