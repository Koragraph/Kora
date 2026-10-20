// Overlapping avatars for a group's members (roster row, header, create dialog preview). Max `limit` faces then "+N".
// No circles behind the faces: the roster rows are translucent washes, so a "cut-out" ring would show as a lighter disc.
// Each blob instead casts a thin dark seam onto its right-hand neighbour (drop-shadow in the solid sidebar colour), which
// reads as separation on every row state.
import { BlobAvatar } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import type { GroupMember } from "./groupModel";

export function MemberStack(props: {
  readonly members: ReadonlyArray<GroupMember>;
  /** Avatar box in px. */
  readonly size?: 16 | 20 | 24 | 32;
  readonly limit?: number;
  readonly className?: string;
}) {
  const size = props.size ?? 20;
  const limit = props.limit ?? 3;
  const shown = props.members.slice(0, limit);
  const more = props.members.length - shown.length;
  const overlap = Math.round(size * 0.22);
  return (
    <span
      className={cn("inline-flex shrink-0 items-center", props.className)}
      data-member-stack={props.members.length}
      role="img"
      aria-label={`${props.members.length} members`}
    >
      {shown.map((m, i) => (
        <span
          key={m.id}
          data-member-face={m.id}
          className="grid shrink-0 place-items-center [filter:drop-shadow(1.5px_0_0_var(--sidebar))]"
          style={{
            width: size,
            height: size,
            marginLeft: i === 0 ? 0 : -overlap,
            zIndex: shown.length - i,
          }}
        >
          <BlobAvatar
            outfit={m.outfit}
            chief={m.chief}
            chiefScale={1}
            size={Math.round(size * 0.95)}
            eyesFollowCursor={false}
          />
        </span>
      ))}
      {more > 0 ? (
        <span
          className="ml-1 shrink-0 text-[10.5px] font-semibold text-sidebar-muted-foreground tabular-nums"
          data-member-more={more}
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
}
