/** What the thread view gives the cards: answer a request, and whether the request can still be answered. */

import { cn } from "~/util/utils";
import { Spinner } from "~/components/ui/spinner";
import { Button } from "~/components/ui/button";
import {
  type ApprovalDecisionId,
  parseApproval,
  type ApprovalView,
  outcomeLine,
  tildePath,
} from "./approvalModel";
import { PathText } from "../shell/PathText";
import { useGroupThread } from "../groups/groupThreadContext";
import { useBlobSkin } from "../chat/blobSkin";
import type { BlobCardRef } from "../../../thread/timeline";
import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
  useEffect,
  useState,
  useMemo,
  useRef,
} from "react";
// A blob's approval request, in the transcript where it was asked: what it wants to do (the full command / file / page /
// app action), where, and three answers - Allow once, Always for this blob, Deny. The composer stays free: you can keep
// typing while a card waits. Answered cards fold into one quiet line.
import {
  ShieldQuestionIcon,
  FileTextIcon,
  TerminalIcon,
  CheckIcon,
  GlobeIcon,
  PlugIcon,
  XIcon,
} from "lucide-react";

export interface BlobApprovalApi {
  readonly respond: (requestId: string, decision: ApprovalDecisionId) => Promise<unknown>;
  /** Request ids being sent right now. */
  readonly responding: ReadonlyArray<string>;
  /** False when nothing is running any more (the app restarted): an open card then reads "No longer waiting". */
  readonly live: boolean;
}

const Ctx = createContext<BlobApprovalApi | null>(null);
export function BlobApprovalProvider(props: {
  value: BlobApprovalApi | null;
  children: ReactNode;
}) {
  return createElement(Ctx.Provider, { value: props.value }, props.children);
}
export const useBlobApprovals = (): BlobApprovalApi | null => useContext(Ctx);

const ICONS = {
  command: TerminalIcon,
  "file-read": FileTextIcon,
  "file-change": FileTextIcon,
  fetch: GlobeIcon,
  app: PlugIcon,
  other: ShieldQuestionIcon,
} as const;

export function ApprovalCard(props: { readonly card: BlobCardRef; readonly home?: string | null }) {
  const view = useMemo(() => parseApproval(props.card), [props.card]);
  const api = useBlobApprovals();
  const group = useGroupThread();
  const skinName = useBlobSkin()?.name;
  // In a group the request names the MEMBER that raised it (the thread's own skin is the group's).
  const authorId =
    typeof props.card.payload.authorBlobId === "string" ? props.card.payload.authorBlobId : null;
  const who =
    (group && authorId ? group.membersById.get(authorId)?.name : null) ?? skinName ?? "This blob";
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const isOpen = view?.state === "open";
  const requestId = view?.requestId ?? null;
  // A card that needs an answer is brought fully into view above the composer when it appears (live QA #3: it sat half
  // under the composer, with its buttons out of sight). `scroll-mb` keeps the composer's height out of the way.
  useEffect(() => {
    if (!isOpen) return;
    sectionRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [isOpen, requestId]);
  if (!view) return null;
  const state = view.state === "open" && api && !api.live ? "expired" : view.state;
  const shown: ApprovalView = state === view.state ? view : { ...view, state };

  if (state !== "open") {
    return (
      <div
        data-blob-card="approval"
        data-approval-state={state}
        data-request-id={view.requestId}
        className="flex min-w-0 max-w-[38rem] items-center gap-2 rounded-lg px-1 py-0.5 text-[12px] leading-5 text-muted-foreground"
      >
        {state === "denied" || state === "cancelled" || state === "expired" ? (
          <XIcon className="size-3 shrink-0" aria-hidden />
        ) : (
          <CheckIcon className="size-3 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 line-clamp-2 break-all">{outcomeLine(shown)}</span>
      </div>
    );
  }

  const Icon = ICONS[view.kind];
  const busy = api?.responding.includes(view.requestId) ?? false;
  const answer = async (decision: ApprovalDecisionId) => {
    if (!api || busy) return;
    setError(null);
    try {
      await api.respond(view.requestId, decision);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send that answer.");
    }
  };
  const folder = view.cwd ? tildePath(view.cwd, props.home ?? null) : null;

  return (
    <section
      ref={sectionRef}
      data-blob-card="approval"
      data-approval-state="open"
      data-approval-kind={view.kind}
      data-request-id={view.requestId}
      aria-label={`${who} is asking permission: ${view.heading}`}
      className="w-full max-w-[38rem] scroll-mb-44 rounded-2xl border border-border bg-card"
    >
      <header className="flex items-center gap-2.5 px-4 pt-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] leading-5 font-semibold tracking-[-0.01em] text-foreground">
          {who} wants to {view.heading.charAt(0).toLowerCase()}
          {view.heading.slice(1)}
        </h3>
        {view.appName ? (
          <span className="shrink-0 rounded-md bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
            {view.appName}
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground">Needs your OK</span>
      </header>

      {view.body ? (
        <pre
          data-approval-detail="complete"
          tabIndex={0}
          className={cn(
            "mx-4 mt-2 max-h-52 overflow-auto rounded-lg bg-background/70 px-3 py-2 text-[12px] leading-[18px] text-foreground/90 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            view.kind === "command"
              ? "font-mono whitespace-pre-wrap break-all"
              : "font-sans whitespace-pre-wrap break-words",
          )}
        >
          {view.body}
        </pre>
      ) : null}

      {view.target || view.linkTarget || folder ? (
        <dl className="mx-4 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px] leading-4">
          {view.target ? (
            <>
              <dt className="text-muted-foreground">{view.kind === "fetch" ? "Page" : "File"}</dt>
              <dd className="min-w-0 font-mono text-foreground/85" data-approval-target>
                <PathText path={tildePath(view.target, props.home ?? null)} />
              </dd>
            </>
          ) : null}
          {view.linkTarget ? (
            <>
              <dt className="text-muted-foreground">Links to</dt>
              <dd className="min-w-0 font-mono text-foreground/85" data-approval-link-target>
                <PathText path={`→ ${view.linkTarget}`} />
              </dd>
            </>
          ) : null}
          {folder ? (
            <>
              <dt className="text-muted-foreground">Runs in</dt>
              <dd className="min-w-0 font-mono text-foreground/85" data-approval-cwd>
                <PathText path={folder} />
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3 pb-3">
        <Button
          size="xs"
          variant="default"
          disabled={busy || !api}
          onClick={() => void answer("accept")}
          data-approval-action="accept"
        >
          {busy ? <Spinner className="size-3" /> : null}
          Allow once
        </Button>
        {view.alwaysLabel ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={busy || !api}
            onClick={() => void answer("acceptAlways")}
            data-approval-action="acceptAlways"
          >
            Always for this blob
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={busy || !api}
          onClick={() => void answer("decline")}
          data-approval-action="decline"
        >
          Deny
        </Button>
        {view.alwaysLabel ? (
          <span
            className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground"
            data-approval-always-hint
          >
            Always = {view.alwaysLabel.toLowerCase()}
          </span>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="border-t border-border/50 px-4 py-2 text-[12px] text-foreground/80"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
