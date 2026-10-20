// The 2-minute guide to getting a Composio key, shown where "connected apps aren't set up yet".
import { ArrowUpRightIcon } from "lucide-react";

import { localApiOrThrow } from "~/localApi";
import { Button } from "../../ui/button";

const COMPOSIO_URL = "https://composio.dev";

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Make a free Composio account",
    body: "Sign up at composio.dev. It takes a minute and needs no card.",
  },
  {
    title: "Create a project",
    body: "Composio asks you to name one when you first sign in. Any name works.",
  },
  {
    title: "Copy the project API key",
    body: "Open the project's settings, find API keys, and copy the one that starts with ak_.",
  },
  {
    title: "Paste it here",
    body: "Kora checks it with Composio, keeps it securely on this Mac and never shows it again. Calls then have no monthly limit.",
  },
];

export function SetupGuide() {
  return (
    <div className="space-y-3" data-setup-guide>
      <ol className="space-y-2.5">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-foreground/[0.09] text-[11px] font-semibold tabular-nums text-foreground/85">
              {i + 1}
            </span>
            <div className="min-w-0 text-[13px] leading-snug">
              <div className="font-medium text-foreground">{s.title}</div>
              <div className="text-muted-foreground">{s.body}</div>
            </div>
          </li>
        ))}
      </ol>
      <Button
        size="xs"
        variant="outline"
        onClick={() =>
          void localApiOrThrow()
            .shell.openExternal(COMPOSIO_URL)
            .catch(() => {})
        }
        data-guide-open
      >
        Open composio.dev <ArrowUpRightIcon />
      </Button>
    </div>
  );
}
