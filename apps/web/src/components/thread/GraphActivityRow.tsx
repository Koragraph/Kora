import { NetworkIcon, SearchCodeIcon, TargetIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";
import {
  parseBlastRadiusSubject,
  parseGraphQuery,
  parseGraphView,
  type GraphActivityKind,
} from "~/util/graphActivity";

interface GraphActivityRowProps {
  kind: GraphActivityKind;
  summary: string;
  payload: Record<string, unknown> | null | undefined;
}

/**
 * Renders our daemon's custom graph-usage activities with a distinct,
 * emerald-tinted treatment so graph usage is visible in the transcript. Rows are
 * compact labeled lines with a graph glyph; `graph_result` also draws a mini graph.
 */
export const GraphActivityRow = memo(function GraphActivityRow({
  kind,
  summary,
  payload,
}: GraphActivityRowProps) {
  if (kind === "graph_result") {
    return <GraphResultRow summary={summary} payload={payload} />;
  }
  return <GraphLineRow kind={kind} summary={summary} payload={payload} />;
});

function GraphLineRow({
  kind,
  summary,
  payload,
}: {
  kind: Exclude<GraphActivityKind, "graph_result">;
  summary: string;
  payload: Record<string, unknown> | null | undefined;
}) {
  const { icon, detail } = useMemo((): { icon: ReactNode; detail: string | null } => {
    switch (kind) {
      case "graph_query": {
        const { op, subject } = parseGraphQuery(payload);
        return {
          icon: <SearchCodeIcon className="size-4 stroke-[1.8]" aria-hidden />,
          detail: [op, subject].filter(Boolean).join(" "),
        };
      }
      case "blast_radius": {
        return {
          icon: <TargetIcon className="size-4 stroke-[1.8]" aria-hidden />,
          detail: parseBlastRadiusSubject(payload),
        };
      }
    }
  }, [kind, payload]);

  return (
    <div className="flex select-none items-center gap-1.5 py-0.5">
      <span className="flex size-6 shrink-0 items-center justify-center text-success/80">
        {icon}
      </span>
      <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
        <span className="shrink-0 truncate text-secondary-label">{summary}</span>
        {detail ? <span className="min-w-0 truncate text-muted-foreground">{detail}</span> : null}
      </p>
    </div>
  );
}

function GraphResultRow({
  summary,
  payload,
}: {
  summary: string;
  payload: Record<string, unknown> | null | undefined;
}) {
  const view = useMemo(() => parseGraphView(payload), [payload]);

  return (
    <div className="flex select-none flex-col gap-1 py-0.5">
      <div className="flex items-center gap-1.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-success/80">
          <NetworkIcon className="size-4 stroke-[1.8]" aria-hidden />
        </span>
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
          <span className="shrink-0 truncate text-secondary-label">{summary}</span>
          {view ? (
            <span className="min-w-0 truncate text-muted-foreground">
              {view.nodes.length} nodes · {view.edges.length} edges
            </span>
          ) : null}
        </p>
      </div>
      {view ? <GraphViewMiniPreview view={view} /> : null}
    </div>
  );
}

const MINI_GRAPH_WIDTH = 220;
const MINI_GRAPH_HEIGHT = 96;
const MINI_GRAPH_PADDING = 8;
const MINI_GRAPH_MAX_NODES = 40;

function GraphViewMiniPreview({ view }: { view: NonNullable<ReturnType<typeof parseGraphView>> }) {
  const nodes = view.nodes.slice(0, MINI_GRAPH_MAX_NODES);
  const shown = new Set(nodes.map((node) => node.id));
  const project = (value: number, span: number) =>
    MINI_GRAPH_PADDING + value * (span - MINI_GRAPH_PADDING * 2);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return (
    <div className="ms-7 mt-0.5 w-fit rounded-lg border border-success/15 bg-success/[0.04] p-1">
      <svg
        width={MINI_GRAPH_WIDTH}
        height={MINI_GRAPH_HEIGHT}
        viewBox={`0 0 ${MINI_GRAPH_WIDTH} ${MINI_GRAPH_HEIGHT}`}
        role="img"
        aria-label="Graph query result preview"
      >
        {view.edges.map((edge, index) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to || !shown.has(edge.from) || !shown.has(edge.to)) return null;
          return (
            <line
              key={index}
              x1={project(from.x, MINI_GRAPH_WIDTH)}
              y1={project(from.y, MINI_GRAPH_HEIGHT)}
              x2={project(to.x, MINI_GRAPH_WIDTH)}
              y2={project(to.y, MINI_GRAPH_HEIGHT)}
              stroke="var(--color-success)"
              strokeOpacity={0.25}
              strokeWidth={1}
            />
          );
        })}
        {nodes.map((node) => {
          const focused = view.focusId === node.id;
          return (
            <circle
              key={node.id}
              cx={project(node.x, MINI_GRAPH_WIDTH)}
              cy={project(node.y, MINI_GRAPH_HEIGHT)}
              r={focused ? 3.5 : 2}
              fill="var(--color-success)"
              fillOpacity={focused ? 1 : 0.55}
            />
          );
        })}
      </svg>
    </div>
  );
}
