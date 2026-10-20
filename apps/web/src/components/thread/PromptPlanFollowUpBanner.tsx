import { memo } from "react";
import { PromptBanner } from "./PromptBanner";

export const PromptPlanFollowUpBanner = memo(function PromptPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <PromptBanner.Row>
      <PromptBanner.Icon />
      <PromptBanner.Content>
        <span className="shrink-0 font-medium text-muted-foreground">Plan waiting on you</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-foreground/85">{planTitle}</span>
        ) : null}
      </PromptBanner.Content>
    </PromptBanner.Row>
  );
});
