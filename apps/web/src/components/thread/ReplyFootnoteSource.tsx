// ---------------------------------------------------------------------------
// Constants

import {
  type ReplyFootnoteSourceAnchor,
  resolveReplyFootnoteRange,
} from "~/util/assistantTextSelection";
import { toastManager } from "../ui/toast";
import type { HostThreadRef, ReplyFootnote, ItemId } from "@kora/contracts";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";

const NAVIGATION_HIGHLIGHT = "kora-assistant-citation";
const COMMENT_HIGHLIGHT = "kora-assistant-citation-comment";
const PULSE_ANIMATION_ID = "kora-assistant-citation-pulse";
const OPACITY_VAR = "--assistant-citation-highlight-opacity";
const PEAK_OPACITY = 0.45;

const PULSE_MS = 650;
const HOLD_MS = 1575;
const FADE_MS = 450;
const TOTAL_MS = 1.5 * PULSE_MS + HOLD_MS + FADE_MS;

const SCROLL_MARGIN_MAX_PX = 120;
const SCROLL_TOLERANCE_PX = 1;

// ---------------------------------------------------------------------------
// Types

export interface ReplyFootnoteRequest {
  citation: ReplyFootnote;
  key: string;
}

type Activation = {
  pulse?: { startedAt: number; reducedMotion: boolean };
  cancelScroll?: () => void;
  dismissed: boolean;
  scrolled: boolean;
};

export interface ReplyFootnoteTarget extends ReplyFootnoteRequest {
  activationRef: RefObject<Activation>;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// CSS Custom Highlight API access (absent in some engines and in tests)

type HighlightLike = Set<Range>;
type HighlightRegistry = Map<string, HighlightLike>;

function highlightSupport(): {
  registry: HighlightRegistry;
  create: (range: Range) => HighlightLike;
} | null {
  const ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => HighlightLike })
    .Highlight;
  const registry = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS
    ?.highlights;
  if (typeof ctor !== "function" || !registry) return null;
  return { registry, create: (range) => new ctor(range) };
}

function rangeInside(range: Range, container: Node): boolean {
  return container.contains(range.startContainer) && container.contains(range.endContainer);
}

// ---------------------------------------------------------------------------
// Comment editor: keep the quoted text marked without touching the selection

export function observeReplyFootnoteCommentSource(args: {
  anchor: ReplyFootnoteSourceAnchor;
  citation: ReplyFootnote;
  onUnavailable: () => void;
}): () => void {
  const { source, range, viewport } = args.anchor;
  const noop = () => {};

  const stillAttached = () => source.isConnected && viewport.contains(source);
  if (!stillAttached()) {
    args.onUnavailable();
    return noop;
  }

  const support = highlightSupport();
  let shared: HighlightLike | null = null;
  if (support) {
    shared = support.registry.get(COMMENT_HIGHLIGHT) ?? null;
    if (!shared) {
      shared = support.create(range);
      support.registry.set(COMMENT_HIGHLIGHT, shared);
    } else {
      shared.add(range);
    }
  }

  let done = false;
  let observer: MutationObserver | null = null;

  const dispose = () => {
    if (done) return;
    done = true;
    observer?.disconnect();
    if (support && shared) {
      shared.delete(range);
      if (shared.size === 0 && support.registry.get(COMMENT_HIGHLIGHT) === shared) {
        support.registry.delete(COMMENT_HIGHLIGHT);
      }
    }
  };

  const unavailable = () => {
    if (done) return;
    dispose();
    args.onUnavailable();
  };

  const validate = (records: readonly MutationRecord[]) => {
    if (done) return;
    if (!stillAttached()) return unavailable();
    const touched = records.some((record) => source.contains(record.target));
    if (!touched && !range.collapsed && rangeInside(range, source)) return;

    const resolved = resolveReplyFootnoteRange(source, args.citation);
    if (!resolved) return unavailable();
    // Repair the live Range in place: the popup anchor and the highlight both hold it.
    range.setStart(resolved.startContainer, resolved.startOffset);
    range.setEnd(resolved.endContainer, resolved.endOffset);
  };

  observer = new MutationObserver(validate);
  observer.observe(viewport, { childList: true, subtree: true, characterData: true });
  return dispose;
}

// ---------------------------------------------------------------------------
// Navigation: scroll the cited row into view, then pulse the quote

type ListState = ReturnType<LegendListRef["getState"]>;

export function observeReplyFootnoteSource(args: {
  root: HTMLElement;
  itemKey: string;
  request: ReplyFootnoteTarget;
  list: LegendListRef;
}): (() => void) | undefined {
  const { root, itemKey, request, list } = args;
  const activation = request.activationRef.current;
  const scrollNode = list.getScrollableNode();
  if (activation.dismissed || !(scrollNode instanceof HTMLElement)) return undefined;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const doc = root.ownerDocument;

  let disposed = false;
  let frame: number | null = null;
  let scrolling = false;
  let animation: Animation | null = null;

  // Highlight bookkeeping: what we registered / selected, so we only undo our own work.
  let ownedRange: Range | null = null;
  let ownedHighlight: HighlightLike | null = null;
  let selectionApplied = false;
  let selectionWasOurs = false;

  const ownsSelection = (selection: Selection | null): boolean => {
    if (!selection || !ownedRange || selection.rangeCount !== 1) return false;
    const current = selection.getRangeAt(0);
    return (
      current === ownedRange ||
      (current.startContainer === ownedRange.startContainer &&
        current.startOffset === ownedRange.startOffset &&
        current.endContainer === ownedRange.endContainer &&
        current.endOffset === ownedRange.endOffset)
    );
  };

  const clearHighlight = () => {
    const support = highlightSupport();
    if (support && ownedHighlight) {
      if (support.registry.get(NAVIGATION_HIGHLIGHT) === ownedHighlight) {
        support.registry.delete(NAVIGATION_HIGHLIGHT);
      }
    }
    ownedHighlight = null;
    if (selectionApplied) {
      const selection = doc.getSelection();
      if (selection && ownsSelection(selection) && ownedRange) {
        selection.removeRange(ownedRange);
      }
      selectionWasOurs = true;
      selectionApplied = false;
    }
    ownedRange = null;
    delete root.dataset.citationHighlighted;
  };

  const stopPulse = () => {
    const running = animation;
    animation = null;
    running?.cancel();
  };

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelScroll();
    if (activation.cancelScroll === cancelScroll) delete activation.cancelScroll;
    stopPulse();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    mutations?.disconnect();
    resizes?.disconnect();
    for (const off of listeners) off();
    clearHighlight();
  };

  const finish = () => {
    activation.dismissed = true;
    dispose();
  };

  // A human gesture or minimap action wins over a pending programmatic scroll. Legend may defer the
  // call, so the offset is read when it executes, not now.
  function cancelScroll() {
    if (!scrolling) return;
    scrolling = false;
    void list.scrollToOffset({
      animated: false,
      get offset() {
        return scrollNode.scrollTop;
      },
    });
  }
  activation.cancelScroll = cancelScroll;

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      pass();
    });
  };

  const rangeIsLive = (range: Range | null): range is Range =>
    range !== null && !range.collapsed && rangeInside(range, root);

  const startPulse = (startedAt: number) => {
    const keyframes: Keyframe[] = reducedMotion
      ? [
          { [OPACITY_VAR]: PEAK_OPACITY, offset: 0 },
          { [OPACITY_VAR]: PEAK_OPACITY, offset: (TOTAL_MS - FADE_MS) / TOTAL_MS },
          { [OPACITY_VAR]: 0, offset: 1 },
        ]
      : [
          { [OPACITY_VAR]: 0, offset: 0 },
          { [OPACITY_VAR]: PEAK_OPACITY, offset: PULSE_MS / 2 / TOTAL_MS },
          { [OPACITY_VAR]: 0, offset: PULSE_MS / TOTAL_MS },
          { [OPACITY_VAR]: PEAK_OPACITY, offset: (1.5 * PULSE_MS) / TOTAL_MS },
          { [OPACITY_VAR]: PEAK_OPACITY, offset: (TOTAL_MS - FADE_MS) / TOTAL_MS },
          { [OPACITY_VAR]: 0, offset: 1 },
        ];
    const created = root.animate(keyframes, { duration: TOTAL_MS, easing: "ease-in-out" });
    created.id = PULSE_ANIMATION_ID;
    created.currentTime = performance.now() - startedAt;
    animation = created;
    created.finished.then(
      () => {
        if (!disposed && animation === created) finish();
      },
      () => {},
    );
  };

  const applyHighlight = (range: Range): boolean => {
    const support = highlightSupport();
    if (support) {
      const highlight = support.create(range);
      support.registry.set(NAVIGATION_HIGHLIGHT, highlight);
      ownedHighlight = highlight;
      ownedRange = range;
      root.dataset.citationHighlighted = "true";
      return true;
    }
    // No Highlight API: fall back to a real selection, but never over the user's own.
    const selection = doc.getSelection();
    if (!selection) return true;
    const fresh = activation.pulse === undefined || selectionWasOurs;
    if (!fresh && !ownsSelection(selection)) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    ownedRange = range;
    selectionApplied = true;
    root.dataset.citationHighlighted = "true";
    return true;
  };

  const warn = (title: string, description: string) =>
    toastManager.add({ type: "warning", title, description });

  function pass() {
    if (disposed) return;
    if (activation.dismissed || !root.isConnected || !scrollNode.contains(root)) {
      clearHighlight();
      dispose();
      return;
    }
    if (activation.pulse && performance.now() - activation.pulse.startedAt >= TOTAL_MS) {
      finish();
      return;
    }

    const state: ListState = list.getState();
    const index = state.indexByKey(itemKey);
    if (index === undefined) return;
    const size = state.sizeAtIndex(index);
    if (!(typeof size === "number" && size > 0)) return;

    // Native-selection fallback: a selection that is no longer ours ends the pulse untouched.
    if (selectionApplied && !ownsSelection(doc.getSelection())) {
      selectionApplied = false;
      ownedRange = null;
      finish();
      return;
    }

    const range = rangeIsLive(ownedRange)
      ? ownedRange
      : resolveReplyFootnoteRange(root, request.citation);
    const rect = range ? range.getBoundingClientRect() : root.getBoundingClientRect();
    if (rect.height <= 0 || scrollNode.clientHeight <= 0) {
      clearHighlight();
      return;
    }

    if (!activation.scrolled) {
      if (scrolling) return;
      const viewportRect = scrollNode.getBoundingClientRect();
      const viewportHeight = scrollNode.clientHeight;
      const margin = Math.min(SCROLL_MARGIN_MAX_PX, viewportHeight / 3);
      const maxOffset = Math.max(0, scrollNode.scrollHeight - viewportHeight);
      const wanted = Math.min(
        maxOffset,
        Math.max(0, state.scroll + (rect.top - viewportRect.top) - margin),
      );
      if (Math.abs(wanted - state.scroll) > SCROLL_TOLERANCE_PX) {
        scrolling = true;
        list.scrollToOffset({ offset: wanted, animated: !reducedMotion }).then(
          () => {
            scrolling = false;
            schedule();
          },
          () => {
            scrolling = false;
            activation.dismissed = true;
            clearHighlight();
            request.onComplete();
            warn("Could not open the cited response", "Click the citation to try again.");
            dispose();
          },
        );
        return;
      }
      const outside =
        rect.bottom < viewportRect.top || rect.top > viewportRect.top + viewportHeight;
      if (outside) return; // geometry is still shifting
      request.onComplete();
      activation.scrolled = true;
      if (!range) {
        warn(
          "The quoted text has changed",
          "Showing the source response. The saved quote is unchanged.",
        );
      }
    }

    if (!range) {
      finish();
      return;
    }

    if (ownedRange !== range) {
      clearHighlight();
      if (!applyHighlight(range)) {
        finish();
        return;
      }
    }

    if (!animation) {
      activation.pulse ??= { startedAt: performance.now(), reducedMotion };
      startPulse(activation.pulse.startedAt);
    }
  }

  // ---- what makes us look again ----
  const mutations = new MutationObserver((records) => {
    if (disposed) return;
    let relevant = false;
    if (ownedRange && !rangeIsLive(ownedRange)) {
      const hadSelection = selectionApplied;
      clearHighlight();
      if (hadSelection) selectionWasOurs = true;
      relevant = true;
    }
    for (const record of records) {
      const target = record.target as Node;
      if (root.contains(target)) relevant = true;
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.contains(root)) relevant = true;
      }
    }
    if (relevant) schedule();
  });
  mutations.observe(scrollNode, { childList: true, characterData: true, subtree: true });

  const resizes = new ResizeObserver(schedule);
  resizes.observe(root);
  resizes.observe(scrollNode);

  const listState = list.getState();
  const listeners: Array<() => void> = [
    listState.listenToPosition(itemKey, schedule),
    listState.listen("totalSize", schedule),
    listState.listen("headerSize", schedule),
  ];

  schedule();
  return dispose;
}

// ---------------------------------------------------------------------------
// Row wrapper

export function ReplyFootnoteSource({
  messageId,
  threadRef,
  itemKey,
  request,
  listRef,
  children,
}: {
  messageId: ItemId;
  threadRef?: HostThreadRef;
  itemKey: string;
  request: ReplyFootnoteTarget | null;
  listRef: RefObject<LegendListRef | null>;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const root = rootRef.current;
    if (!root || !list || !request || request.citation.messageId !== messageId) {
      return;
    }
    return observeReplyFootnoteSource({ root, itemKey, request, list });
  }, [itemKey, listRef, messageId, request]);

  return (
    <div
      data-reply-footnote-environment={threadRef?.hostId}
      data-reply-footnote-source={messageId}
      data-reply-footnote-thread={threadRef?.threadId}
      ref={rootRef}
    >
      {children}
    </div>
  );
}
