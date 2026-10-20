// "to Popo, Junip" - the one shared label under a user's group message, whoever answers. When the quick model chose the
// recipient it says so ("picked for you"); with the mention rule and no @mention it says nobody will answer.
import { AtSignIcon, SparklesIcon } from "lucide-react";

import { BlobAvatar } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import { joinNames, type GroupMember } from "./groupModel";

export type RouteWhy =
  | "mention"
  | "all"
  | "lead"
  | "auto"
  | "auto-fallback"
  | "single"
  | "no-mention";

export function routedLabel(recipients: ReadonlyArray<Pick<GroupMember, "name">>): string {
  return recipients.length ? `to ${joinNames(recipients.map((r) => r.name))}` : "";
}

/** Why the lead took an auto-routed message ("auto-fallback:timeout" on the wire): said plainly, never a silent downgrade. */
const FALLBACK_DETAIL: Record<string, string> = {
  timeout: "the quick model took too long",
  "no-model": "no quick model was available",
  doubt: "no member clearly fit",
  "bad-answer": "the quick model's answer was unclear",
};

export function routeNote(why: RouteWhy | string | undefined, count: number): string | null {
  if (typeof why === "string" && why.startsWith("auto-fallback:")) {
    const detail = FALLBACK_DETAIL[why.slice("auto-fallback:".length)];
    return detail ? `the lead took it (${detail})` : "the lead took it";
  }
  if (why === "auto:keyword") return "picked for you (matched what they do)";
  switch (why) {
    case "auto":
      return "picked for you";
    case "auto-fallback":
      return "the lead took it";
    case "all":
      return count > 1 ? "everyone" : null;
    case "no-mention":
      return "mention someone to get a reply";
    default:
      return null;
  }
}

export function RoutedTo(props: {
  readonly recipients: ReadonlyArray<GroupMember>;
  readonly why?: RouteWhy | string;
  readonly className?: string;
}) {
  const note = routeNote(props.why, props.recipients.length);
  if (props.recipients.length === 0 && !note) return null;
  const Icon =
    props.why === "auto" || props.why === "auto:keyword" || props.why?.startsWith("auto-fallback")
      ? SparklesIcon
      : AtSignIcon;
  return (
    <div
      data-routed-to={props.recipients.map((r) => r.id).join(",")}
      className={cn(
        "mt-1 flex items-center justify-end gap-1.5 pr-1 text-[11px] text-muted-foreground",
        props.className,
      )}
    >
      {props.recipients.length > 0 ? (
        <>
          <span className="flex items-center -space-x-1" aria-hidden>
            {props.recipients.slice(0, 4).map((r) => (
              <span
                key={r.id}
                className="grid size-4 place-items-center rounded-full bg-card ring-1 ring-background"
              >
                <BlobAvatar
                  outfit={r.outfit}
                  chief={r.chief}
                  chiefScale={1}
                  size={14}
                  still
                  eyesFollowCursor={false}
                />
              </span>
            ))}
          </span>
          <span className="font-medium">{routedLabel(props.recipients)}</span>
        </>
      ) : null}
      {note ? (
        <span className="flex items-center gap-1 opacity-80">
          {props.recipients.length > 0 ? <span aria-hidden>·</span> : null}
          <Icon className="size-3" aria-hidden />
          {note}
        </span>
      ) : null}
    </div>
  );
}
