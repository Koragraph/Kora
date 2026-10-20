import { cn } from "~/util/utils";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { RefreshIcon } from "../ui/spin-refresh-icon";
import { InputGroupAddon, InputGroupInput, InputGroup } from "../ui/input-group";
import { Button } from "../ui/button";
import { type FormEvent, type ReactNode, useState, useRef } from "react";
import {
  MousePointerClickIcon,
  ExternalLinkIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  CameraIcon,
  SearchIcon,
} from "lucide-react";

type Props = {
  onCapture?: (record: boolean) => void;
  onSubmit: (url: string) => void;
  onOpenInBrowser?: () => void;
  trailingActions?: ReactNode;
  pickDisabledReason?: string;
  onPickElement?: () => void;
  leadingActions?: ReactNode;
  captureDisabled?: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean;
  pickDisabled?: boolean;
  onRefresh: () => void;
  onForward: () => void;
  canGoForward: boolean;
  pickActive?: boolean;
  recording?: boolean;
  onBack: () => void;
  canGoBack: boolean;
  loading: boolean;
  url: string;
};

function IconAction({
  label,
  tooltip = label,
  children,
  ...buttonProps
}: {
  label: string;
  tooltip?: string;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "aria-label" | "size" | "children">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-xs"
            type="button"
            variant="ghost"
            {...buttonProps}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function WebChromeRow(props: Props) {
  const {
    refreshDisabled,
    onOpenInBrowser,
    onPickElement,
    inputDisabled,
    canGoForward,
    onCapture,
    canGoBack,
    loading,
    url,
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    props.onSubmit(trimmed);
    inputRef.current?.blur();
  };

  const noop = () => {};
  const pickTooltip =
    props.pickDisabled && props.pickDisabledReason
      ? props.pickDisabledReason
      : props.pickActive
        ? "Cancel annotation"
        : "Annotate elements, regions, and drawings";

  const pickControl = onPickElement ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.pickActive ? "Cancel annotation" : "Annotate preview"}
            aria-pressed={props.pickActive ? "true" : "false"}
            disabled={props.pickDisabled}
            onClick={onPickElement}
            size="icon-xs"
            type="button"
            variant={props.pickActive ? "secondary" : "ghost"}
          />
        }
      >
        <MousePointerClickIcon className={cn(props.pickActive && "text-control-checked")} />
      </TooltipTrigger>
      <TooltipPopup>{pickTooltip}</TooltipPopup>
    </Tooltip>
  ) : null;

  return (
    <div className="relative">
      <form
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 [[data-web-panel-mode=inline]_&]:mb-3 [[data-web-panel-mode=inline]_&]:h-7 [[data-web-panel-mode=inline]_&]:min-h-7 [[data-web-panel-mode=inline]_&]:border-transparent"
        data-surface-subheader=""
        onSubmit={submit}
      >
        <div aria-label="Navigation" className="flex gap-0.5" role="group">
          <IconAction disabled={!canGoBack} label="Back" onClick={canGoBack ? props.onBack : noop}>
            <ArrowLeftIcon />
          </IconAction>
          <IconAction
            disabled={!canGoForward}
            label="Forward"
            onClick={canGoForward ? props.onForward : noop}
          >
            <ArrowRightIcon />
          </IconAction>
          <IconAction
            disabled={refreshDisabled}
            label={loading ? "Stop" : "Refresh"}
            onClick={refreshDisabled ? noop : props.onRefresh}
            tooltip={loading ? "Loading…" : "Refresh"}
          >
            <RefreshIcon refreshing={loading} />
          </IconAction>
        </div>

        {props.leadingActions}

        <InputGroup className="group/address h-7 flex-1" variant="ghost">
          <InputGroupAddon className="ms-2 text-muted-foreground">
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            className={cn(
              "transition-[padding]",
              onOpenInBrowser && !focused && "group-hover/address:pe-7",
            )}
            data-web-url-input=""
            disabled={inputDisabled}
            onBlur={() => setFocused(false)}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => {
              const input = event.currentTarget;
              setDraft(url);
              setFocused(true);
              queueMicrotask(() => input.select());
            }}
            placeholder="Paste a link or localhost:port"
            ref={inputRef}
            size="sm"
            spellCheck={false}
            value={focused ? draft : url}
          />
          {onOpenInBrowser && !focused ? (
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pe-0.5 opacity-0 transition-opacity group-hover/address:pointer-events-auto group-hover/address:opacity-100">
              <IconAction label="Open in system browser" onClick={onOpenInBrowser}>
                <ExternalLinkIcon />
              </IconAction>
            </div>
          ) : null}
        </InputGroup>

        {pickControl}

        {onCapture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={props.recording ? "Stop recording" : "Capture screenshot"}
                  className="relative"
                  disabled={props.captureDisabled}
                  onClick={(event) => onCapture(event.shiftKey)}
                  size="icon-xs"
                  type="button"
                  variant={props.recording ? "secondary" : "ghost"}
                />
              }
            >
              <CameraIcon className={cn(props.recording && "text-destructive")} />
              {props.recording ? (
                <span className="absolute top-0.5 right-0.5 size-1.5 animate-status-pulse rounded-full bg-destructive" />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {props.recording ? "Stop recording" : "Screenshot · Shift-click to record"}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {props.trailingActions}
      </form>
      <div
        aria-hidden="true"
        className="preview-load-bar pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary shadow-[0_0_6px_1px_var(--color-ring)]"
        data-loading={loading}
      />
    </div>
  );
}
