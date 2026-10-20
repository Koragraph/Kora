/**
 * Composer footer chip: two always-on facts about the active thread's repo, and the single
 * entry point to the Graph Explorer. LEFT-click opens the graph; RIGHT-click opens a menu
 * with the same open action plus Re-index and Copy-SHA (this menu is also the detail surface
 * a cramped pane would rely on). Left of the chip: code-graph FRESHNESS
 * (indexing / fresh / stale / none) from `GET /api/graph/status`. Right (worktree only): the
 * branch, since a worktree reads the MAIN checkout's graph plus branch-diff labels.
 */

import { Hint } from "~/components/ui/hint";
import { GraphNodesIcon, WorktreeIcon } from "./graphChipIcons";
import {
  MenuGroupLabel,
  Menu,
  MenuTrigger,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuPopup,
} from "../ui/menu";
import { openGraphExplorer } from "../graph/GraphExplorerOverlay";
import { cn, thisComputer, folderAccessHint } from "../../util/utils";
import { requestIndex } from "../onboarding/projectSetup";
import { toastManager } from "../ui/toast";
import { useGraphFreshness, type GraphFreshness } from "../../hooks/useGraphFreshness";
import { useActiveProjectTarget } from "../../hooks/useCurrentProjectTarget";
import { useHostHttpBaseUrl } from "../../atoms/hosts";
import { useThreadSummary } from "../../atoms/entities";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon, CopyIcon, Settings2Icon, ChevronDownIcon } from "lucide-react";

type State =
  | "indexing"
  | "loading"
  | "none"
  | "fresh"
  | "stale"
  | "moved"
  | "incomplete"
  | "missing"
  | "unreadable"
  | "damaged";

function classify(f: GraphFreshness | null): State {
  if (f === null) return "loading";
  if (f.folderMissing) return "missing";
  if (f.folderUnreadable) return "unreadable";
  if (f.indexing) return "indexing";
  if (f.storeDamaged) return "damaged";
  if (f.incomplete) return "incomplete";
  if (!f.indexed) return "none";
  // Built from another folder: Kora never re-indexes this on its own (a first index of this checkout is a click).
  if (f.indexedFrom) return "moved";
  return f.stale ? "stale" : "fresh";
}

export const GRAPH_CHIP_GLYPH_COLOR: Record<State, string> = {
  indexing: "text-muted-foreground",
  fresh: "text-emerald-500 dark:text-emerald-400",
  // Behind HEAD is routine (a commit, a merge) and catches up on its own: a neutral tone, never a warning hue.
  stale: "text-muted-foreground",
  // An index from another folder: act on it (amber), like an incomplete one.
  moved: "text-amber-500 dark:text-amber-400",
  // Not indexed is a choice to make, not a fault: neutral grey, never a status hue.
  none: "text-muted-foreground",
  // The index died part-way (amber: act on it) / the project's folder is gone (red: nothing here can work).
  incomplete: "text-amber-500 dark:text-amber-400",
  missing: "text-red-500 dark:text-red-400",
  unreadable: "text-red-500 dark:text-red-400",
  damaged: "text-red-500 dark:text-red-400",
  loading: "text-muted-foreground/40",
};

/** "Not indexed" with nothing to offer: a home/system folder or a bare repo is never indexed from the chip. */
function noIndexOffer(f: GraphFreshness | null): boolean {
  return !!(f?.systemFolder || f?.bareRepo);
}

function label(state: State, f: GraphFreshness | null): string {
  // A failed index the user asked for: say so instead of re-offering "Index" as if nothing happened.
  if ((state === "none" || state === "incomplete") && f?.ingestError) return "Index failed · Retry";
  // No "· Index?" where the menu has no Index item: the chip must not invite a click that does nothing.
  if (state === "none" && noIndexOffer(f)) return "No code graph";
  // A git repo that is safe to index offers the action itself; anything else just says it is not indexed.
  if (state === "none") return f?.safeToIndex ? "Index this repo" : "Not indexed";
  if (state === "indexing") {
    // All files are read but the store is still linking edges — minutes on a big repo. "Indexing 100%" reads as hung.
    if (f?.indexing?.finalizing) return "Finalizing…";
    // An index that already exists catching up (after a commit or a merge): an update, not a first index.
    if (f?.indexed) return "Updating…";
    const pct = f?.indexing?.pct;
    return pct != null ? `Indexing ${pct}%` : "Indexing…";
  }
  return {
    fresh: "Indexed",
    stale: "Out of date",
    moved: "Index moved — re-index?",
    none: "Not indexed",
    incomplete: "Incomplete · Re-index",
    missing: "Folder missing",
    unreadable: "Can't read folder",
    damaged: "Graph store damaged · Rebuild",
    loading: "Graph",
  }[state];
}

function detailLine(state: State, f: GraphFreshness | null): string {
  if (state === "loading" || f === null) return "Code index — click to open";
  const failed = f.ingestError ? ` The last index failed: ${f.ingestError.message}` : "";
  return detailBase(state, f) + failed;
}

function detailBase(state: State, f: GraphFreshness): string {
  if (state === "indexing")
    return f.indexing?.finalizing
      ? "Every file is read; the graph is linking calls and imports across the repo. This can take a few minutes on a large repo."
      : `Indexing this repo on ${thisComputer()}. You can keep chatting; answers use the index once it is done.`;
  if (state === "unreadable")
    return `Kora can't read ${f.indexRoot ?? "this project's folder"} (permission denied). ${folderAccessHint()}`;
  if (state === "missing")
    return `${f.indexRoot ?? "This project's folder"} no longer exists (moved, renamed or deleted). Remove the project in Project settings, then open the folder from its new place.`;
  if (state === "damaged")
    return `The code graph store on ${thisComputer()} is damaged and cannot be read. Rebuild moves the damaged file aside and indexes this repo again; other repos need indexing again too.`;
  if (state === "moved")
    return `This index was built from ${f.indexedFrom}, not ${f.indexRoot ?? "this folder"}, so some file:line answers may not fit this checkout. Kora does not re-index it on its own: re-index to rebuild it here.`;
  if (state === "incomplete")
    return "The last full index of this repo did not finish, so the graph holds only part of it. Re-index to rebuild it.";
  if (state === "none") {
    const where = f.indexRoot ? ` ${f.indexRoot}` : "";
    if (f.bareRepo)
      return `No code graph —${where} is a bare git repository: it holds history but no working files. Open a checkout of it (git clone) to get a code graph.`;
    if (f.systemFolder)
      return `Not indexed —${where} is a home or system folder, which Kora never indexes. Open a project folder to get a code graph.`;
    if (!f.isGitRepo)
      return `Not indexed —${where} is not a git repo. Indexing a plain folder can be slow.`;
    return `Not indexed —${where}. Indexing builds a local map of the code (it stays on ${thisComputer()}), so Claude looks things up instead of re-reading files.`;
  }
  const files = `${f.files.toLocaleString()} ${f.files === 1 ? "file" : "files"}`;
  const sha = f.indexedSha ? ` · at commit ${f.indexedSha.slice(0, 7)}` : "";
  if (state === "stale") {
    const head = f.headSha ? ` (now ${f.headSha.slice(0, 7)})` : "";
    return `Out of date${sha}${head}: it catches up when you send your next message · ${files}`;
  }
  return `Indexed${sha} · ${files}. Claude looks code up here instead of re-reading files. Click to explore it.`;
}

/** `header`: the compact form beside the project name in the top bar (menu opens downward). */
export function GraphStatusChip(props: { placement?: "header" | "composer" } = {}) {
  const inHeader = props.placement === "header";
  const target = useActiveProjectTarget();
  const shell = useThreadSummary(target?.threadRef ?? null);
  const httpBaseUrl = useHostHttpBaseUrl(target?.hostId ?? null);
  const cwd = target?.cwd ?? null;
  const { freshness, refetch } = useGraphFreshness(httpBaseUrl, cwd);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();

  if (!target) return null;

  const state = classify(freshness);
  const worktreePath = shell?.worktreePath?.trim() || null;
  const branch = shell?.branch?.trim() || null;
  const detail = detailLine(state, freshness);

  // The chat never starts a first index on its own (a chat opened in ~ would otherwise start a whole-home ingest):
  // this chip is how it starts from a thread. Opening a project never starts one either (user rule): every first
  // index is an explicit click here, on the chat's index line, or `kora ingest`.
  const safe = freshness?.safeToIndex ?? false;
  const reindex = async (force = false, full = false) => {
    if (!httpBaseUrl || !cwd) return;
    const res = await requestIndex(httpBaseUrl, cwd, { force, full });
    if (!res.ok) {
      toastManager.add({
        type: "error",
        title: "Couldn't start indexing",
        description: res.reason,
        actionProps: { children: "Retry", onClick: () => void reindex(force, full) },
      });
      return;
    }
    // Surface the "Indexing…" state promptly rather than waiting for the slow poll.
    window.setTimeout(refetch, 800);
    window.setTimeout(refetch, 2500);
  };

  const copySha = () => {
    if (freshness?.indexedSha) {
      try {
        void navigator.clipboard?.writeText(freshness.indexedSha);
      } catch {
        /* clipboard unavailable */
      }
    }
  };

  return (
    <Menu
      open={menuOpen}
      // The chip is a Menu trigger only so the popup anchors to it. A plain LEFT-click must
      // open the GRAPH, never the menu, so redirect base-ui's open request; the menu is opened
      // deliberately from the button's onContextMenu below.
      onOpenChange={(next) => {
        if (next) {
          // Nothing to explore yet: a left-click on an un-indexed chip asks to index instead.
          if (
            state === "none" ||
            state === "incomplete" ||
            state === "moved" ||
            state === "missing" ||
            state === "unreadable" ||
            state === "damaged"
          )
            setMenuOpen(true);
          else openGraphExplorer();
          return;
        }
        setMenuOpen(false);
      }}
    >
      {/* One pill, two parts: the chip opens the graph (or asks to index), the caret opens the actions. */}
      <span
        className={cn(
          "inline-flex items-stretch overflow-hidden rounded-full border border-border/60 bg-background/60",
          inHeader ? "h-6 [-webkit-app-region:no-drag]" : "h-7",
        )}
      >
        <Hint label={detail}>
          <MenuTrigger
            render={
              <button
                type="button"
                data-testid="graph-status-chip"
                data-graph-freshness={state}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                    e.preventDefault();
                    setMenuOpen(true);
                  }
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-l-full",
                  inHeader ? "pr-1.5 pl-2" : "pr-2 pl-2.5",
                  "text-xs font-medium text-foreground/80 transition-colors outline-none",
                  "hover:bg-accent hover:text-accent-foreground",
                  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                )}
              />
            }
          >
            <GraphNodesIcon
              className={cn(
                "size-3.5 shrink-0",
                GRAPH_CHIP_GLYPH_COLOR[state],
                state === "indexing" && "animate-pulse",
              )}
            />
            <span>{label(state, freshness)}</span>
            {worktreePath ? (
              <span className="flex items-center gap-1 border-l border-border/50 pl-1.5 text-muted-foreground">
                <WorktreeIcon className="size-3 shrink-0" />
                <span className="max-w-[7rem] truncate">{branch ?? "worktree"}</span>
              </span>
            ) : null}
          </MenuTrigger>
        </Hint>
        <button
          type="button"
          aria-label="Graph actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid="graph-status-chip-menu"
          onClick={() => setMenuOpen(true)}
          className={cn(
            "inline-flex items-center rounded-r-full border-l border-border/50 px-1 text-muted-foreground transition-colors outline-none",
            "hover:bg-accent hover:text-accent-foreground",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          )}
        >
          <ChevronDownIcon aria-hidden className="size-3" />
        </button>
      </span>

      <MenuPopup
        align={inHeader ? "center" : "start"}
        side={inHeader ? "bottom" : "top"}
        className="w-72"
      >
        {/* base-ui throws (and blanks the app) if a group label renders outside a MenuGroup. */}
        <MenuGroup>
          <MenuGroupLabel className="whitespace-normal text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">
            {detail}
          </MenuGroupLabel>
          {worktreePath ? (
            <MenuGroupLabel className="whitespace-normal text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">
              Worktree: {worktreePath}
              {branch ? ` (${branch})` : ""}
            </MenuGroupLabel>
          ) : null}
        </MenuGroup>
        {/* No dangling separator above an empty action list (a home/system folder, a bare repo, a missing folder). */}
        {((state === "none" && noIndexOffer(freshness)) || state === "unreadable") &&
        !freshness?.indexedSha ? null : (
          <MenuSeparator />
        )}
        {state === "none" && noIndexOffer(freshness) ? null : state === "none" ? (
          <MenuItem onClick={() => void reindex(!safe)}>
            <GraphNodesIcon className="size-3.5" />
            {safe ? "Index this repo" : "Index anyway"}
          </MenuItem>
        ) : state === "missing" ? (
          // The detail sends you to Project settings: that is where the project is removed.
          <MenuItem
            onClick={() =>
              void navigate({
                to: "/projects/$projectKey",
                params: { projectKey: `${target.hostId}:${target.projectId}` },
              })
            }
          >
            <Settings2Icon className="size-3.5" />
            Project settings
          </MenuItem>
        ) : state === "unreadable" ? null : state === "damaged" ? (
          <MenuItem onClick={() => void reindex(!safe)}>
            <RefreshCwIcon className="size-3.5" />
            Rebuild the graph
          </MenuItem>
        ) : state === "moved" ? (
          <MenuItem onClick={() => void reindex(!safe, true)}>
            <RefreshCwIcon className="size-3.5" />
            Re-index this checkout
          </MenuItem>
        ) : state === "incomplete" ? (
          <MenuItem onClick={() => void reindex(!safe)}>
            <RefreshCwIcon className="size-3.5" />
            Re-index now
          </MenuItem>
        ) : (
          <>
            <MenuItem onClick={() => openGraphExplorer()}>
              <GraphNodesIcon className="size-3.5" />
              Open graph
            </MenuItem>
            <MenuItem onClick={() => void reindex()} disabled={state === "indexing"}>
              <RefreshCwIcon className={cn("size-3.5", state === "indexing" && "animate-spin")} />
              {state === "indexing" ? "Indexing…" : "Re-index now"}
            </MenuItem>
            <MenuItem onClick={() => void reindex(false, true)} disabled={state === "indexing"}>
              <RefreshCwIcon className="size-3.5" />
              Full re-index (re-read every file)
            </MenuItem>
          </>
        )}
        {freshness?.indexedSha ? (
          <MenuItem onClick={copySha}>
            <CopyIcon className="size-3.5" />
            Copy indexed SHA
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
