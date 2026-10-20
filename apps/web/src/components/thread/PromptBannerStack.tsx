import { cn } from "~/util/utils";
import { type PromptBannerVariant, PromptBanner } from "./PromptBanner";
import { PopoverTrigger, PopoverPopup, Popover } from "../ui/popover";
import { Button } from "../ui/button";
import {
  useMemo,
  useState,
  useCallback,
  useRef,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
} from "react";
import { InfoIcon } from "lucide-react";

export interface PromptBannerStackItem {
  readonly priority?: "urgent" | "activity" | "notice";
  readonly variant: PromptBannerVariant;
  readonly description?: ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly title: ReactNode;
  readonly icon: ReactNode;
  readonly id: string;
}

export type PromptBannerStackContent = Pick<
  PromptBannerStackItem,
  "id" | "variant" | "priority"
> & {
  readonly content: ReactNode;
};

type StackEntry = PromptBannerStackItem | PromptBannerStackContent;

/** Must match the exit transition duration in the class names below. */
const EXIT_MS = 220;

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]';

function rankOf(entry: StackEntry): number {
  if (entry.priority === "activity") return 0;
  if (entry.priority === "urgent" || entry.variant === "error" || entry.variant === "warning") {
    return 1;
  }
  return 2;
}

function isContentEntry(entry: StackEntry): entry is PromptBannerStackContent {
  return "content" in entry;
}

export function PromptBannerStack({
  className,
  items,
}: {
  className?: string;
  items: ReadonlyArray<StackEntry>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const groupId = useId();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const peekRef = useRef<HTMLButtonElement | null>(null);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const hoveredRef = useRef(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFocusRef = useRef<"notice" | "peek" | null>(null);

  // Stable sort: activity first, then urgent/error/warning, then everything else.
  const ordered = useMemo(
    () =>
      items
        .map((entry, index) => ({ entry, index, rank: rankOf(entry) }))
        .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
        .map(({ entry }) => entry),
    [items],
  );
  const front = ordered[0];
  const stacked = ordered.slice(1);
  const hasStack = stacked.length > 0;

  const activeExitingId =
    exitingId !== null && ordered.some((entry) => entry.id === exitingId) ? exitingId : null;

  useEffect(() => {
    if (stacked.length < 1 && expanded) setExpanded(false);
  }, [stacked.length, expanded]);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (pending === "notice" && expanded) {
      const group = groupRef.current;
      const target = group?.querySelector<HTMLElement>(FOCUSABLE) ?? group;
      target?.focus({ preventScroll: true });
    } else if (pending === "peek" && !expanded) {
      peekRef.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

  const requestDismiss = useCallback(
    (entry: StackEntry) => {
      if (isContentEntry(entry) || !entry.onDismiss || activeExitingId !== null) return;
      const onDismiss = entry.onDismiss;
      if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
      setExitingId(entry.id);
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        onDismiss();
      }, EXIT_MS);
    },
    [activeExitingId],
  );

  if (!front) return null;

  const regionContains = (node: EventTarget | null) =>
    node instanceof Node && regionRef.current?.contains(node) === true;

  const renderEntry = (entry: StackEntry, placement: "attached" | "floating") => {
    if (isContentEntry(entry)) {
      return (
        <PromptBanner.Root density="comfortable" placement={placement} variant={entry.variant}>
          {entry.content}
        </PromptBanner.Root>
      );
    }
    const exiting = entry.id === activeExitingId;
    return (
      <PromptBanner.Root
        density="comfortable"
        placement={placement}
        role="alert"
        variant={entry.variant}
      >
        <PromptBanner.Row layout="wrap-actions-narrow">
          <PromptBanner.Icon className="h-(--composer-banner-icon-column) self-start">
            {entry.icon}
          </PromptBanner.Icon>
          <PromptBanner.Content className="flex-nowrap">
            <span
              className={cn(
                "font-medium leading-7 sm:leading-6",
                typeof entry.title === "string" && "truncate",
              )}
            >
              {entry.title}
            </span>
            {entry.description ? (
              <>
                <span className="shrink-[9999] truncate text-muted-foreground @max-[400px]:sr-only">
                  {entry.description}
                </span>
                <Popover>
                  <PopoverTrigger
                    delay={150}
                    openOnHover
                    render={
                      <Button
                        aria-label="Show notice details"
                        className="hidden text-muted-foreground hover:text-foreground @max-[400px]:inline-flex"
                        size="icon-xs"
                        variant="ghost"
                      />
                    }
                  >
                    <InfoIcon className="size-3.5" />
                  </PopoverTrigger>
                  <PopoverPopup
                    className="max-w-72 whitespace-normal text-pretty"
                    side="top"
                    tooltipStyle
                  >
                    {entry.description}
                  </PopoverPopup>
                </Popover>
              </>
            ) : null}
          </PromptBanner.Content>
          {entry.actions || entry.onDismiss ? (
            <PromptBanner.Actions>
              {entry.actions}
              {entry.onDismiss ? (
                <PromptBanner.Dismiss
                  aria-label={entry.dismissLabel ?? "Dismiss warning"}
                  disabled={exiting}
                  onClick={() => requestDismiss(entry)}
                />
              ) : null}
            </PromptBanner.Actions>
          ) : null}
        </PromptBanner.Row>
        {entry.children ? <PromptBanner.Children>{entry.children}</PromptBanner.Children> : null}
      </PromptBanner.Root>
    );
  };

  const frontExiting = front.id === activeExitingId;

  return (
    <PromptBanner.Attachment
      className={className}
      data-prompt-banner-drawer="true"
      data-prompt-collapsed-controls="true"
    >
      <div className={cn("relative flex flex-col-reverse", expanded && hasStack && "z-50")}>
        <div
          className={cn(
            "z-10 transition-[translate,opacity] duration-[220ms] ease-in",
            frontExiting && "pointer-events-none translate-y-16 opacity-0",
          )}
          key={front.id}
          onPointerDownCapture={() => {
            if (!expanded) return;
            setExpanded(false);
            const active = document.activeElement;
            if (active instanceof HTMLElement && regionContains(active)) active.blur();
          }}
        >
          {renderEntry(front, "attached")}
        </div>
        {hasStack ? (
          <div
            className="relative z-20 min-h-3"
            onBlurCapture={(event) => {
              if (!expanded) return;
              if (regionContains(event.relatedTarget)) return;
              if (!hoveredRef.current) setExpanded(false);
            }}
            onPointerEnter={(event) => {
              if (event.pointerType === "touch") return;
              hoveredRef.current = true;
              if (document.activeElement === peekRef.current) pendingFocusRef.current = "notice";
              setExpanded(true);
            }}
            onPointerLeave={() => {
              hoveredRef.current = false;
              if (!regionContains(document.activeElement)) setExpanded(false);
            }}
            ref={regionRef}
          >
            {!frontExiting ? (
              <PromptBanner.Peek
                aria-controls={groupId}
                aria-expanded={expanded}
                aria-hidden={expanded || undefined}
                aria-label="Show other notices"
                className={expanded ? "pointer-events-none opacity-0" : undefined}
                onClick={() => {
                  peekRef.current?.focus();
                  pendingFocusRef.current = "notice";
                  setExpanded(true);
                }}
                ref={peekRef}
                tabIndex={expanded ? -1 : 0}
                variant={stacked[0]?.variant ?? "default"}
              />
            ) : null}
            <div
              aria-label="Other notices"
              className={cn(
                "grid transition-[grid-template-rows] duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
              data-prompt-banner-stack-expanded-items="true"
              id={groupId}
              ref={groupRef}
              role="group"
              tabIndex={-1}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className={cn(
                    "space-y-2 pb-2 transition-[opacity,transform] duration-150 ease-out [transform:translateZ(0)]",
                    !expanded && "pointer-events-none invisible translate-y-1 opacity-0",
                  )}
                >
                  {stacked.map((entry) => (
                    <div
                      className={cn(
                        "transition-[translate,opacity] duration-[220ms] ease-in",
                        entry.id === activeExitingId &&
                          "pointer-events-none translate-y-28 opacity-0",
                      )}
                      key={entry.id}
                    >
                      {renderEntry(entry, "floating")}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </PromptBanner.Attachment>
  );
}
