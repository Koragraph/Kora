// A worker pane's chrome in the orchestrator's fleet panel: traffic lights, title, badges, state
// line and agent mark around a terminal viewport. Presentational only: no store, no transport —
// callers pass handlers in. Styles live in ./paneChrome.css, scoped under `.pane-scope`, so render
// panes inside <PaneScope>.
import { Hint } from "~/components/ui/hint";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AGENTS_BY_ID } from "./agents";
import { AgentIcon } from "./AgentIcon";
import "./paneChrome.css";

/** `waiting`: parked on something that resolves by itself (a swarm worker rate-limited or switching model). */
export type PaneChromeState = "running" | "idle" | "waiting" | "needs-you" | "exited";

const STATE_WORD: Record<PaneChromeState, string> = {
  running: "running",
  idle: "idle",
  waiting: "waiting",
  "needs-you": "needs you",
  exited: "exited",
};

/** Wraps panes in the `.pane-scope` so paneChrome.css (and its palette) applies. */
export function PaneScope({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div data-dark-surface="" className={className ? `pane-scope ${className}` : "pane-scope"}>
      {children}
    </div>
  );
}

export function PaneChrome({
  state,
  stateLabel,
  title,
  agentId,
  role,
  account,
  steered,
  focused,
  badge,
  onFocus,
  onClose,
  onMinimize,
  onZoom,
  onTitlebarPointerDown,
  titlebarTitle,
  children,
  footer,
}: {
  state: PaneChromeState;
  /** Overrides the state word (e.g. "rate-limited", "switching model…"); the state still drives the colour. */
  stateLabel?: string | null | undefined;
  title: string;
  agentId?: string | null | undefined;
  role?: "orchestrator" | "worker" | null | undefined;
  account?: string | null | undefined;
  steered?: boolean | undefined;
  focused?: boolean | undefined;
  /** Extra badge rendered after the title (the fleet panel puts the pane id there). */
  badge?: ReactNode | undefined;
  onFocus?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  onMinimize?: (() => void) | undefined;
  onZoom?: (() => void) | undefined;
  onTitlebarPointerDown?: ((e: ReactPointerEvent) => void) | undefined;
  titlebarTitle?: string | undefined;
  children: ReactNode;
  /** Optional row under the terminal (the fleet panel's steer line). */
  footer?: ReactNode | undefined;
}) {
  const agent = agentId ? AGENTS_BY_ID[agentId] : null;
  const wake = state === "needs-you";
  return (
    <div
      className={`pane${focused ? " focus" : ""}${wake ? " wake" : ""}${role === "orchestrator" ? " orch" : ""}${role === "worker" ? " worker" : ""}`}
      onMouseDown={onFocus}
    >
      <div
        className="titlebar"
        onPointerDown={(e) => {
          if (e.button === 0) onTitlebarPointerDown?.(e);
        }}
        {...(titlebarTitle ? { title: titlebarTitle } : {})}
      >
        {/* dots stop propagation so clicking one never starts a move-drag */}
        <div className="lights" onPointerDown={(e) => e.stopPropagation()}>
          {/* For a worker this STOPS it (fleet.kill; its branch is kept) — say so, and make it reachable. */}
          <Hint
            label={
              onClose
                ? role === "worker"
                  ? "Stop this worker (its branch is kept)"
                  : "close"
                : "close"
            }
          >
            <span
              className="light r"
              role={onClose ? "button" : undefined}
              aria-label={onClose ? (role === "worker" ? "Stop worker" : "Close") : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onClose?.();
              }}
            />
          </Hint>
          <Hint label="minimize">
            <span
              className="light y"
              onClick={(e) => {
                e.stopPropagation();
                onMinimize?.();
              }}
            />
          </Hint>
          <Hint label="zoom">
            <span
              className="light g"
              onClick={(e) => {
                e.stopPropagation();
                onZoom?.();
              }}
            />
          </Hint>
        </div>
        <span className="t-title">{title}</span>
        {badge}
        {role === "orchestrator" && (
          <Hint label="orchestrator — coordinates the fleet">
            <span className="fleet-badge orch">⧉ ORCH</span>
          </Hint>
        )}
        {role === "worker" && account && (
          <Hint label="credential account">
            <span className="fleet-badge acct">@{account}</span>
          </Hint>
        )}
        {steered && (
          <Hint label="you just steered this worker; the orchestrator was notified">
            <span className="fleet-badge steered">steered</span>
          </Hint>
        )}
        <div className="t-right">
          <span
            className={`state${state === "running" ? " running" : wake ? " wake" : state === "waiting" ? " waiting" : ""}`}
          >
            <span className="s-dot" />
            {stateLabel || STATE_WORD[state]}
          </span>
          {agent && (
            <span className="agent-mark" style={{ color: agent.color }}>
              <AgentIcon id={agent.id} size={20} />
            </span>
          )}
        </div>
      </div>
      <div className="term">{children}</div>
      {footer}
    </div>
  );
}
