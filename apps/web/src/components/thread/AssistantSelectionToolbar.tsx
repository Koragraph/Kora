import {
  resolveSelectionActionPosition,
  observeSelectionActions,
  type SelectionActionPoint,
} from "~/util/selectionActions";
import {
  captureAssistantTextSelection,
  type ReplyFootnoteSourceAnchor,
} from "~/util/assistantTextSelection";
import { Button } from "../ui/button";
import {
  REPLY_FOOTNOTE_MAX_TEXT_LENGTH,
  type HostThreadRef,
  type ReplyFootnote,
  ItemId,
} from "@kora/contracts";
import { createPortal } from "react-dom";
import { useLayoutEffect, useCallback, useEffect, useState, useRef } from "react";
import { QuoteIcon } from "lucide-react";

const EDGE_GAP = 8;

type PendingCitation = {
  citation: ReplyFootnote;
  anchor: ReplyFootnoteSourceAnchor;
  point: SelectionActionPoint;
};

type Props = {
  viewport: HTMLElement | null;
  threadRef: HostThreadRef;
  onCite: (citation: ReplyFootnote, sourceAnchor: ReplyFootnoteSourceAnchor) => boolean;
};

export function AssistantSelectionToolbar({ viewport, threadRef, onCite }: Props) {
  const [pending, setPending] = useState<PendingCitation | null>(null);
  const [placed, setPlaced] = useState<SelectionActionPoint | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const controllerRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const threadRefLatest = useRef(threadRef);
  threadRefLatest.current = threadRef;

  const refreshFromSelection = useCallback(
    (pointer: SelectionActionPoint | null) => {
      if (!viewport) return;
      const selection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, selection);
      const messageId = captured?.source.dataset.replyFootnoteSource;
      if (!captured || !messageId) {
        setPending(null);
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const rects = captured.range.getClientRects();
      const rangeRect = captured.range.getBoundingClientRect();
      const lastRect = rects.length > 0 ? rects[rects.length - 1]! : rangeRect;
      const outsideVertically =
        rangeRect.bottom < viewportRect.top || rangeRect.top > viewportRect.bottom;
      if (outsideVertically || rangeRect.width === 0) {
        setPending(null);
        return;
      }

      const latest = threadRefLatest.current;
      setPending({
        citation: {
          version: 1,
          hostId: latest.hostId,
          threadId: latest.threadId,
          messageId: ItemId.make(messageId),
          ...captured.selector,
        },
        anchor: { source: captured.source, range: captured.range, viewport },
        point: resolveSelectionActionPosition({
          bounds: {
            left: viewportRect.left,
            top: viewportRect.top,
            width: viewportRect.width,
            height: viewportRect.height,
          },
          selectionRect: lastRect,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    },
    [viewport],
  );

  useEffect(() => {
    if (!viewport) {
      setPending(null);
      return;
    }
    const controller = observeSelectionActions({
      element: viewport,
      getActionElement: () => buttonRef.current,
      onSelection: refreshFromSelection,
      onDismiss: () => setPending(null),
    });
    controllerRef.current = controller;
    const onSelectionChange = () => controller.selectionChanged();
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      controller.dispose();
      controllerRef.current = null;
    };
  }, [viewport, refreshFromSelection]);

  // A plain Tab from the page moves focus onto the toolbar so it is keyboard reachable.
  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const button = buttonRef.current;
      const modified = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
      if (
        event.key !== "Tab" ||
        modified ||
        event.isComposing ||
        event.defaultPrevented ||
        !button ||
        button.disabled ||
        (event.target instanceof Node && button.contains(event.target))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [pending]);

  // Keep the measured toolbar inside the window.
  useLayoutEffect(() => {
    if (!pending) {
      setPlaced(null);
      return;
    }
    const button = buttonRef.current;
    const width = button?.offsetWidth ?? 0;
    const height = button?.offsetHeight ?? 0;
    setPlaced({
      x: Math.max(EDGE_GAP, Math.min(pending.point.x, window.innerWidth - width - EDGE_GAP)),
      y: Math.max(EDGE_GAP, Math.min(pending.point.y, window.innerHeight - height - EDGE_GAP)),
    });
  }, [pending]);

  if (!pending || typeof document === "undefined") return null;

  const tooLong = pending.citation.text.length > REPLY_FOOTNOTE_MAX_TEXT_LENGTH;
  const at = placed ?? pending.point;

  return createPortal(
    <Button
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
      className="fixed z-50 rounded-full px-2.5"
      disabled={tooLong}
      onClick={() => {
        if (tooLong) return;
        if (onCite(pending.citation, pending.anchor)) {
          window.getSelection()?.removeAllRanges();
          controllerRef.current?.cancel();
          setPending(null);
        }
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.preventDefault()}
      ref={buttonRef}
      size="xs"
      style={{ left: at.x, top: at.y, maxWidth: "calc(100vw - 16px)" }}
      variant="glass"
    >
      <QuoteIcon className="size-3.5" aria-hidden="true" />
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}
