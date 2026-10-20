import { cn } from "~/util/utils";
import type { WorkLogEntry } from "../../thread/timeline";
import { toolActivityFaviconUrl } from "@kora/shared/toolFavicon";
// Icons for the transcript's tool-activity rows: which glyph a work entry or a collapsed group gets, and the
// small components that draw it (Phosphor duotone glyphs, two custom tiles, and a favicon/logo image view).
import type { ToolTraceSurface, ToolTraceIcon } from "@kora/contracts";
import { activityRowToolLook, toolGroupAction } from "@kora/client-runtime/worklog/presentation";
import { type ReactNode, useEffect, useState, useId } from "react";
import {
  MagnifyingGlass,
  GitPullRequest,
  TerminalWindow,
  WarningCircle,
  DeviceMobile,
  ChatCircle,
  NotePencil,
  Sparkle,
  Wrench,
  Brain,
  Check,
  Globe,
  Robot,
  Plug,
  Eye,
  X,
} from "@phosphor-icons/react";

export type WorkIconName =
  | "message-circle"
  | "pull-request"
  | "circle-alert"
  | "square-pen"
  | "kora-code"
  | "terminal"
  | "computer"
  | "browser"
  | "wrench"
  | "search"
  | "hammer"
  | "device"
  | "globe"
  | "check"
  | "brain"
  | "zap"
  | "eye"
  | "bot"
  | "x";

/** A summary kind (or single-call action) names the glyph its group wears. */
const ICON_BY_SUMMARY_KIND: Readonly<Record<string, WorkIconName>> = {
  "pull-request": "pull-request",
  "link-pr": "pull-request",
  "unlink-pr": "pull-request",
  "list-prs": "pull-request",
  read: "eye",
  edit: "square-pen",
  command: "terminal",
  browser: "browser",
  device: "device",
  search: "globe",
  "code-search": "search",
  other: "wrench",
  "dynamic-tool": "hammer",
  "agent-tool": "bot",
  "tone-tool": "zap",
  update: "hammer",
  mixed: "hammer",
};

export function iconNameForSummaryKind(kind: string): WorkIconName {
  return ICON_BY_SUMMARY_KIND[kind] ?? "wrench";
}

export interface ResolvedEntryIcon {
  readonly name: WorkIconName;
  /** "muted" icons sit in the quiet icon tone; the rest follow the row's own foreground. */
  readonly tone: "foreground" | "muted";
}

export function resolveEntryIcon(entry: WorkLogEntry): ResolvedEntryIcon {
  if (
    entry.questionAnswer !== undefined ||
    entry.sourceActivityKind === "user-input.requested" ||
    entry.sourceActivityKind === "user-input.resolved"
  ) {
    return { name: "message-circle", tone: "foreground" };
  }
  if (entry.toolSurface !== undefined) return { name: entry.toolSurface, tone: "foreground" };

  const presented = activityRowToolLook(entry)?.icon;
  if (presented !== undefined) return { name: presented as WorkIconName, tone: "foreground" };

  const action = toolGroupAction(entry);
  if (action !== "other") return { name: iconNameForSummaryKind(action), tone: "foreground" };

  if (entry.itemType === "mcp_tool_call") return { name: "wrench", tone: "foreground" };
  if (entry.itemType === "dynamic_tool_call") return { name: "hammer", tone: "foreground" };
  if (entry.itemType === "collab_agent_tool_call") return { name: "bot", tone: "foreground" };
  if (entry.taskId !== undefined) return { name: "bot", tone: "foreground" };

  switch (entry.tone) {
    case "error":
      return { name: "circle-alert", tone: "foreground" };
    case "thinking":
      return { name: "brain", tone: "foreground" };
    case "info":
      return { name: "check", tone: "muted" };
    default:
      return { name: "zap", tone: "foreground" };
  }
}

/** Gradient and picture icons cannot take a colour tint, so a failed row marks them with a trailing X instead. */
export function iconTakesTint(name: WorkIconName, hasImage: boolean): boolean {
  return !hasImage && name !== "computer";
}

// ---------------------------------------------------------------------------
// Drawing

function BrowserGlyph({ className }: { className?: string }) {
  return (
    <svg
      strokeLinejoin="round"
      strokeLinecap="round"
      stroke="currentColor"
      className={className}
      viewBox="0 0 24 24"
      strokeWidth={1.9}
      fill="none"
      aria-hidden
    >
      <path d="M20 12V7.5A2.5 2.5 0 0 0 17.5 5h-11A2.5 2.5 0 0 0 4 7.5v9A2.5 2.5 0 0 0 6.5 19H12" />
      <circle cx={7.4} cy={7.2} r={0.75} fill="currentColor" stroke="none" />
      <path d="M11 7.2h5" />
      <path d="M14.6 13.6l6.2 2.5-2.7 1.1-1.1 2.7z" fill="currentColor" />
    </svg>
  );
}

function ComputerGlyph({ className }: { className?: string }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#00dff0" offset="0" />
          <stop stopColor="#3b9cff" offset="0.42" />
          <stop stopColor="#b044f5" offset="0.72" />
          <stop stopColor="#ff78b6" offset="1" />
        </linearGradient>
      </defs>
      <rect x={1} y={1} width={22} height={22} rx={5} fill={`url(#${gradientId})`} />
      <path
        d="M8.2 6.6l9 4.4-3.7 1.3-1.4 3.8z"
        fill="#fff"
        stroke="#315cff"
        strokeWidth={1.1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WorkGlyph({ name, className }: { name: WorkIconName; className?: string }) {
  const common = { weight: "duotone" as const, className, "aria-hidden": true };
  switch (name) {
    case "pull-request":
      return <GitPullRequest {...common} />;
    case "bot":
    case "kora-code":
      return <Robot {...common} />;
    case "brain":
      return <Brain {...common} />;
    case "browser":
      return <BrowserGlyph {...(className !== undefined ? { className } : {})} />;
    case "computer":
      return <ComputerGlyph {...(className !== undefined ? { className } : {})} />;
    case "device":
      return <DeviceMobile {...common} />;
    case "check":
      return <Check {...common} />;
    case "circle-alert":
      return <WarningCircle {...common} />;
    case "eye":
      return <Eye {...common} />;
    case "globe":
      return <Globe {...common} />;
    case "hammer":
      // Deliberate: tool calls read as a plug, not a hammer.
      return <Plug {...common} />;
    case "message-circle":
      return <ChatCircle {...common} />;
    case "search":
      return <MagnifyingGlass {...common} />;
    case "square-pen":
      return <NotePencil {...common} />;
    case "terminal":
      return <TerminalWindow {...common} />;
    case "wrench":
      return <Wrench {...common} />;
    case "x":
      return <X {...common} />;
    case "zap":
      // Deliberate: the generic tool glyph is a sparkle.
      return <Sparkle {...common} />;
  }
}

// ---------------------------------------------------------------------------
// Website favicons and themed logos

/** URLs that already loaded once; a remount shows them immediately instead of flashing the fallback glyph. */
const loadedIconUrls = new Set<string>();

export function resolveToolIconImageUrl(
  icon: ToolTraceIcon | undefined,
  theme: "light" | "dark",
): string | null {
  if (icon === undefined) return null;
  if (icon._tag === "website") return toolActivityFaviconUrl(icon, theme, 32);
  if (icon._tag === "themed-logo") {
    return theme === "dark" && icon.logoUrlDark ? icon.logoUrlDark : icon.logoUrl;
  }
  return null;
}

export function ToolIconImage(props: {
  readonly url: string;
  readonly muted: boolean;
  readonly fallback: ReactNode;
}) {
  const { url } = props;
  const [loaded, setLoaded] = useState(() => loadedIconUrls.has(url));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(loadedIconUrls.has(url));
    setFailed(false);
  }, [url]);

  return (
    <>
      {loaded && !failed ? null : props.fallback}
      {failed ? null : (
        <img
          src={url}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={() => {
            loadedIconUrls.add(url);
            setLoaded(true);
          }}
          onError={() => {
            loadedIconUrls.delete(url);
            setFailed(true);
          }}
          className={cn(
            "size-4 shrink-0 rounded-[3px] bg-background object-contain",
            props.muted && "opacity-70",
            !loaded && "pointer-events-none invisible absolute",
          )}
        />
      )}
    </>
  );
}

export type ToolSurfaceName = ToolTraceSurface;
