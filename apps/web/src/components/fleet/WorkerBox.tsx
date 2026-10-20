/**
 * One worker as a small window (docs/fleet/WORKER-BOXES.md, approved mock docs/fleet/worker-panes-v2-mock.html "A · Grid
 * of windows"). The same pane is a box in the dock's grid and the window a sprite opens (`variant`).
 *
 * whead (traffic lights, logo, task, `Name · model`, state pill — in the window: lights, logo, task and what it is
 * doing, no pill) · [window tabs] · body · pinned approvals ·
 * wsub (branch, ctx, cost, elapsed) · wsteer.
 * The body is the worker's feed (`fleet.subscribeWorker`) rendered like the chat when `surface === "gui"`, its
 * history + Wake when asleep, and otherwise the live worker terminal (`terminal.attach` on `terminalId`) — so every
 * worker stays viewable. Per-worker extras (swarm report / verify / foreman / failover, merge, approvals, retries)
 * are cards at the bottom of the body.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  FleetRespondApprovalInput,
  FleetWorker,
  HostThreadRef,
  WorkerFeedItem,
} from "@kora/contracts";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/util/utils";
import { Hint } from "~/components/ui/hint";
import { formatSwarmModel } from "~/util/swarm";
import { useHostQuery } from "~/atoms/query";
import { useAtomAction } from "~/atoms/use-atom-command";
import { fleetHost } from "~/atoms/fleet";
import { primaryDaemonAvailableEditorsAtom } from "~/atoms/server";
import { useHostHttpBaseUrl } from "~/atoms/hosts";
import { useOpenInEditor } from "~/workspace/editorPreferences";
import ReplyMarkdown from "../ReplyMarkdown";
import { TerminalViewport } from "../../terminal/TerminalViewport";
import { WorkerHistoryView, wakeWorkerRecord } from "../assistant/WorkerHistoryView";
import { isWorkerFinished } from "../assistant/blobMenu";
import { SwarmReportView, formatReportBytes } from "../swarm/SwarmReportView";
import { swarmAttemptsTooltip } from "../swarm/SwarmWorkerBadge";
import { WorkGlyph, type WorkIconName } from "../thread/transcriptWorkIcons";
import { AGENTS_BY_ID } from "./agents";
import { AgentIcon } from "./AgentIcon";
import { finishedMarker } from "./finishedWorkers";
import { hasSomethingToMerge, mergeFailureOf, type MergeFailure } from "./mergePlan.logic";
import {
  agentIdentity,
  isExecTool,
  lastActionText,
  splitPinnedApprovals,
  trafficLights,
  workerSubline,
  workerWindowTabs,
  retryCountdown,
  shortBranch,
  workerCostText,
  workerElapsed,
  elapsedEnd,
  workerStatePill,
  workerBodyMode,
  workerDoingLine,
  workerHasTerminalToggle,
  type LightAct,
  type PaneVariant,
  type WindowTab,
  type WorkerPill,
} from "./workerBoxes.logic";

/** The worker's standing in the last cross-diff verdict (computed by FleetPanel). */
export interface WorkerStanding {
  readonly status: "clean" | "semantic" | "needs-human";
  /** The other workers in flagged pairs, by display name (task title), never by pane id. */
  readonly with: ReadonlyArray<string>;
}

const NO_ITEMS: ReadonlyArray<WorkerFeedItem> = [];

/** The feed of a GUI worker (shared by its box and its strip: one subscription per pane). */
export function useWorkerFeed(
  threadRef: HostThreadRef,
  worker: FleetWorker,
): { readonly items: ReadonlyArray<WorkerFeedItem>; readonly loading: boolean } {
  const gui = worker.surface === "gui";
  const query = useHostQuery(
    gui
      ? fleetHost.workerFeed({
          hostId: threadRef.hostId,
          input: { threadId: threadRef.threadId, paneId: worker.paneId },
        })
      : null,
  );
  return { items: query.data ?? NO_ITEMS, loading: gui && query.data === null };
}

// ── small pieces ────────────────────────────────────────────────────────────────────────────────────────────

/** The agent's logo: the same marks as the model picker and the terminal panes (fleet/AgentIcon). */
export function AgentMark(props: { agent: string; size: number }) {
  return (
    <span className="wb-mk" data-brand-hue="" aria-hidden>
      <AgentIcon id={props.agent} size={props.size} />
    </span>
  );
}

export function StatePill({ pill }: { pill: WorkerPill }) {
  return (
    <span className={cn("wb-state", `k-${pill.kind}`)} data-worker-state={pill.kind}>
      {pill.kind === "working" || pill.kind === "starting" ? (
        <span className="wb-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      ) : null}
      {pill.label}
    </span>
  );
}

/** Re-renders itself once a second while `active`; the rest of the box never ticks. */
function useTick(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [active, everyMs]);
  return now;
}

function Elapsed({ worker, visible }: { worker: FleetWorker; visible: boolean }) {
  const now = useTick(visible && elapsedEnd(worker) === null);
  return <span className="tabular-nums">{workerElapsed(worker, now)}</span>;
}

function RetryLine(props: {
  attempt: number;
  max: number;
  nextAt: number | null;
  tail?: string | undefined;
}) {
  const now = useTick(props.nextAt !== null && props.nextAt > Date.now());
  const s = retryCountdown(props.nextAt, now);
  return (
    <div className="sub" data-retry-countdown={s ?? ""}>
      {s !== null && s > 0
        ? `Retrying in ${s} s (${props.attempt} of ${props.max}).`
        : `Retry ${props.attempt} of ${props.max}.`}
      {props.tail ? ` ${props.tail}` : ""}
    </div>
  );
}

const SOURCE_LABEL: Record<"leader" | "human" | "kora", string> = {
  leader: "Lead",
  human: "You",
  kora: "Kora",
};

function toolIcon(tool: string): WorkIconName {
  const t = tool.toLowerCase();
  if (/^(read|view|cat|open)/.test(t)) return "eye";
  if (/(edit|write|patch|create|replace)/.test(t)) return "square-pen";
  if (/(bash|shell|exec|command|run|terminal)/.test(t)) return "terminal";
  if (/(grep|glob|search|explore|find|ls|list|graph)/.test(t)) return "search";
  if (/(fetch|web|browse|url)/.test(t)) return "globe";
  if (/(task|agent|spawn)/.test(t)) return "bot";
  if (/(think|plan)/.test(t)) return "brain";
  return "wrench";
}

/** The title without a leading repeat of the tool name ("Read foo.ts" under tool "Read" → "foo.ts"). */
function toolRest(tool: string, title: string): string {
  const trimmed = title.trim();
  return trimmed.toLowerCase().startsWith(tool.toLowerCase())
    ? trimmed.slice(tool.length).trim()
    : trimmed;
}

const ToolRow = memo(function ToolRow({
  item,
  exec,
}: {
  item: Extract<WorkerFeedItem, { kind: "tool" }>;
  /** Render as a `$ command` block (Codex, like its own CLI). */
  exec?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!item.detail;
  const failed = item.status === "failed";
  const rest = toolRest(item.tool, item.title);
  if (exec) {
    return (
      <div className={cn("wb-exec", failed && "is-failed")} data-feed-item={item.id}>
        <button
          type="button"
          {...(hasDetail ? { "aria-expanded": open, onClick: () => setOpen((o) => !o) } : {})}
        >
          <span className="p" aria-hidden>
            $
          </span>
          <span className="cmd">{rest || item.title}</span>
          {item.status === "running" ? (
            <span className="wb-dots" aria-label="running">
              <i />
              <i />
              <i />
            </span>
          ) : failed ? (
            <span className="code">failed</span>
          ) : null}
          {hasDetail ? (
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
              aria-hidden
            />
          ) : null}
        </button>
        {open && item.detail ? <pre>{item.detail}</pre> : null}
      </div>
    );
  }
  return (
    <div className={cn("toolrow", failed && "is-failed")} data-feed-item={item.id}>
      <button
        type="button"
        {...(hasDetail ? { "aria-expanded": open, onClick: () => setOpen((o) => !o) } : {})}
      >
        <WorkGlyph name={toolIcon(item.tool)} className="size-3.5 shrink-0 stroke-[1.8]" />
        <b>{item.tool}</b>
        <span className="tt">{rest}</span>
        {item.added !== null ? <span className="wb-add">+{item.added}</span> : null}
        {item.removed !== null ? <span className="wb-del">−{item.removed}</span> : null}
        {item.status === "running" ? (
          <LoaderCircleIcon className="size-3 shrink-0 animate-spin" aria-label="running" />
        ) : null}
        {hasDetail ? (
          <ChevronRightIcon
            className={cn("ms-auto size-3 shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden
          />
        ) : null}
      </button>
      {open && item.detail ? <pre>{item.detail}</pre> : null}
    </div>
  );
});

function ApprovalCard(props: {
  requestId: string;
  title: string;
  detail: string | null;
  status: "open" | "accepted" | "declined" | "expired";
  onRespond: (requestId: string, decision: FleetRespondApprovalInput["decision"]) => Promise<void>;
}) {
  const [sending, setSending] = useState<FleetRespondApprovalInput["decision"] | null>(null);
  const respond = (decision: FleetRespondApprovalInput["decision"]) => {
    if (sending) return;
    setSending(decision);
    void props.onRespond(props.requestId, decision).finally(() => setSending(null));
  };
  const open = props.status === "open";
  return (
    <div className={cn("wb-card", open && "is-ask")} data-approval={props.requestId}>
      <div className="q">
        {open ? <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden /> : null}
        <b>{props.title}</b>
      </div>
      {props.detail ? <div className="mono wb-well">{props.detail}</div> : null}
      {open ? (
        <div className="wb-btns">
          <button
            type="button"
            className="wb-btn is-primary"
            disabled={!!sending}
            onClick={() => respond("accept")}
          >
            Allow
          </button>
          <button
            type="button"
            className="wb-btn"
            disabled={!!sending}
            onClick={() => respond("acceptForSession")}
          >
            Allow always
          </button>
          <button
            type="button"
            className="wb-btn"
            disabled={!!sending}
            onClick={() => respond("decline")}
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="sub">
          {props.status === "accepted"
            ? "Allowed"
            : props.status === "declined"
              ? "Denied"
              : "Expired"}
        </div>
      )}
    </div>
  );
}

// ── the feed ────────────────────────────────────────────────────────────────────────────────────────────────

const STICK_PX = 48;

function WorkerFeed(props: {
  worker: FleetWorker;
  threadRef: HostThreadRef;
  items: ReadonlyArray<WorkerFeedItem>;
  loading: boolean;
  working: boolean;
  cards: ReactNode;
  /** Codex: shell tools as `$ command` blocks. */
  execBlocks: boolean;
  onRespond: (requestId: string, decision: FleetRespondApprovalInput["decision"]) => Promise<void>;
}) {
  const { items } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }, []);
  // Follow the newest item unless the human scrolled up to read.
  const last = items.at(-1);
  const tailKey = `${items.length}:${last?.id ?? ""}:${last && "text" in last ? last.text.length : 0}`;
  // Keyed on whether cards exist, not on the cards node: that is a fresh element on every box render (a mousedown
  // focuses the box), and re-sticking then moved an approval card's buttons out from under the pointer mid-click.
  const hasCards = props.cards !== null;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [tailKey, hasCards]);
  const cwd = props.worker.worktree?.path ?? props.worker.cwd;

  return (
    <div
      ref={scrollRef}
      className="wbody"
      onScroll={onScroll}
      data-worker-feed={props.worker.paneId}
    >
      {items.length === 0 ? (
        <div className="wb-empty">{props.loading ? "Loading…" : "Nothing yet."}</div>
      ) : null}
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className="msg-user" data-feed-item={item.id}>
                <span className="src">{SOURCE_LABEL[item.source]}</span>
                <div className="bub">{item.text}</div>
              </div>
            );
          case "assistant":
            return (
              <div key={item.id} className="wb-ai" data-feed-item={item.id}>
                <ReplyMarkdown
                  text={item.text}
                  cwd={cwd}
                  threadRef={props.threadRef}
                  isStreaming={item.streaming}
                />
              </div>
            );
          case "tool":
            return (
              <ToolRow key={item.id} item={item} exec={props.execBlocks && isExecTool(item.tool)} />
            );
          case "approval":
            return (
              <ApprovalCard
                key={item.id}
                requestId={item.requestId}
                title={item.title}
                detail={item.detail}
                status={item.status}
                onRespond={props.onRespond}
              />
            );
          case "error":
            return (
              <div key={item.id} className="wb-card is-error" data-feed-item={item.id}>
                <b>{item.text}</b>
                {item.retry ? (
                  <RetryLine
                    attempt={item.retry.attempt}
                    max={item.retry.max}
                    nextAt={item.retry.nextAt}
                    tail={
                      item.retry.attempt >= item.retry.max
                        ? "The lead is told if it fails again."
                        : undefined
                    }
                  />
                ) : null}
              </div>
            );
          case "notice":
            return (
              <div key={item.id} className="wb-notice" data-feed-item={item.id}>
                {item.text}
              </div>
            );
        }
      })}
      {props.working ? (
        <div className="wb-live">
          <span className="wb-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          Working
        </div>
      ) : null}
      {props.cards}
    </div>
  );
}

// ── terminal body (non-GUI workers) ─────────────────────────────────────────────────────────────────────────

function WorkerTerminal(props: {
  worker: FleetWorker;
  threadRef: HostThreadRef;
  visible: boolean;
  focused: boolean;
  resizeEpoch: number;
  advancedTypography: boolean;
  onFocus: () => void;
}) {
  const { worker } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);
  const [focusRequestId, setFocusRequestId] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setHeight(Math.round(h));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="wb-term"
      data-worker-terminal={worker.terminalId}
      onMouseDown={() => {
        props.onFocus();
        setFocusRequestId((n) => n + 1);
      }}
    >
      <TerminalViewport
        advancedTypography={props.advancedTypography}
        threadRef={props.threadRef}
        threadId={props.threadRef.threadId}
        terminalId={worker.terminalId}
        terminalLabel={worker.title}
        cwd={worker.cwd}
        worktreePath={worker.worktree?.path ?? null}
        onSessionExited={() => undefined}
        focusRequestId={focusRequestId}
        autoFocus={props.focused}
        visible={props.visible}
        resizeEpoch={props.resizeEpoch + height}
        drawerHeight={height}
      />
    </div>
  );
}

// ── cards at the bottom of the body ─────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function verifyLine(worker: FleetWorker): { text: string; tone: "ok" | "bad" | "muted" } | null {
  const v = worker.swarm?.verify;
  if (!v) return null;
  switch (v.state) {
    case "passed":
      return {
        text: v.bounces > 0 ? `Verified · ${plural(v.bounces, "bounce", "bounces")}` : "Verified",
        tone: "ok",
      };
    case "bounced":
      return { text: `Bounced ${v.bounces}`, tone: "bad" };
    case "failed":
      return {
        text:
          v.bounces > 0
            ? `Verify failed · ${plural(v.bounces, "bounce", "bounces")}`
            : "Verify failed",
        tone: "bad",
      };
    case "pending":
      return { text: "Verifying…", tone: "muted" };
    case "skipped":
      return null;
  }
}

const FOREMAN_WORD = {
  working: "working",
  checking: "checking",
  retrying: "retrying",
  passed: "passed",
  escalated: "escalated to the lead",
} as const;

function SwarmCard(props: {
  worker: FleetWorker;
  threadRef: HostThreadRef;
  onOpenReport: () => void;
}) {
  const swarm = props.worker.swarm!;
  const runRetry = useAtomAction(fleetHost.retry, { reportFailure: true });
  const runExtend = useAtomAction(fleetHost.extend, { reportFailure: true });
  const [busy, setBusy] = useState(false);
  const finished = isWorkerFinished(props.worker);
  const verify = verifyLine(props.worker);
  const foreman = swarm.foreman ?? null;
  const lastVerdict = foreman?.verdicts.at(-1) ?? null;
  const input = { threadId: props.threadRef.threadId, paneId: props.worker.paneId };
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    void p.finally(() => setBusy(false));
  };
  return (
    <div className="wb-card" data-swarm-card={swarm.taskId}>
      <Hint label={swarm.attempts.length > 1 ? swarmAttemptsTooltip(swarm) : null}>
        <div className="row">
          <span>
            Task {swarm.taskId} · {formatSwarmModel(swarm.provider, swarm.modelLabel)}
          </span>
          <span>{swarm.attempt > 1 ? `attempt ${swarm.attempt}` : null}</span>
        </div>
      </Hint>
      {swarm.attempts.length > 1 ? (
        <div className="sub">
          {swarm.attempts.map((a) => `${a.model.split("/").at(-1)} ${a.outcome}`).join(" → ")}
        </div>
      ) : null}
      {swarm.supersededBy ? <div className="sub">Replaced by {swarm.supersededBy}</div> : null}
      {verify ? (
        <div
          className="sub"
          style={{
            color:
              verify.tone === "ok"
                ? "var(--wb-green)"
                : verify.tone === "bad"
                  ? "var(--wb-red)"
                  : undefined,
          }}
        >
          {verify.text}
          {swarm.verify?.summary ? ` — ${swarm.verify.summary}` : ""}
        </div>
      ) : null}
      {foreman ? (
        <div className="sub" data-foreman={foreman.state}>
          Foreman: {FOREMAN_WORD[foreman.state]} · attempt {foreman.attempt} of{" "}
          {foreman.maxAttempts}
          {foreman.check ? ` · check \`${foreman.check}\`` : ""}
          {lastVerdict?.failure ? ` · last try failed (${lastVerdict.failure})` : ""}
          {lastVerdict?.review ? ` · review ${lastVerdict.review.verdict}` : ""}
          {foreman.result?.diffStat ? <div className="mono">{foreman.result.diffStat}</div> : null}
          {foreman.result?.lastFailure ? (
            <div className="mono">{foreman.result.lastFailure}</div>
          ) : null}
        </div>
      ) : null}
      {swarm.step && !finished ? <div className="sub">Now: {swarm.step.text}</div> : null}
      <div className="wb-btns">
        {swarm.report ? (
          <button type="button" className="wb-btn" onClick={props.onOpenReport}>
            Report · {formatReportBytes(swarm.report.bytes)}
          </button>
        ) : null}
        {!finished ? (
          <>
            <button
              type="button"
              className="wb-btn"
              disabled={busy}
              onClick={() => run(runRetry({ hostId: props.threadRef.hostId, input }))}
            >
              Retry on another model
            </button>
            <button
              type="button"
              className="wb-btn"
              disabled={busy}
              onClick={() =>
                run(runExtend({ hostId: props.threadRef.hostId, input: { ...input, minutes: 15 } }))
              }
            >
              15 more min
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function MergeCard(props: {
  worker: FleetWorker;
  standing: WorkerStanding | null;
  onMerge: () => Promise<unknown>;
  onOpenWorktree: (() => void) | null;
}) {
  const { worker, standing } = props;
  const tree = worker.worktree!;
  const flagged = !!standing && standing.status !== "clean";
  // A flagged branch is a two-step click: the first arms "Merge anyway?" for a few seconds.
  const [armed, setArmed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [failure, setFailure] = useState<MergeFailure | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 6000);
    return () => window.clearTimeout(t);
  }, [armed]);
  const files = worker.asleep?.files ?? [];
  const ahead = tree.ahead ?? worker.asleep?.ahead;
  const onMerge = () => {
    if (flagged && !armed) return setArmed(true);
    setArmed(false);
    setMerging(true);
    setFailure(null);
    void props
      .onMerge()
      .then((result) => setFailure(mergeFailureOf(result)))
      .finally(() => setMerging(false));
  };
  return (
    <div className="wb-card is-merge" data-merge-card={worker.paneId}>
      <div className="wb-mergerow">
        <span className="br">
          ⑂ {shortBranch(tree.branch)}
          <span className="n">
            {ahead !== undefined ? ` · ${plural(ahead, "commit", "commits")}` : ""}
            {tree.dirty ? ` · ${tree.dirty} uncommitted` : ""}
          </span>
        </span>
        <span className="wb-btns">
          <Hint
            label={
              flagged
                ? "Git will merge it clean, but the graph flagged it. Click again to merge anyway."
                : `Merge ${shortBranch(tree.branch)} into the main checkout (commits first)`
            }
          >
            <button
              type="button"
              className={cn("wb-btn", flagged ? "is-warn" : "is-primary")}
              disabled={merging}
              onClick={onMerge}
            >
              {merging ? "Merging…" : armed ? "Merge anyway?" : failure ? "Try again" : "Merge"}
            </button>
          </Hint>
          {props.onOpenWorktree ? (
            <button type="button" className="wb-btn" onClick={props.onOpenWorktree}>
              Open in editor
            </button>
          ) : null}
        </span>
      </div>
      {files.slice(0, 6).map((f) => (
        <div key={f} className="row">
          <span>{f}</span>
        </div>
      ))}
      {files.length > 6 ? <div className="sub">… {files.length - 6} more</div> : null}
      {failure ? (
        <div className="sub" role="alert" style={{ color: "var(--wb-red)" }} data-merge-failure="">
          {failure.text}
          {failure.conflicts.slice(0, 6).map((f) => (
            <div key={f} className="mono">
              {f}
            </div>
          ))}
          {failure.conflicts.length > 6 ? <div>… {failure.conflicts.length - 6} more</div> : null}
        </div>
      ) : null}
      {standing ? (
        <div
          className="sub"
          style={{ color: flagged ? "var(--wb-red)" : "var(--wb-green)" }}
          data-standing={standing.status}
        >
          {standing.status === "clean"
            ? "The graph found no conflict with the other workers."
            : `${standing.status === "semantic" ? "Semantic conflict" : "Needs a look"} with ${standing.with.join(", ")} — see the verdict above.`}
        </div>
      ) : null}
    </div>
  );
}

// ── title bar ───────────────────────────────────────────────────────────────────────────────────────────────

const LIGHT_GLYPH: Record<LightAct, ReactNode> = {
  stop: <path d="M2.6 2.6l4.8 4.8M7.4 2.6l-4.8 4.8" strokeWidth="1.3" />,
  minimize: <path d="M2 5h6" strokeWidth="1.4" />,
  zoom: <path d="M2.8 7.2V2.8h4.4zM7.2 2.8v4.4H2.8z" strokeWidth="0" fill="currentColor" />,
};

/** macOS traffic lights: grey at rest, coloured while the pane is hovered or focused, glyphs on hover. */
function TrafficLights(props: {
  lights: ReturnType<typeof trafficLights>;
  armed: boolean;
  onAct: (act: LightAct) => void;
}) {
  return (
    <div
      className="wb-lights"
      role="group"
      aria-label="Window"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {props.lights.map((light) => (
        <Hint key={light.act} label={light.hint}>
          <button
            type="button"
            className={cn(
              "wb-light",
              `is-${light.act}`,
              light.act === "stop" && props.armed && "is-armed",
            )}
            aria-label={light.label}
            disabled={light.disabled}
            data-light={light.act}
            onClick={(event) => {
              event.stopPropagation();
              props.onAct(light.act);
            }}
          >
            <svg viewBox="0 0 10 10" aria-hidden stroke="currentColor" fill="none">
              {LIGHT_GLYPH[light.act]}
            </svg>
          </button>
        </Hint>
      ))}
    </div>
  );
}

const TAB_LABEL: Record<WindowTab, string> = {
  activity: "Activity",
  terminal: "Terminal",
  report: "Report",
  transcript: "Transcript",
};

// ── the pane ────────────────────────────────────────────────────────────────────────────────────────────────

export interface WorkerBoxProps {
  worker: FleetWorker;
  threadRef: HostThreadRef;
  visible: boolean;
  focused: boolean;
  /** Grid: fills the dock. Window: maximized. */
  expanded: boolean;
  resizeEpoch: number;
  advancedTypography: boolean;
  merged: boolean;
  standing: WorkerStanding | null;
  /** `box` in the dock's grid (default), `window` in the window a sprite opens. */
  variant?: PaneVariant;
  /** Window: drag / Esc handlers for the title bar. */
  titlebarProps?: HTMLAttributes<HTMLDivElement>;
  /** Window: the "⋯" worker actions menu (the sprite's right-click twin). */
  onOpenMenu?: (position: { x: number; y: number }) => void;
  style?: CSSProperties | undefined;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleExpand: () => void;
  onKill: () => void;
  onMerge: () => Promise<unknown>;
  onSteer: (text: string) => Promise<unknown>;
}

export function workerModel(worker: FleetWorker): string | null {
  return (
    worker.model ??
    (worker.swarm ? formatSwarmModel(worker.swarm.provider, worker.swarm.modelLabel) : null) ??
    null
  );
}

/** The pane id and model, for hints and the strip (the title bar shows `Name · model`). */
export function workerModelLine(worker: FleetWorker): string {
  const model = workerModel(worker) ?? AGENTS_BY_ID[worker.agent]?.label ?? worker.agent;
  return [worker.paneId, model, worker.account].filter(Boolean).join(" · ");
}

export const WorkerBox = memo(function WorkerBox(props: WorkerBoxProps) {
  const { worker, threadRef } = props;
  const variant: PaneVariant = props.variant ?? "box";
  const isWindow = variant === "window";
  const identity = agentIdentity(worker.agent);
  const pill = workerStatePill(worker);
  const gui = worker.surface === "gui";
  const asleep = worker.state === "asleep";
  const exited = worker.state === "exited";
  const { items, loading } = useWorkerFeed(threadRef, worker);

  // Box: a swarm pane's GUI box can flip to its terminal and back (the feed is the default).
  // Window: tabs (Activity · Terminal where a PTY exists · Report · Transcript).
  const [preferTerminal, setPreferTerminal] = useState(false);
  const canToggleTerminal = !isWindow && workerHasTerminalToggle(worker);
  const tabs = useMemo(() => (isWindow ? workerWindowTabs(worker) : []), [isWindow, worker]);
  const [tabChoice, setTabChoice] = useState<WindowTab>("activity");
  const tab: WindowTab = tabs.includes(tabChoice) ? tabChoice : "activity";
  const mode = isWindow
    ? tab === "terminal"
      ? "terminal"
      : tab === "transcript"
        ? "history"
        : workerBodyMode(worker, false)
    : workerBodyMode(worker, preferTerminal);
  const [boxReportOpen, setBoxReportOpen] = useState(false);
  const reportOpen = isWindow ? tab === "report" : boxReportOpen;
  const openReport = useCallback(
    () => (isWindow ? setTabChoice("report") : setBoxReportOpen(true)),
    [isWindow],
  );
  const closeReport = useCallback(
    () => (isWindow ? setTabChoice("activity") : setBoxReportOpen(false)),
    [isWindow],
  );

  const runRespond = useAtomAction(fleetHost.respondApproval, { reportFailure: true });
  const onRespond = useCallback(
    async (requestId: string, decision: FleetRespondApprovalInput["decision"]) => {
      await runRespond({
        hostId: threadRef.hostId,
        input: { threadId: threadRef.threadId, paneId: worker.paneId, requestId, decision },
      });
    },
    [runRespond, threadRef.hostId, threadRef.threadId, worker.paneId],
  );

  // Red light: the first click arms "Stop?", the second stops (fleet.kill).
  const [stopArmed, setStopArmed] = useState(false);
  useEffect(() => {
    if (!stopArmed) return;
    const t = window.setTimeout(() => setStopArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [stopArmed]);
  const { onKill, onMinimize, onToggleExpand } = props;
  const onLight = useCallback(
    (act: LightAct) => {
      if (act === "minimize") return onMinimize();
      if (act === "zoom") return onToggleExpand();
      if (!stopArmed) return setStopArmed(true);
      setStopArmed(false);
      onKill();
    },
    [onKill, onMinimize, onToggleExpand, stopArmed],
  );
  const lights = trafficLights(worker, {
    variant,
    zoomed: props.expanded,
    stopArmed,
  });

  const httpBaseUrl = useHostHttpBaseUrl(threadRef.hostId);
  const availableEditors = useAtomValue(primaryDaemonAvailableEditorsAtom);
  const openInEditor = useOpenInEditor(threadRef.hostId, availableEditors);
  const worktreePath = worker.worktree?.path ?? null;
  const onOpenWorktree = useMemo(
    () => (worktreePath && !worker.branchMerged ? () => void openInEditor(worktreePath) : null),
    [openInEditor, worktreePath, worker.branchMerged],
  );

  // Steer / Wake
  const [steerText, setSteerText] = useState("");
  const [sending, setSending] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const submitSteer = useCallback(async () => {
    const text = steerText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await props.onSteer(text);
      if ((r as { readonly _tag?: string } | undefined)?._tag !== "Failure") setSteerText("");
    } finally {
      setSending(false);
    }
  }, [props, sending, steerText]);
  const onSteerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if ((event.key === "Enter" || event.code === "Enter") && !event.shiftKey) {
        event.preventDefault();
        void submitSteer();
      }
    },
    [submitSteer],
  );
  const wake = useCallback(async () => {
    if (!httpBaseUrl || !worker.recordId) return;
    setWaking(true);
    try {
      setWakeError(await wakeWorkerRecord(httpBaseUrl, worker.recordId));
    } finally {
      setWaking(false);
    }
  }, [httpBaseUrl, worker.recordId]);

  // Open approvals are pinned above the steer box; the rest of the feed scrolls.
  const { feed, pinned } = useMemo(
    () => splitPinnedApprovals(items, worker.pendingApproval),
    [items, worker.pendingApproval],
  );
  const retrying = worker.retrying ?? null;
  const retryInFeed = retrying !== null && items.some((i) => i.kind === "error" && i.retry);
  // Only when there is something to merge: an empty branch would merge nothing or make an empty commit.
  const showMerge =
    !!worker.worktree &&
    !props.merged &&
    !worker.stoppedByUser &&
    hasSomethingToMerge(worker) &&
    (worker.state !== "working" || (worker.worktree.ahead ?? 0) > 0);
  // Stopped on an API error Kora's own retries did not get past: offer the way out.
  const stoppedOnError =
    worker.state === "idle" && !!worker.stoppedOnError && !retrying ? worker.stoppedOnError : null;
  const [retryingTurn, setRetryingTurn] = useState(false);
  const { onSteer } = props;
  const retryTurn = useCallback(() => {
    setRetryingTurn(true);
    void onSteer("continue").finally(() => setRetryingTurn(false));
  }, [onSteer]);
  const marker = exited ? finishedMarker(worker, props.merged) : null;
  const blockedInTerminal = worker.state === "blocked" && !!worker.blocker && mode === "terminal";
  const hasCards =
    (retrying && !retryInFeed) ||
    blockedInTerminal ||
    !!worker.swarm ||
    showMerge ||
    stoppedOnError !== null;
  const cards = hasCards ? (
    <>
      {stoppedOnError !== null ? (
        <div className="wb-card is-error" data-stopped-on-error="">
          <b>Stopped on error</b>
          <div className="sub">{stoppedOnError}</div>
          <div className="wb-btns">
            <button
              type="button"
              className="wb-btn is-primary"
              disabled={retryingTurn}
              onClick={retryTurn}
            >
              {retryingTurn ? "Retrying…" : "Retry"}
            </button>
            <button type="button" className="wb-btn" onClick={() => onLight("stop")}>
              {stopArmed ? "Click again to stop" : "Stop"}
            </button>
          </div>
        </div>
      ) : null}
      {retrying && !retryInFeed ? (
        <div className="wb-card is-error">
          <b>{retrying.message}</b>
          <RetryLine attempt={retrying.attempt} max={retrying.max} nextAt={retrying.nextAt} />
        </div>
      ) : null}
      {blockedInTerminal ? (
        <div className="wb-card">
          <b>Needs you</b>
          <div className="sub">{worker.blocker} — answer in the terminal, or steer below.</div>
        </div>
      ) : null}
      {worker.swarm ? (
        <SwarmCard worker={worker} threadRef={threadRef} onOpenReport={openReport} />
      ) : null}
      {showMerge ? (
        <MergeCard
          worker={worker}
          standing={props.standing}
          onMerge={props.onMerge}
          onOpenWorktree={onOpenWorktree}
        />
      ) : null}
    </>
  ) : null;

  const branch = worker.worktree ? shortBranch(worker.worktree.branch) : null;
  const cost = workerCostText(worker);
  const name = identity.name;
  const task = worker.title.trim() || name;
  // The window's title line: what it is doing (the box keeps `Name · model` and its state pill).
  const doing = useMemo(
    () => (isWindow ? workerDoingLine(worker, items) : null),
    [isWindow, worker, items],
  );
  const { onFocus } = props;

  return (
    <div
      className={cn(
        "wbox",
        `f-${identity.family}`,
        props.focused && "is-focused",
        pill.kind === "needs" && "is-attn",
        isWindow && "is-window",
      )}
      style={
        {
          ...props.style,
          "--wb-radius": `${identity.radius}px`,
          "--wb-brand": identity.brand,
        } as CSSProperties
      }
      data-worker-pane={worker.paneId}
      data-worker-surface={gui ? "gui" : "terminal"}
      data-worker-body={mode}
      data-agent={worker.agent}
      data-variant={variant}
      onMouseDown={onFocus}
    >
      <span className="wb-edge" data-brand-hue="" aria-hidden />
      <div className="whead" {...props.titlebarProps}>
        <TrafficLights lights={lights} armed={stopArmed} onAct={onLight} />
        {stopArmed ? (
          <button
            type="button"
            className="wb-stopconfirm"
            aria-label="Confirm stop"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onLight("stop")}
          >
            Stop?
          </button>
        ) : null}
        <AgentMark agent={worker.agent} size={18} />
        <div className="who">
          <Hint label={`${name} · ${task} · ${workerModelLine(worker)}`}>
            <b>{task}</b>
          </Hint>
          {isWindow ? (
            <small data-doing="" data-tone={doing?.tone ?? undefined}>
              {doing?.text}
            </small>
          ) : (
            <small>{workerSubline(worker, workerModel(worker))}</small>
          )}
        </div>
        <div className="ctl">
          {canToggleTerminal ? (
            <Hint label={mode === "terminal" ? "Show the feed" : "Show the terminal"}>
              <button
                type="button"
                aria-label={mode === "terminal" ? "Show the feed" : "Show the terminal"}
                aria-pressed={mode === "terminal"}
                data-terminal-toggle=""
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setPreferTerminal((v) => !v)}
              >
                {mode === "terminal" ? (
                  <MessageSquareTextIcon className="size-3.5" aria-hidden />
                ) : (
                  <SquareTerminalIcon className="size-3.5" aria-hidden />
                )}
              </button>
            </Hint>
          ) : null}
          {props.onOpenMenu ? (
            <button
              type="button"
              aria-label="Worker actions"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => props.onOpenMenu?.({ x: event.clientX, y: event.clientY })}
            >
              <EllipsisIcon className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
        {isWindow ? null : <StatePill pill={pill} />}
      </div>

      {isWindow && tabs.length > 1 ? (
        <div className="wtabs" role="tablist" aria-label="Worker views">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              data-tab={t}
              onClick={() => setTabChoice(t)}
            >
              {TAB_LABEL[t]}
              {t === "report" && worker.swarm?.report
                ? ` · ${formatReportBytes(worker.swarm.report.bytes)}`
                : ""}
            </button>
          ))}
        </div>
      ) : null}

      <div className="wb-bodywrap">
        {mode === "history" ? (
          <>
            <WorkerHistoryView threadRef={threadRef} worker={worker} className="min-h-0 flex-1" />
            {cards && tab !== "transcript" ? <div className="wb-cards">{cards}</div> : null}
          </>
        ) : mode === "feed" ? (
          <WorkerFeed
            worker={worker}
            threadRef={threadRef}
            items={feed}
            loading={loading}
            working={pill.kind === "working"}
            cards={cards}
            execBlocks={identity.family === "codex"}
            onRespond={onRespond}
          />
        ) : (
          <>
            <WorkerTerminal
              worker={worker}
              threadRef={threadRef}
              visible={props.visible}
              focused={props.focused}
              resizeEpoch={props.resizeEpoch}
              advancedTypography={props.advancedTypography}
              onFocus={onFocus}
            />
            {cards ? <div className="wb-cards">{cards}</div> : null}
          </>
        )}
        {reportOpen && worker.swarm ? (
          <SwarmReportView threadRef={threadRef} paneId={worker.paneId} onClose={closeReport} />
        ) : null}
      </div>

      {pinned.length > 0 && !exited && !asleep ? (
        <div className="wb-pinned" data-pinned-approvals={pinned.length}>
          {pinned.map((a) => (
            <ApprovalCard
              key={a.requestId}
              requestId={a.requestId}
              title={a.title}
              detail={a.detail}
              status="open"
              onRespond={onRespond}
            />
          ))}
        </div>
      ) : null}

      <div className="wsub">
        {branch ? (
          <Hint label={worker.worktree?.path}>
            <span className="wb-branch">
              ⑂ {branch}
              {worker.worktree?.ahead ? ` ↑${worker.worktree.ahead}` : ""}
              {worker.worktree?.dirty ? ` · ${worker.worktree.dirty} dirty` : ""}
            </span>
          </Hint>
        ) : (
          <span>shared checkout</span>
        )}
        {props.merged ? <span className="t-ok">merged</span> : null}
        {!props.merged && props.standing && props.standing.status !== "clean" ? (
          <span className="t-bad">
            {props.standing.status === "semantic" ? "conflicts" : "check"} ·{" "}
            {props.standing.with.join(", ")}
          </span>
        ) : null}
        {worker.steered ? <span className="t-text">steered</span> : null}
        {worker.contextPct !== null ? <span>ctx {worker.contextPct}%</span> : null}
        {cost ? <span>{cost}</span> : null}
        <span className="grow" />
        <Elapsed worker={worker} visible={props.visible} />
      </div>

      {asleep ? (
        <div className="wsteer">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--wb-dim)]">
            {wakeError ?? `${name} is asleep — its work is kept.`}
          </span>
          {worker.recordId && worker.asleep?.canResume !== false ? (
            <button
              type="button"
              className="wb-btn is-primary"
              disabled={waking || !httpBaseUrl}
              onClick={() => void wake()}
            >
              {waking ? "Waking…" : "Wake"}
            </button>
          ) : null}
        </div>
      ) : exited ? (
        <div className="wsteer is-off" data-finished={marker?.tone}>
          {marker?.result ?? "Exited"}
          {worker.exitCode !== null && worker.exitCode !== 0 ? ` · code ${worker.exitCode}` : ""}
          {marker && worker.worktree && !props.merged && marker.tone !== "done"
            ? " · branch kept"
            : ""}
        </div>
      ) : (
        <form
          className="wsteer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitSteer();
          }}
        >
          <input
            value={steerText}
            onChange={(event) => setSteerText(event.target.value)}
            onKeyDown={onSteerKeyDown}
            placeholder={
              pill.kind === "needs" && pinned.length === 0 ? `Answer ${name}…` : `Steer ${name}…`
            }
            aria-label={`Steer worker ${worker.paneId}`}
          />
          <button
            type="submit"
            className="send"
            disabled={!steerText.trim() || sending}
            aria-label="Send to worker"
          >
            {sending ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <ArrowUpIcon className="size-3.5" aria-hidden />
            )}
          </button>
        </form>
      )}
    </div>
  );
});

// ── the shelf chip (a minimized pane) ───────────────────────────────────────────────────────────────────────

export const WorkerStrip = memo(function WorkerStrip(props: {
  worker: FleetWorker;
  threadRef: HostThreadRef;
  onRestore: () => void;
}) {
  const { worker } = props;
  const identity = agentIdentity(worker.agent);
  const { items } = useWorkerFeed(props.threadRef, worker);
  const task = worker.title.trim() || identity.name;
  const last = lastActionText(worker, items);
  return (
    <div
      className={cn("wb-strip", `f-${identity.family}`)}
      data-worker-strip={worker.paneId}
      role="button"
      tabIndex={0}
      onClick={props.onRestore}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onRestore();
        }
      }}
      aria-label={`Restore ${identity.name} · ${task}`}
      style={{ "--wb-brand": identity.brand } as CSSProperties}
    >
      <AgentMark agent={worker.agent} size={15} />
      <b>{task}</b>
      {last ? <span className="last">{last}</span> : null}
      <StatePill pill={workerStatePill(worker)} />
    </div>
  );
});
