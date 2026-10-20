"use client";

import { cn } from "~/util/utils";
import { AnimatedHeight } from "~/components/SmoothHeight";
import { DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./dialog";
import type { ComponentProps, ReactNode } from "react";
import { CheckIcon } from "lucide-react";

export function WizardPopup({
  children,
  ...props
}: Omit<ComponentProps<typeof DialogPopup>, "className" | "style">) {
  return (
    <DialogPopup className="max-w-xl overflow-y-auto overflow-x-hidden" {...props}>
      <div className="flex min-h-0 flex-col">{children}</div>
    </DialogPopup>
  );
}

export function WizardHeader(incoming: {
  title: ReactNode;
  description?: ReactNode;
  identity?: ReactNode;
  children?: ReactNode;
}) {
  const { description, identity, children, title } = incoming;
  const dialogHeaderKids = (
    <>
      <DialogTitle className={identity ? "sr-only" : undefined}>{title}</DialogTitle>
      {identity}
      {description ? <DialogDescription>{description}</DialogDescription> : null}
      {children}
    </>
  );

  return <DialogHeader>{dialogHeaderKids}</DialogHeader>;
}

export function WizardFooter({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  const divBlock = leading ? (
    <>
      {leading}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">{children}</div>
    </>
  ) : (
    children
  );

  return (
    <DialogFooter className={leading ? "sm:justify-between" : undefined} variant="bare">
      {divBlock}
    </DialogFooter>
  );
}

const STEP_BASE =
  "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2.5";

export function WizardSteps({
  showSummaries = false,
  isStepDisabled,
  onStepChange,
  currentStep,
  summaries,
  steps,
}: {
  steps: readonly string[];
  currentStep: number;
  summaries?: readonly (string | null)[];
  showSummaries?: boolean;
  isStepDisabled?: (step: number) => boolean;
  onStepChange?: (step: number) => void;
}) {
  return (
    <ol
      className="flex gap-1 rounded-xl bg-zinc-25 p-1 ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/5"
      aria-label="Setup progress"
      role="list"
    >
      {steps.map((step, index) => {
        const completed = index < currentStep;
        const current = index === currentStep;
        const summary = summaries?.[index] ?? null;
        const interactive = onStepChange !== undefined;
        const disabled = interactive && (isStepDisabled?.(index) ?? false);

        const className = cn(
          STEP_BASE,
          interactive && !disabled && "cursor-pointer hover:bg-card",
          interactive && disabled && "cursor-default",
          current &&
            "bg-card text-foreground shadow-xs ring-1 ring-black/5 hover:bg-card dark:shadow-none dark:ring-white/5",
        );

        const content = (
          <>
            <span
              aria-hidden="true"
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full font-medium text-sm ring-1",
                completed &&
                  "bg-control-checked text-control-checked-foreground ring-control-checked",
                current && "bg-control-checked/10 text-control-checked ring-control-checked/30",
                !completed &&
                  !current &&
                  "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
              )}
            >
              {completed ? <CheckIcon className="size-4" /> : index + 1}
            </span>
            <span
              className={cn(
                "hidden min-w-0 items-baseline font-medium text-sm sm:flex",
                current ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span data-wizard-step-label="true" className="shrink-0 whitespace-nowrap">
                {step}
              </span>
              {showSummaries && completed && summary ? (
                <span className="min-w-0 truncate">{`: ${summary}`}</span>
              ) : null}
            </span>
          </>
        );

        const label = `${step}, step ${index + 1}${completed && summary ? `, ${summary}` : ""}`;
        const shared = {
          "aria-current": current ? ("step" as const) : undefined,
          "aria-label": label,
          className: cn(className, "max-sm:justify-center"),
        };

        return (
          <li className="min-w-0 flex-auto" key={step}>
            {interactive ? (
              <button
                {...shared}
                disabled={disabled}
                onClick={() => onStepChange(index)}
                type="button"
              >
                {content}
              </button>
            ) : (
              <div {...shared}>{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function WizardPanel({
  children,
  holdHeight = false,
}: {
  children: ReactNode;
  holdHeight?: boolean;
}) {
  return (
    <div data-slot="dialog-panel">
      <AnimatedHeight holdHeight={holdHeight}>
        <div className="flex min-w-0 flex-col gap-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5">
          {children}
        </div>
      </AnimatedHeight>
    </div>
  );
}
