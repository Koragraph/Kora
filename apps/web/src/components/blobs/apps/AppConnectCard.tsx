// A blob reached for an app it cannot use yet: one quiet line in its chat with the chip that fixes it. Connect opens the
// app's sign-in page; once connected the app is allowed for this blob (and only this blob).
import { PlugIcon } from "lucide-react";

import { useBlobSkin } from "../chat/blobSkin";
import { ConnectChip } from "./ConnectChip";
import { appLabel } from "./appsModel";

export function AppConnectCard(props: {
  readonly toolkit: string;
  readonly reason: "not_connected" | "not_granted";
  readonly blobId: string;
}) {
  const skin = useBlobSkin();
  const name = appLabel(props.toolkit);
  const who = skin?.name ?? "This blob";
  return (
    <div
      data-app-connect-card={props.toolkit}
      className="my-2 flex w-full max-w-[560px] flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-card px-3.5 py-3 ring-1 ring-border/70"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-muted-foreground">
        <PlugIcon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground/90">
        {props.reason === "not_connected"
          ? `${who} wanted to use ${name}, but it isn’t connected yet.`
          : `${who} isn’t allowed to use ${name} yet.`}
      </span>
      <ConnectChip
        app={props.toolkit}
        label={name}
        blobId={props.blobId}
        {...(skin?.name ? { blobName: skin.name } : {})}
      />
    </div>
  );
}
