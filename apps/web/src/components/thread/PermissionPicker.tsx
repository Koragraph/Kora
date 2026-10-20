// The composer's permissions picker, beside the model picker: each harness's own modes under their own names.
import { cn } from "~/util/utils";
import { usePromptMenuProps } from "./promptEventScope";
import { permissionOptionsFor, permissionOptionFor } from "./permissionModes";
import { PromptControlChevron, PromptControl } from "./PromptControl";
import { PopoverTrigger, PopoverPopup, Popover } from "../ui/popover";
import type { AccessMode, AgentId } from "@kora/contracts";
import { memo, useState } from "react";
import { ShieldAlertIcon, ShieldIcon, CheckIcon } from "lucide-react";

const DANGER_PERMISSION_NOTE = "runs commands and edits files without asking";

export const PermissionPicker = memo(function PermissionPicker(props: {
  driverKind: AgentId | undefined;
  mode: AccessMode;
  onChange: (mode: AccessMode) => void;
  blob?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuProps = usePromptMenuProps();
  const opts = props.blob ? { blob: true } : {};
  const options = permissionOptionsFor(props.driverKind, opts);
  const current = permissionOptionFor(props.driverKind, props.mode, opts);
  const Icon = current?.danger ? ShieldAlertIcon : ShieldIcon;
  const tooltip = current
    ? `Permissions: ${current.label}${current.danger ? `, ${DANGER_PERMISSION_NOTE}` : ""}`
    : "Permissions";
  const trigger = (
    <PromptControl
      aria-label={tooltip}
      title={tooltip}
      className="shrink-0 gap-1.5 whitespace-nowrap"
      data-permission-picker=""
      disabled={props.disabled}
      size="sm"
      variant="ghost"
    >
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", current?.danger && "text-warning")}
        data-testid={current?.danger ? "model-picker-danger-permission" : undefined}
      />
      {props.compact ? null : <span>{current?.label ?? "Permissions"}</span>}
      <PromptControlChevron size="sm" />
    </PromptControl>
  );
  return (
    <Popover onOpenChange={(next) => setOpen(next && !props.disabled)} open={open}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup align="end" className="w-72 p-0" {...menuProps}>
        <div
          aria-label="Permissions"
          className="px-1 py-1.5"
          data-testid="model-picker-permissions"
          role="radiogroup"
        >
          {options.map((option) => {
            const selected = option.mode === current?.mode;
            return (
              <button
                aria-checked={selected}
                className={cn(
                  "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent",
                  selected && "bg-accent",
                )}
                data-permission-mode={option.mode}
                key={option.mode}
                onClick={() => {
                  if (!selected) props.onChange(option.mode);
                  setOpen(false);
                }}
                role="radio"
                type="button"
              >
                <span className="flex w-full items-center justify-between gap-2 text-sm font-medium text-foreground">
                  {option.label}
                  {selected ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
                </span>
                <span className="text-xs leading-4 text-muted-foreground">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
