import { Spinner } from "~/components/ui/spinner";

import { threadLoadLabel, type ThreadLoadPhase } from "../../thread/threadSync";
import { PromptBanner } from "./PromptBanner";

export function PromptActivityRow({ phase }: { readonly phase: ThreadLoadPhase }) {
  return (
    <PromptBanner.Row>
      <PromptBanner.Icon>
        {/* Decorative: the text beside it is the status (a second "Loading" status read as an unlabeled spinner). */}
        <Spinner aria-hidden="true" role="presentation" />
      </PromptBanner.Icon>
      <PromptBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-prompt-sync-status={phase}
          role="status"
        >
          {threadLoadLabel(phase)}
        </span>
      </PromptBanner.Content>
    </PromptBanner.Row>
  );
}
