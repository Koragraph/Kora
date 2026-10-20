// The panel's quiet empty / "coming soon" state: a soft icon tile, a title and one line.
import type { ComponentType, ReactNode } from "react";

export function PanelEmpty(props: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly children: ReactNode;
  readonly soon?: boolean;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 pb-10 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-card text-muted-foreground ring-1 ring-border/70">
        <props.icon className="size-5" />
      </span>
      <div>
        <div className="flex items-center justify-center gap-2">
          <h3 className="text-[14px] font-medium text-foreground">{props.title}</h3>
          {props.soon ? (
            <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Soon
            </span>
          ) : null}
        </div>
        <p className="mx-auto mt-1 max-w-[260px] text-[12.5px] leading-snug text-muted-foreground">
          {props.children}
        </p>
      </div>
      {props.action}
    </div>
  );
}
