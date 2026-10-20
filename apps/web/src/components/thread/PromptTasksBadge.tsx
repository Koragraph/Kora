import { cn } from "~/util/utils";
import { PromptBanner } from "./PromptBanner";
import { formatDuration } from "../../thread/timeline";
import { type ReactNode, memo } from "react";
import { ListTodoIcon } from "lucide-react";

export interface PromptTasksProgress {
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly step: string;
}

export interface PromptTaskStep {
  readonly status: "pending" | "inProgress" | "completed";
  readonly durationMs?: number;
  readonly step: string;
}

type SharedProps = {
  progress: PromptTasksProgress;
  steps: readonly PromptTaskStep[];
};

type ContentProps = SharedProps & { expanded: boolean; onToggle: () => void };

const keepComposerFocus = (event: { preventDefault: () => void }) => event.preventDefault();

/** "<text>:<n>" where n counts earlier identical step texts, so repeated steps stay unique. */
function stepKeys(steps: readonly PromptTaskStep[]): string[] {
  const seen = new Map<string, number>();
  return steps.map((entry) => {
    const occurrence = seen.get(entry.step) ?? 0;
    seen.set(entry.step, occurrence + 1);
    return `${entry.step}:${occurrence}`;
  });
}

const SEGMENT_TONE: Record<PromptTaskStep["status"], string> = {
  completed: "bg-success",
  inProgress: "bg-primary",
  pending: "bg-muted-foreground/25",
};

function SegmentBar({ steps }: { steps: readonly PromptTaskStep[] }) {
  if (steps.length < 2 || steps.length > 10) return null;
  const keys = stepKeys(steps);
  return (
    <span aria-hidden="true" className="hidden w-10 gap-0.5 sm:flex sm:w-20">
      {steps.map((entry, index) => (
        <span
          className={cn("h-[3px] flex-1 rounded-full", SEGMENT_TONE[entry.status])}
          key={keys[index]}
        />
      ))}
    </span>
  );
}

function Badge({
  expanded,
  onToggle,
  progress,
  steps,
  placement = "tab",
}: ContentProps & { placement?: "inline" | "tab" }) {
  if (progress.totalSteps <= 0) return null;
  const { completedSteps, totalSteps, step } = progress;

  const row = (
    <PromptBanner.Row
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse tasks" : "Tasks"}: ${completedSteps} of ${totalSteps} complete. Current task: ${step}`}
      data-prompt-tasks-badge="true"
      onClick={onToggle}
      onPointerDown={keepComposerFocus}
      render={<button type="button" />}
    >
      <PromptBanner.Icon>
        <ListTodoIcon />
      </PromptBanner.Icon>
      <PromptBanner.Content>
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span
          className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80"
          data-prompt-task-current="true"
        >
          {step}
        </span>
      </PromptBanner.Content>
      <PromptBanner.Actions>
        <span
          className={cn(
            "shrink-0 text-muted-foreground tabular-nums",
            completedSteps >= totalSteps && "text-success",
          )}
          data-prompt-task-progress="true"
        >
          {`${completedSteps}/${totalSteps} complete`}
        </span>
        <SegmentBar steps={steps} />
        <PromptBanner.ToggleIcon expanded={expanded} />
      </PromptBanner.Actions>
    </PromptBanner.Row>
  );

  if (placement === "inline") return row;
  return (
    <PromptBanner.Root data-prompt-shoulder-tab="" density="comfortable">
      {row}
    </PromptBanner.Root>
  );
}

export const PromptTasksBadge = memo(function PromptTasksBadge(
  props: ContentProps & { placement?: "inline" | "tab" },
) {
  return <Badge {...props} />;
});

const GLYPH: Record<PromptTaskStep["status"], { char: string; tone: string }> = {
  completed: { char: "✓", tone: "text-success" },
  inProgress: { char: "●", tone: "text-control-checked" },
  pending: { char: "○", tone: "text-muted-foreground/40" },
};
const TEXT_TONE: Record<PromptTaskStep["status"], string> = {
  completed: "text-muted-foreground/55",
  inProgress: "text-foreground/90",
  pending: "text-muted-foreground/70",
};
const STATUS_LABEL: Record<PromptTaskStep["status"], string> = {
  completed: "Completed",
  inProgress: "Running",
  pending: "Pending",
};

function durationCell(entry: PromptTaskStep): ReactNode {
  if (entry.durationMs !== undefined) return formatDuration(entry.durationMs);
  return entry.status === "inProgress" ? "now" : "";
}

export const PromptTasksContent = memo(function PromptTasksContent({
  expanded,
  onToggle,
  progress,
  steps,
}: ContentProps) {
  const keys = stepKeys(steps);
  return (
    <div
      data-prompt-collapsed-controls="true"
      data-prompt-tasks-drawer={expanded ? "true" : undefined}
    >
      <Badge
        progress={progress}
        onToggle={onToggle}
        expanded={expanded}
        placement="inline"
        steps={steps}
      />
      {expanded ? (
        <PromptBanner.Scroll data-prompt-tasks-scroll="true">
          <PromptBanner.Children
            aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
            data-prompt-tasks-list="true"
            render={<ul role="list" />}
          >
            {steps.map((entry, index) => (
              <li key={keys[index]}>
                <PromptBanner.Row>
                  <PromptBanner.Icon
                    className={cn("font-mono text-[10px]", GLYPH[entry.status].tone)}
                  >
                    {GLYPH[entry.status].char}
                  </PromptBanner.Icon>
                  <PromptBanner.Content className={TEXT_TONE[entry.status]}>
                    <span className="truncate">{entry.step}</span>
                  </PromptBanner.Content>
                  <PromptBanner.Actions>
                    <span className="text-[10px] text-muted-foreground">
                      {STATUS_LABEL[entry.status]}
                    </span>
                    <span
                      className="w-10 text-right text-[10px] text-muted-foreground/45 tabular-nums"
                      data-prompt-task-duration="true"
                    >
                      {durationCell(entry)}
                    </span>
                  </PromptBanner.Actions>
                </PromptBanner.Row>
              </li>
            ))}
          </PromptBanner.Children>
        </PromptBanner.Scroll>
      ) : null}
    </div>
  );
});

export const PromptTasksDrawer = memo(function PromptTasksDrawer({
  onCollapse,
  ...rest
}: SharedProps & { onCollapse: () => void }) {
  return (
    <PromptBanner.Attachment>
      <PromptBanner.Root density="comfortable">
        <PromptTasksContent {...rest} expanded onToggle={onCollapse} />
      </PromptBanner.Root>
    </PromptBanner.Attachment>
  );
});
