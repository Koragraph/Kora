import { renderRepoReportMarkdown, type RepoReport } from "@kora/shared/repoReport";
import { useCallback, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { cn } from "../../util/utils";
import {
  OVERVIEW_SECTION_TITLES,
  REPORT_FILENAME,
  areaIndex,
  areaNameOf,
  bridgeExampleKey,
  locationOf,
  middleTruncate,
  pct,
  plural,
  sortedAreas,
  sortedBridges,
  sortedHotspots,
  sortedHubs,
  visibleSections,
  type OverviewSectionId,
} from "./repoReportView";

export interface RepoReportOverviewProps {
  readonly report: RepoReport;
  /** Switch to the Graph tab with this area lit. */
  readonly onShowInGraph: (areaId: string) => void;
  readonly onAsk: (question: RepoReport["questions"][number]) => void;
  /** A file or symbol row: open it in the file viewer at the line, or copy file:line. */
  readonly onOpen: (ref: { readonly file: string; readonly line: number | null }) => void;
  readonly onCopyMarkdown: () => void;
  readonly onDownloadMarkdown: () => void;
  readonly copied: boolean;
}

/** An element that shows its full text in the app's tooltip on hover or focus (the native title attribute is banned). */
export function Tip({
  text,
  as = "span",
  children,
  ...rest
}: {
  readonly text: string;
  readonly as?: "span" | "div" | "button";
} & Omit<ComponentProps<"span">, "children" | "title"> & {
    readonly children: ReactNode;
    readonly onClick?: () => void;
    readonly type?: "button";
  }) {
  const El = as;
  return (
    <Tooltip>
      <TooltipTrigger render={<El {...(rest as object)} />}>{children}</TooltipTrigger>
      <TooltipPopup>{text}</TooltipPopup>
    </Tooltip>
  );
}

/** A path that cuts in the middle and shows the whole thing on hover; a button when it can be opened. */
function PathText({
  path,
  line = null,
  onOpen,
  max = 40,
  className,
}: {
  readonly path: string;
  readonly line?: number | null;
  readonly onOpen?: (ref: { file: string; line: number | null }) => void;
  readonly max?: number;
  readonly className?: string;
}) {
  const full = locationOf({ file: path, line });
  const text = (
    <>
      {middleTruncate(path, max)}
      {line ? <span className="text-muted-foreground/70">:{line}</span> : null}
    </>
  );
  const base = "min-w-0 max-w-full truncate font-mono text-[11px] leading-5";
  if (!onOpen) {
    return (
      <Tip text={full} className={cn(base, "text-muted-foreground", className)}>
        {text}
      </Tip>
    );
  }
  return (
    <Tip
      as="button"
      text={full}
      type="button"
      onClick={() => onOpen({ file: path, line })}
      className={cn(
        base,
        "rounded-sm text-left text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground/40",
        className,
      )}
    >
      {text}
    </Tip>
  );
}

function Section({
  id,
  children,
  hint,
}: {
  readonly id: OverviewSectionId;
  readonly children: ReactNode;
  readonly hint?: string;
}) {
  return (
    <section aria-labelledby={`report-${id}`} data-report-section={id} className="px-4 py-4">
      <h3
        id={`report-${id}`}
        className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
      >
        {OVERVIEW_SECTION_TITLES[id]}
      </h3>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground/80">{hint}</p> : null}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

const LinkButton = ({
  children,
  onClick,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="max-w-full truncate rounded-sm text-left text-xs text-foreground/80 underline decoration-foreground/20 underline-offset-2 hover:text-foreground hover:decoration-foreground/60 focus-visible:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
  >
    {children}
  </button>
);

const KIND_LABEL = (kind: string): string => kind.toLowerCase();

export function RepoReportOverview(props: RepoReportOverviewProps) {
  const { report, onShowInGraph, onAsk, onOpen, onCopyMarkdown, onDownloadMarkdown, copied } =
    props;
  const sections = useMemo(() => visibleSections(report), [report]);
  const areas = useMemo(() => sortedAreas(report), [report]);
  const known = useMemo(() => areaIndex(report), [report]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nameOf = (id: string | null) => areaNameOf(report, id);

  const jumpToArea = useCallback((id: string) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-area-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "auto" });
    el.focus({ preventScroll: true });
  }, []);

  const s = report.stats;
  const areaLink = (id: string) =>
    known.has(id) ? (
      <LinkButton onClick={() => jumpToArea(id)}>{nameOf(id)}</LinkButton>
    ) : (
      <span className="text-xs text-muted-foreground">{id}</span>
    );

  return (
    <div ref={rootRef} data-slot="repo-report" className="divide-y divide-border">
      {/* Header + stats */}
      <header className="px-4 py-4">
        {/* The panel's own title already names the repo and branch. */}
        {report.indexedSha ? (
          <p className="text-xs text-muted-foreground">
            Indexed at <span className="font-mono">{report.indexedSha.slice(0, 7)}</span>
          </p>
        ) : null}
        {report.stale ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Index behind HEAD. The map may miss recent changes.
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          {plural(s.files, "file")} · {plural(s.declarations, "declaration")} ·{" "}
          {plural(s.edges, "dependency", "dependencies")}
          {s.testFiles ? ` · ${plural(s.testFiles, "test file")}` : ""}
        </p>
        {s.languages.length ? (
          <p className="mt-0.5 text-xs text-muted-foreground/80">
            {s.languages.map((l) => `${l.language} ${l.files}`).join(" · ")}
          </p>
        ) : null}
      </header>

      {sections.includes("areas") ? (
        <Section id="areas" hint="Groups of files that mostly depend on each other.">
          <ul className="flex flex-col gap-2">
            {areas.map((a) => (
              <li
                key={a.id}
                tabIndex={-1}
                data-area-id={a.id}
                className="lift-inset rounded-md border border-border p-3 outline-none focus-visible:border-foreground/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Tip
                      as="div"
                      text={a.name}
                      className="truncate text-sm font-medium text-foreground"
                    >
                      {a.name}
                    </Tip>
                    <div className="text-[11px] text-muted-foreground">
                      {plural(a.files, "file")}
                      {a.testFiles ? ` · ${plural(a.testFiles, "test")}` : ""}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => onShowInGraph(a.id)}
                    aria-label={`Show ${a.name} in graph`}
                  >
                    Show in graph
                  </Button>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{a.summary}</p>
                {a.keyFiles.length ? (
                  <ul className="mt-2 flex flex-col">
                    {a.keyFiles.slice(0, 3).map((f) => (
                      <li key={f.file} className="flex items-baseline justify-between gap-2">
                        <PathText path={f.file} onOpen={onOpen} max={44} />
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                          {f.dependents}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {a.uses.length ? (
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span className="text-[11px] text-muted-foreground">uses</span>
                    {a.uses.map((l, i) => (
                      <span key={l.areaId} className="flex items-baseline gap-1.5">
                        {areaLink(l.areaId)}
                        {i < a.uses.length - 1 ? (
                          <span aria-hidden className="text-muted-foreground/50">
                            ·
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                {a.usedBy.length ? (
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span className="text-[11px] text-muted-foreground">used by</span>
                    {a.usedBy.map((l, i) => (
                      <span key={l.areaId} className="flex items-baseline gap-1.5">
                        {areaLink(l.areaId)}
                        {i < a.usedBy.length - 1 ? (
                          <span aria-hidden className="text-muted-foreground/50">
                            ·
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sections.includes("hubs") ? (
        <Section id="hubs" hint="The declarations the most code leans on.">
          <ul className="flex flex-col gap-3">
            {sortedHubs(report).map((h) => (
              <li key={`${h.file}:${h.name}`} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <Tip text={h.name} className="truncate text-sm text-foreground">
                    {h.name}
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      {KIND_LABEL(h.kind)}
                    </span>
                  </Tip>
                  <span className="shrink-0 text-xs tabular-nums text-foreground/80">
                    {h.dependents}
                  </span>
                </div>
                <PathText path={h.file} line={h.line} onOpen={onOpen} />
                <div className="text-[11px] text-muted-foreground/80">
                  {plural(h.dependentFiles, "file")}
                  {h.areasReached ? ` · reaches ${plural(h.areasReached, "other area")}` : ""}
                  {h.heuristicShare >= 0.5 ? ` · ${pct(h.heuristicShare)} name-matched` : ""}
                </div>
                {h.doc ? <p className="mt-0.5 text-xs text-muted-foreground">{h.doc}</p> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sections.includes("entryPoints") ? (
        <Section id="entryPoints">
          <ul className="flex flex-col gap-2">
            {report.entryPoints.map((e) => (
              <li key={`${e.file}:${e.name}`} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <Tip text={e.name} className="truncate text-sm text-foreground">
                    {e.name}
                  </Tip>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {e.why.replace("-", " ")}
                  </span>
                </div>
                <PathText path={e.file} line={e.line} onOpen={onOpen} />
                {e.areaId ? (
                  <div className="text-[11px] text-muted-foreground/80">in {nameOf(e.areaId)}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sections.includes("bridges") ? (
        <Section id="bridges">
          <ul className="flex flex-col gap-3">
            {sortedBridges(report).map((b) => (
              <li key={`${b.from}>${b.to}:${b.why}`} className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-foreground">
                  {areaLink(b.from)}
                  <span aria-hidden className="text-muted-foreground">
                    →
                  </span>
                  {areaLink(b.to)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {plural(b.edges, "dependency", "dependencies")} ·{" "}
                  {b.why === "single-point"
                    ? "one declaration carries it"
                    : b.why === "unexpected"
                      ? "areas that rarely touch"
                      : "among the strongest"}
                </div>
                {b.examples.slice(0, 2).map((x) => (
                  <Tip
                    as="div"
                    key={bridgeExampleKey(x)}
                    className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                    text={`${locationOf(x.from)} → ${locationOf(x.to)}`}
                  >
                    {x.from.name} → {x.to.name}
                  </Tip>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sections.includes("hotspots") ? (
        <Section id="hotspots" hint="Files touched by the most commits.">
          <ul className="flex flex-col gap-2">
            {sortedHotspots(report).map((h) => (
              <li key={h.file} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <PathText path={h.file} onOpen={onOpen} className="text-foreground/90" />
                  <span className="shrink-0 text-xs tabular-nums text-foreground/80">
                    {h.commits}
                  </span>
                </div>
                {h.changesWith.length ? (
                  <Tip
                    as="div"
                    className="truncate text-[11px] text-muted-foreground/80"
                    text={h.changesWith.join(", ")}
                  >
                    with {h.changesWith.map((f) => middleTruncate(f, 28)).join(", ")}
                  </Tip>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sections.includes("cycles") ? (
        <Section id="cycles">
          <ul className="flex flex-col gap-2">
            {report.cycles.map((c) => (
              <li key={c.join(">")} className="flex flex-col">
                {c.map((f, i) => (
                  <div key={`${f}:${i}`} className="flex items-baseline gap-1.5">
                    <span aria-hidden className="w-3 shrink-0 text-[11px] text-muted-foreground">
                      {i === 0 ? "" : "→"}
                    </span>
                    <PathText path={f} onOpen={onOpen} max={36} />
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sections.includes("notes") ? (
        <Section id="notes">
          <ul className="flex flex-col gap-3">
            {report.notes.map((n) => (
              <li key={`${n.file}:${n.line}:${n.tag}`} className="min-w-0">
                <p className="text-xs leading-5 text-foreground/90">
                  <span className="mr-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {n.tag}
                  </span>
                  {n.text}
                </p>
                <PathText path={n.file} line={n.line} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sections.includes("questions") ? (
        <Section
          id="questions"
          hint="Callers, locations and impact are answered from the graph, no agent turn."
        >
          <ul className="flex flex-col gap-1.5">
            {report.questions.map((q) => (
              <li key={q.text}>
                <button
                  type="button"
                  onClick={() => onAsk(q)}
                  className="w-full rounded-md border border-border px-3 py-2 text-left text-xs text-foreground/90 hover:bg-[var(--lift-select-bg)] focus-visible:bg-[var(--lift-select-bg)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground/40"
                >
                  {q.text}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <footer className="px-4 py-4">
        {report.caveats.length ? (
          <ul className="mb-3 flex flex-col gap-1 text-[11px] leading-4 text-muted-foreground/80">
            {report.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={onCopyMarkdown}>
            {copied ? "Copied" : "Copy Markdown"}
          </Button>
          <Button size="xs" variant="outline" onClick={onDownloadMarkdown}>
            Download {REPORT_FILENAME}
          </Button>
        </div>
      </footer>
    </div>
  );
}

/** Client-side export: the same renderer the daemon's `?format=md` uses. */
export function reportMarkdown(report: RepoReport): string {
  return renderRepoReportMarkdown(report);
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
