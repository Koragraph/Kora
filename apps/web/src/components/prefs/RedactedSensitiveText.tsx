import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { cn } from "../../util/utils";
import { useState, useMemo } from "react";

const REDACTED_TEXT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const KEPT_CHARACTERS = new Set(["@", ".", "-", "_"]);

function seedFrom(text: string): number {
  let acc = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    acc = Math.imul(acc ^ text.charCodeAt(at), 0x01000193);
  }
  return acc;
}

function redactedPlaceholder(value: string): string {
  let state = seedFrom(value);

  const pick = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    const slot = Math.abs(state) % REDACTED_TEXT_ALPHABET.length;
    return REDACTED_TEXT_ALPHABET[slot] ?? "x";
  };

  return Array.from(value, (char) => (KEPT_CHARACTERS.has(char) ? char : pick())).join("");
}

export function RedactedSensitiveText(props: {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly hideTooltip: string;
  readonly revealTooltip: string;
  readonly value: string | null | undefined;
}) {
  const value = props.value?.trim();
  const [revealed, setRevealed] = useState(false);
  const redacted = useMemo(() => (value ? redactedPlaceholder(value) : ""), [value]);

  if (!value) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.ariaLabel}
            onClick={() => setRevealed((current) => !current)}
            className={cn(
              "min-w-0 cursor-pointer rounded-sm font-mono text-[11px] leading-none transition hover:text-foreground",
              revealed ? "text-muted-foreground" : "select-none text-muted-foreground blur-[2px]",
              props.className,
            )}
          >
            {revealed ? value : redacted}
          </button>
        }
      />
      <TooltipPopup side="top">{revealed ? props.hideTooltip : props.revealTooltip}</TooltipPopup>
    </Tooltip>
  );
}
