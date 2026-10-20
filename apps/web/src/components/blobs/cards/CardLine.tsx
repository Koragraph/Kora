// The one-line chrome every transcript card shares: a small icon, quiet text, optional inline actions. Cards sit
// between bubbles, so they stay muted, tight and never wrap into a block unless the text itself is long.
import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "~/util/utils";

export function CardLine(props: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly muted?: boolean;
  readonly kind: string;
  readonly className?: string;
}) {
  const Icon = props.icon;
  return (
    <div
      data-blob-card={props.kind}
      className={cn(
        "flex w-fit min-w-0 max-w-full items-start gap-2 py-0.5 text-[12.5px] leading-5",
        props.muted ? "text-muted-foreground/70" : "text-muted-foreground",
        props.className,
      )}
    >
      <Icon className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 [overflow-wrap:anywhere]">{props.children}</div>
      {props.actions ? (
        <div className="flex shrink-0 items-center gap-2.5 pl-1">{props.actions}</div>
      ) : null}
    </div>
  );
}

/** A quiet text button: "Undo", "Details", "Approve". */
export function CardLink(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, type = "button", ...rest } = props;
  return (
    <button
      type={type}
      className={cn(
        "rounded-sm text-[12.5px] font-medium text-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}
