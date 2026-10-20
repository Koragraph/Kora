import {
  classifyGraphFailure,
  hoverCardPosition,
  type GraphLoadStatus,
  graphStatusLine,
} from "./GraphExplorerOverlay.logic";
import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import { cn } from "../../util/utils";
import { type ForceGraphController, createForceGraph, type FGNode } from "../../util/forceGraph";
import { fetchPrimaryHost } from "../../hosts/primary/shellAuth";
import { useActiveProjectTarget } from "../../hooks/useCurrentProjectTarget";
import { useHostHttpBaseUrl, usePrimaryHostId } from "../../atoms/hosts";
import { useProjects } from "../../atoms/entities";
import { useEffect, useState, useRef, useId, useCallback, useMemo } from "react";
import type { RepoReport } from "@kora/shared/repoReport";
import { RepoReportOverview, Tip, downloadText, reportMarkdown } from "./RepoReportOverview";
import { requestGraphAsk, requestOpenFile } from "./repoReportBridge";
import {
  REPORT_FILENAME,
  areaColouringUsable,
  areaLegend,
  areaNameOf,
  locationOf,
  nodeIdsInArea,
  routeQuestion,
  toneForFile,
  toneToGrey,
} from "./repoReportView";

interface GraphSnapshot {
  readonly repo: string;
  readonly branch: string;
  readonly nodes: ReadonlyArray<FGNode>;
  readonly edges: ReadonlyArray<{
    source: number;
    target: number;
    kind: string;
  }>;
  readonly clusters: ReadonlyArray<{ name: string; count: number }>;
  readonly stats: {
    totalNodes: number;
    totalEdges: number;
    shownNodes: number;
    shownEdges: number;
  };
}

// The composer's graph chip is now the single trigger (the old floating button is retired).
// It opens the panel through this event so the chip doesn't need to own the panel's state.
const GRAPH_OPEN_EVENT = "kora:graph-explorer-open";
export function openGraphExplorer(): void {
  try {
    window.dispatchEvent(new CustomEvent(GRAPH_OPEN_EVENT));
  } catch {
    /* ignore — SSR / no window */
  }
}

type Tab = "overview" | "graph";

type HoverInfo = (FGNode & { left: number; top: number }) | null;

/**
 * In-chat Graph Explorer — a force-directed picture of the indexed repo's code
 * graph, the same graph that lets agents skip file reads (the token-savings story).
 * A floating button opens a right-docked panel; the daemon serves the subgraph over
 * `GET /api/graph` (see apps/ui-server/src/graph.ts). Self-contained: one canvas, one
 * dependency-free force sim that settles then freezes (no continuous repaint).
 */
export function GraphExplorerOverlay() {
  // Always starts closed: restored open on launch, it covered the composer before the user asked for it.
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<GraphSnapshot | null>(null);
  const [status, setStatus] = useState<GraphLoadStatus>("idle");
  const [reloadKey, setReloadKey] = useState(0);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [selected, setSelected] = useState<FGNode | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [report, setReport] = useState<RepoReport | null>(null);
  const [reportStatus, setReportStatus] = useState<GraphLoadStatus>("idle");
  const [reportKey, setReportKey] = useState(0);
  const [litArea, setLitArea] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();

  // Scope the graph to the repo the user is actually in right now — the active
  // thread's project (its worktree, or the project root) — falling back to the
  // first project when there's no active thread (e.g. the empty state).
  const activeTarget = useActiveProjectTarget();
  const primaryEnvId = usePrimaryHostId();
  const projects = useProjects();
  const envId = activeTarget?.hostId ?? primaryEnvId;
  const httpBaseUrl = useHostHttpBaseUrl(envId);
  const cwd = activeTarget?.cwd ?? projects[0]?.workspaceRoot ?? null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<ForceGraphController | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  // Where focus was when the panel opened, so closing it hands focus back (the composer chip).
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Escape closes it, like any other panel over the chat.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Open when the composer's graph chip fires the shared event (it's the only trigger now).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(GRAPH_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(GRAPH_OPEN_EVENT, onOpen);
  }, []);

  // Focus moves into the panel when it opens and back to the trigger when it closes. A panel
  // restored open on launch has no trigger to return to, so it leaves focus alone.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      returnFocusRef.current = active;
      closeButtonRef.current?.focus({ preventScroll: true });
    }
    return () => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open]);

  // The report is fetched once per open (and again on Try again); the same base URL, auth and failure copy as the graph.
  useEffect(() => {
    if (!open || httpBaseUrl === null) return;
    let cancelled = false;
    setReportStatus("loading");
    const url = new URL("/api/graph/report", httpBaseUrl);
    if (cwd) url.searchParams.set("cwd", cwd);
    fetchPrimaryHost(url.toString())
      .then(async (r) => {
        if (!r.ok) throw new GraphFetchError(r.status);
        return (await r.json()) as RepoReport;
      })
      .then((json) => {
        if (cancelled) return;
        setReport(json);
        setReportStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setReport(null);
        setReportStatus(
          classifyGraphFailure(error instanceof GraphFetchError ? error.status : null),
        );
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reportKey is the Try again trigger.
  }, [open, httpBaseUrl, cwd, reportKey]);

  // The picture is only drawn on the Graph tab, so its snapshot is fetched the first time that tab is shown.
  const graphWanted = tab === "graph";
  // Fetch the subgraph when the Graph tab is shown (and whenever the base/cwd change).
  useEffect(() => {
    if (!open || !graphWanted || httpBaseUrl === null) return;
    let cancelled = false;
    setStatus("loading");
    setSelected(null);
    setHover(null);
    const url = new URL("/api/graph", httpBaseUrl);
    if (cwd) url.searchParams.set("cwd", cwd);
    url.searchParams.set("limit", "0"); // 0 = the full graph (daemon caps at MAX_NODES)
    fetchPrimaryHost(url.toString())
      .then(async (r) => {
        if (!r.ok) throw new GraphFetchError(r.status);
        return (await r.json()) as GraphSnapshot;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setStatus(classifyGraphFailure(error instanceof GraphFetchError ? error.status : null));
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reloadKey is the Try again trigger.
  }, [open, graphWanted, httpBaseUrl, cwd, reloadKey]);

  const legend = useMemo(() => (report ? areaLegend(report) : []), [report]);
  const useAreas = useMemo(() => areaColouringUsable(report, data?.nodes ?? []), [report, data]);

  // Build / tear down the force graph when data, open-state or the visible tab changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || tab !== "graph" || status !== "ready" || data === null || canvas === null) return;
    const controller = createForceGraph(
      canvas,
      { nodes: data.nodes, edges: data.edges },
      {
        onHover: (node) =>
          setHover(
            node === null ? null : { ...node, ...hoverCardPosition(node, canvas.clientWidth) },
          ),
        onSelect: (node) => setSelected(node),
        ...(useAreas && report
          ? { toneOf: (node: FGNode) => toneForFile(report, legend, node.file) }
          : {}),
      },
    );
    controllerRef.current = controller;
    const onResize = () => controller.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      controller.destroy();
      controllerRef.current = null;
    };
  }, [open, tab, status, data, useAreas, report, legend]);

  // Light one area (the Overview's "Show in graph", or a legend click); null clears it.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.emphasize(
      litArea && report && data ? nodeIdsInArea(report, litArea, data.nodes) : null,
    );
  }, [litArea, report, data, tab, status]);

  const areaOfFile = useCallback(
    (file: string): string | null =>
      useAreas && report ? areaNameOf(report, report.fileAreas[file] ?? null) || null : null,
    [useAreas, report],
  );

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((m) => (m === message ? null : m)), 2600);
  }, []);

  const copyText = useCallback(
    async (text: string, message: string) => {
      try {
        await navigator.clipboard.writeText(text);
        flash(message);
      } catch {
        flash("Couldn’t copy");
      }
    },
    [flash],
  );

  const onOpenRef = useCallback(
    (ref: { file: string; line: number | null }) => {
      // The overlay covers the dock, so step aside once the viewer has taken the file.
      if (requestOpenFile(ref)) setOpen(false);
      else void copyText(locationOf(ref), `Copied ${locationOf(ref)}`);
    },
    [copyText],
  );

  const onAsk = useCallback(
    (question: RepoReport["questions"][number]) => {
      // Never sends a turn: the thread either answers from the graph or puts the text in its composer.
      const { handled, placed } = requestGraphAsk({
        question,
        route: routeQuestion(question, true),
      });
      if (!handled) void copyText(question.text, "No open thread: question copied");
      else
        flash(
          placed === "composer" || question.kind === "explore"
            ? "Added to the composer"
            : "Asking the graph…",
        );
    },
    [copyText, flash],
  );

  const onCopyMarkdown = useCallback(() => {
    if (!report) return;
    void copyText(reportMarkdown(report), "Copied Markdown").then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  }, [copyText, report]);

  const onDownloadMarkdown = useCallback(() => {
    if (report) downloadText(REPORT_FILENAME, reportMarkdown(report));
  }, [report]);

  const showInGraph = useCallback((areaId: string) => {
    setLitArea(areaId);
    setTab("graph");
  }, []);

  const statusLine =
    tab === "graph"
      ? graphStatusLine(status, data?.stats ?? null)
      : graphStatusLine(reportStatus, null) === "Code graph"
        ? "Code map"
        : graphStatusLine(reportStatus, null);
  const headerRepo = report?.repo ?? data?.repo ?? null;
  const headerBranch = report?.branch ?? data?.branch ?? null;

  return (
    <>
      {/* The trigger now lives in the composer footer (GraphStatusChip), which shows
          freshness + worktree state and opens this panel via GRAPH_OPEN_EVENT. */}
      {open ? (
        <aside
          aria-labelledby={titleId}
          // The canvas is a night-sky picture in either appearance; the panel's chrome
          // takes the matching dark palette so its text keeps contrast in light mode too.
          data-dark-surface=""
          data-slot="graph-explorer"
          className={cn(
            // Start BELOW the app's window controls (which sit at z-50 across the
            // top bar) so the close button never lands underneath them and stays clickable.
            "fixed right-0 bottom-0 top-[var(--workspace-topbar-height,52px)] z-40 flex w-[min(560px,92vw)] flex-col",
            "border-l border-t bg-background text-foreground",
          )}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="flex items-center gap-2 text-sm font-semibold text-foreground"
              >
                <GraphGlyph />
                <span className="truncate">
                  {headerRepo ?? "Code graph"}
                  {headerBranch ? (
                    <span className="text-muted-foreground"> · {headerBranch}</span>
                  ) : null}
                </span>
              </h2>
              <p role="status" className="mt-0.5 text-xs text-muted-foreground">
                {statusLine}
              </p>
            </div>
            <Button
              ref={closeButtonRef}
              size="icon-sm"
              variant="ghost-muted"
              onClick={() => setOpen(false)}
              aria-label="Close graph"
            >
              <CloseGlyph />
            </Button>
          </div>

          {/* Tabs */}
          <div
            role="tablist"
            aria-label="Code map views"
            className="flex gap-1 border-b px-3 py-1.5"
          >
            {(["overview", "graph"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${titleId}-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`${titleId}-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const next = id === "overview" ? "graph" : "overview";
                    setTab(next);
                    document.getElementById(`${titleId}-tab-${next}`)?.focus();
                  }
                }}
                className={cn(
                  "rounded-md px-3 py-1 text-xs focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground/40",
                  tab === id
                    ? "bg-[var(--lift-select-bg)] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {id === "overview" ? "Overview" : "Graph"}
              </button>
            ))}
          </div>

          {notice ? (
            <div role="status" className="border-b px-4 py-1.5 text-xs text-muted-foreground">
              {notice}
            </div>
          ) : null}

          {tab === "overview" ? (
            <div
              role="tabpanel"
              id={`${titleId}-panel-overview`}
              aria-labelledby={`${titleId}-tab-overview`}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {reportStatus === "ready" && report ? (
                <RepoReportOverview
                  report={report}
                  onShowInGraph={showInGraph}
                  onAsk={onAsk}
                  onOpen={onOpenRef}
                  onCopyMarkdown={onCopyMarkdown}
                  onDownloadMarkdown={onDownloadMarkdown}
                  copied={copied}
                />
              ) : (
                <div className="grid h-full place-items-center px-8 text-center text-xs text-muted-foreground">
                  {reportStatus === "loading" || reportStatus === "idle" ? (
                    <div className="flex items-center gap-2">
                      <Spinner aria-hidden className="size-3.5" />
                      Reading the code graph…
                    </div>
                  ) : reportStatus === "not-indexed" ? (
                    <>
                      This repo has no complete index yet. Use the graph chip under the composer to
                      (re)index it, then reopen this panel.
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3">
                      The daemon didn’t return the graph.
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setReportKey((k) => k + 1)}
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <div
                role="tabpanel"
                id={`${titleId}-panel-graph`}
                aria-labelledby={`${titleId}-tab-graph`}
                className="relative min-h-0 flex-1"
              >
                <canvas
                  ref={canvasRef}
                  className="h-full w-full"
                  role="img"
                  aria-label={
                    status === "ready" && data
                      ? `Code graph of ${data.repo}: ${statusLine}`
                      : "Code graph"
                  }
                />

                {status === "loading" ? (
                  <div className="absolute inset-0 grid place-items-center">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Spinner aria-hidden className="size-3.5" />
                      Reading the code graph…
                    </div>
                  </div>
                ) : null}
                {status === "not-indexed" ? (
                  <div className="absolute inset-0 grid place-items-center px-8 text-center text-xs text-muted-foreground">
                    This repo has no complete index yet. Use the graph chip under the composer to
                    (re)index it, then reopen this panel.
                  </div>
                ) : null}
                {status === "error" ? (
                  <div className="absolute inset-0 grid place-items-center px-8 text-center">
                    <div className="flex flex-col items-center gap-3 text-xs text-muted-foreground">
                      The daemon didn’t return the graph.
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setReloadKey((k) => k + 1)}
                      >
                        Try again
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* Hover tooltip */}
                {hover ? (
                  <div
                    className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground"
                    style={{ left: hover.left, top: hover.top }}
                  >
                    <div className="font-medium">{hover.label}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                      <span className="lowercase">{hover.kind}</span>
                      <span aria-hidden>·</span>
                      <span>{hover.degree} links</span>
                    </div>
                    <div className="mt-0.5 truncate text-muted-foreground">{hover.file}</div>
                    {areaOfFile(hover.file) ? (
                      <div className="truncate text-muted-foreground">{areaOfFile(hover.file)}</div>
                    ) : null}
                  </div>
                ) : null}

                {/* Selected node detail (pinned) */}
                {selected ? (
                  <div
                    aria-live="polite"
                    className="absolute bottom-2 left-2 right-2 z-10 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{selected.label}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {selected.kind.toLowerCase()} · {selected.degree} links
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-muted-foreground">{selected.file}</div>
                    {areaOfFile(selected.file) ? (
                      <div className="truncate text-muted-foreground">
                        {areaOfFile(selected.file)}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* Legend: area names (greys, no hue) when the report places the nodes; else the degree note. */}
              {status === "ready" && data ? (
                useAreas && legend.length ? (
                  <ul
                    aria-label="Areas"
                    className="flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-auto border-t px-4 py-2.5 text-xs text-muted-foreground"
                  >
                    {legend.map((e) => (
                      <li key={e.id} className="min-w-0">
                        <Tip
                          as="button"
                          text={e.name}
                          type="button"
                          aria-pressed={litArea === e.id}
                          onClick={() => setLitArea((cur) => (cur === e.id ? null : e.id))}
                          className={cn(
                            "flex max-w-[11rem] items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground/40",
                            litArea === e.id && "text-foreground",
                          )}
                        >
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{
                              background: `rgb(${toneToGrey(e.tone)} ${toneToGrey(e.tone)} ${toneToGrey(e.tone)})`,
                            }}
                          />
                          <span className="truncate">{e.name}</span>
                        </Tip>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
                    Brighter, larger nodes are higher-degree hubs.
                  </div>
                )
              ) : null}
            </>
          )}
        </aside>
      ) : null}
    </>
  );
}

class GraphFetchError extends Error {
  constructor(readonly status: number) {
    super(`graph request failed: ${status}`);
  }
}

function GraphGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" fill="currentColor" />
      <circle cx="18" cy="7" r="2.5" fill="currentColor" />
      <circle cx="7" cy="18" r="2.5" fill="currentColor" />
      <circle cx="17" cy="17" r="2.5" fill="currentColor" />
      <path
        d="M8 7l8 0M7 8l0 8M8 17l8-8M8 18l7-1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        strokeLinecap="round"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
