// The live turn's elapsed time ("42s", "1m 3s"): beside the working sprite in the transcript and in a sidebar thread row.
import { useEffect, useRef, useState } from "react";

import { cn } from "~/util/utils";
import { formatDuration } from "../../thread/timeline";

function elapsedLabel(startedAt: string | null, now: number): string {
  const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
  if (Number.isNaN(started)) return "0s";
  const ms = Math.max(0, now - started);
  return ms < 60_000 ? `${Math.floor(ms / 1000)}s` : formatDuration(ms);
}

/** " · 12s" after a live label. Ticks by rewriting its own text node, so the list never re-renders for it. */
export function TurnTimer(props: {
  readonly startedAt: string | null;
  readonly className?: string;
  /** No " · " lead-in: the timer sits right beside the sprite with no label before it. */
  readonly bare?: boolean;
}) {
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  const lead = props.bare ? "" : " · ";
  // React never touches this text again; the effect owns it after mount.
  const [initial] = useState(() => `${lead}${elapsedLabel(props.startedAt, Date.now())}`);
  const { startedAt } = props;

  useEffect(() => {
    const text = nodeRef.current?.firstChild;
    if (!text) return;
    const tick = () => {
      text.nodeValue = `${lead}${elapsedLabel(startedAt, Date.now())}`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt, lead]);

  return (
    <span ref={nodeRef} className={cn("tabular-nums text-muted-foreground/70", props.className)}>
      {initial}
    </span>
  );
}
