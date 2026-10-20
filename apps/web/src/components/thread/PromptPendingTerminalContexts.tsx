import {
  formatTerminalExcerptLabel,
  isTerminalExcerptExpired,
  type TerminalExcerptDraft,
} from "~/util/terminalContext";
import { TerminalExcerptInlineChip } from "./TerminalExcerptInlineChip";
import type { ContextDisplayCapability } from "../contextDisplayRegistry";

interface PromptPendingTerminalContextChipProps {
  context: TerminalExcerptDraft;
  detailsMode: ContextDisplayCapability["details"];
}

export function PromptPendingTerminalContextChip({
  context,
  detailsMode,
}: PromptPendingTerminalContextChipProps) {
  return (
    <TerminalExcerptInlineChip
      detailsMode={detailsMode}
      expired={isTerminalExcerptExpired(context)}
      label={formatTerminalExcerptLabel(context)}
      lineEnd={context.lineEnd}
      lineStart={context.lineStart}
      terminalLabel={context.terminalLabel}
      text={context.text}
    />
  );
}
