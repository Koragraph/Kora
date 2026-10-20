// New group / Edit group. One dialog: name, members (multi-select with avatars), lead, who answers (responder rule) and the
// shared instructions. The draft lives inside the open dialog only: closing it throws it away. Pure props in, callbacks
// out: the host passes the members, the existing names and `onSubmit`, so this file needs no RPC.

import { cn } from "~/util/utils";
import { Hint } from "~/components/ui/hint";
import { BlobAvatar } from "~/components/blobs/avatar";
import {
  GROUP_INSTRUCTIONS_MAX,
  validateGroupDraft,
  GROUP_MAX_MEMBERS,
  RESPONDER_RULES,
  GROUP_NAME_MAX,
  draftFromGroup,
  newGroupDraft,
  draftIsValid,
  isDraftDirty,
  toggleMember,
  type GroupMember,
  type GroupDraft,
  RULE_LABEL,
  type GroupWire,
  RULE_HELP,
} from "./groupModel";
import { Textarea } from "../../ui/textarea";
import { Input } from "../../ui/input";
import {
  DialogHeader,
  DialogPopup,
  DialogDescription,
  Dialog,
  DialogTitle,
  DialogFooter,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { useEffect, useState, useMemo, useRef } from "react";
import { FolderIcon, CheckIcon, CrownIcon } from "lucide-react";

export interface GroupSubmitResult {
  readonly ok: boolean;
  readonly message?: string;
}

export function CreateGroupDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Everyone who can join (Kora first). */
  readonly members: ReadonlyArray<GroupMember>;
  readonly existingNames: ReadonlyArray<string>;
  /** Edit mode when set. */
  readonly group?: GroupWire | null;
  /** Blobs ticked when the dialog opens fresh (e.g. "New group with Popo"). */
  readonly preselect?: ReadonlyArray<string>;
  /** Where the shared folder will be, for the footnote ("~/Blobs/_groups/<name>"). */
  readonly folderLabel?: (name: string) => string;
  readonly onSubmit: (draft: GroupDraft, groupId: string | null) => Promise<GroupSubmitResult>;
}) {
  const { members, group } = props;
  const base = useMemo(
    () => (group ? draftFromGroup(group) : newGroupDraft(props.preselect ?? [], members)),
    [group, props.preselect, members],
  );
  const [draft, setDraft] = useState<GroupDraft>(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // A fresh draft every time the dialog OPENS. Never again while it stays open: the roster behind it ticks (a thread settles, a
  // blob's status changes) and rebuilds `members`, which must not wipe what the person has typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (props.open && !wasOpen.current) {
      setDraft(base);
      setBusy(false);
      setError(null);
      setTouched(false);
    }
    wasOpen.current = props.open;
  }, [props.open, base]);

  const problems = validateGroupDraft(draft, props.existingNames, group?.name);
  const valid = draftIsValid(problems);
  const dirty = group ? isDraftDirty(draft, base) : true;
  const picked = draft.memberIds
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is GroupMember => m !== undefined);

  const submit = async () => {
    setTouched(true);
    if (!valid || busy || !dirty) return;
    setBusy(true);
    setError(null);
    const r = await props.onSubmit({ ...draft, name: draft.name.trim() }, group?.id ?? null);
    setBusy(false);
    if (r.ok) props.onOpenChange(false);
    else setError(r.message ?? "Could not save the group.");
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl" data-group-dialog={group ? "edit" : "create"}>
        <DialogHeader>
          <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
          <DialogDescription>
            The blobs in a group share one conversation and one folder. Each keeps its own memory,
            personality and permissions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[min(72vh,660px)] flex-col gap-5 overflow-y-auto px-6 pb-2">
          {/* name */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-foreground">Name</span>
            <span className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              >
                #
              </span>
              <Input
                value={draft.name}
                maxLength={GROUP_NAME_MAX + 8}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onBlur={() => setTouched(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                placeholder="launch-week"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-label="Group name"
                aria-invalid={touched && problems.name !== null}
                className="[&_input]:pl-7"
                data-group-name
              />
            </span>
            {touched && problems.name ? (
              <span role="alert" className="text-[12px] text-destructive-foreground">
                {problems.name}
              </span>
            ) : null}
          </label>

          {/* members */}
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1.5 flex w-full items-baseline justify-between text-[12.5px] font-medium text-foreground">
              <span>Members</span>
              <span className="font-normal text-muted-foreground tabular-nums" data-member-count>
                {draft.memberIds.length} of {GROUP_MAX_MEMBERS}
              </span>
            </legend>
            <div
              className="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
              role="group"
              aria-label="Members"
            >
              {members.map((m) => {
                const on = draft.memberIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    data-member-option={m.id}
                    onClick={() => setDraft(toggleMember(draft, m.id, members))}
                    className={cn(
                      "flex min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ring-1 transition-colors ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "bg-foreground/[0.06] ring-foreground/40"
                        : "bg-transparent ring-border hover:bg-muted/60",
                    )}
                  >
                    <span className="grid size-9 shrink-0 place-items-center">
                      <BlobAvatar
                        outfit={m.outfit}
                        chief={m.chief}
                        chiefScale={1}
                        size={32}
                        still
                        eyesFollowCursor={false}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium">{m.name}</span>
                        {m.chief ? (
                          <span className="rounded-full bg-foreground/90 px-1.5 py-px text-[9px] font-semibold tracking-wide text-background uppercase">
                            Chief
                          </span>
                        ) : null}
                      </span>
                      {m.title ? (
                        <span className="block truncate text-[11.5px] text-muted-foreground">
                          {m.title}
                        </span>
                      ) : null}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-[18px] shrink-0 place-items-center rounded-full ring-1 transition-colors ring-inset",
                        on ? "bg-foreground text-background ring-foreground" : "ring-border",
                      )}
                    >
                      {on ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {touched && problems.members ? (
              <span role="alert" className="text-[12px] text-destructive-foreground">
                {problems.members}
              </span>
            ) : null}
          </fieldset>

          {/* lead */}
          {picked.length >= 2 ? (
            <div className="flex flex-col gap-1.5" data-lead-picker>
              <span className="text-[12.5px] font-medium text-foreground">Lead</span>
              <div role="radiogroup" aria-label="Lead" className="flex flex-wrap gap-1.5">
                {picked.map((m) => {
                  const on = draft.leadId === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-lead-option={m.id}
                      onClick={() => setDraft({ ...draft, leadId: m.id })}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-full pr-3 pl-1.5 text-[12.5px] font-medium ring-1 transition-colors ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        on
                          ? "bg-foreground text-background ring-foreground"
                          : "ring-border hover:bg-muted/60",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-6 place-items-center rounded-full",
                          on ? "bg-background/90" : "bg-muted",
                        )}
                      >
                        <BlobAvatar
                          outfit={m.outfit}
                          chief={m.chief}
                          chiefScale={1}
                          size={20}
                          still
                          eyesFollowCursor={false}
                        />
                      </span>
                      {m.name}
                      {on ? <CrownIcon className="size-3" aria-hidden /> : null}
                    </button>
                  );
                })}
              </div>
              <span className="text-[12px] text-muted-foreground">
                The lead answers when nobody is picked or mentioned.
              </span>
            </div>
          ) : null}

          {/* responder rule */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[12.5px] font-medium text-foreground">
              Who answers
            </legend>
            <div
              role="radiogroup"
              aria-label="Who answers"
              className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"
            >
              {RESPONDER_RULES.map((rule) => {
                const on = draft.rule === rule;
                return (
                  <button
                    key={rule}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-rule-option={rule}
                    onClick={() => setDraft({ ...draft, rule })}
                    className={cn(
                      "flex flex-col gap-1 rounded-xl px-3 py-2.5 text-left ring-1 transition-colors ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "bg-foreground/[0.06] ring-foreground/40"
                        : "ring-border hover:bg-muted/60",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2 text-[13px] font-medium">
                      <span className="min-w-0 truncate">{RULE_LABEL[rule]}</span>
                      <span
                        aria-hidden
                        className={cn(
                          "size-3 shrink-0 rounded-full ring-1 ring-inset",
                          on ? "bg-foreground ring-foreground" : "ring-border",
                        )}
                      />
                    </span>
                    <span className="text-[11.5px] leading-snug text-muted-foreground">
                      {RULE_HELP[rule]}
                    </span>
                  </button>
                );
              })}
            </div>
            <span className="text-[12px] text-muted-foreground">
              @mentions always win, whatever you pick.
            </span>
          </fieldset>

          {/* instructions */}
          <label className="flex flex-col gap-1.5">
            <span className="flex items-baseline justify-between text-[12.5px] font-medium text-foreground">
              Shared instructions
              <span className="font-normal text-muted-foreground tabular-nums">
                {draft.instructions.length} / {GROUP_INSTRUCTIONS_MAX}
              </span>
            </span>
            <Textarea
              value={draft.instructions}
              maxLength={GROUP_INSTRUCTIONS_MAX}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              placeholder="Optional. What this group is for, house rules, tone. Every member reads it."
              rows={3}
              aria-label="Shared instructions"
              data-group-instructions
            />
          </label>

          {props.folderLabel ? (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <FolderIcon className="size-3.5 shrink-0" aria-hidden />
              <Hint label={props.folderLabel(draft.name.trim() || "name")}>
                <span className="truncate">They get a shared folder, set up when you save.</span>
              </Hint>
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-[12.5px] text-destructive-foreground" data-group-error>
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || (touched && !valid) || !dirty}
            data-group-submit
          >
            {busy ? "Saving…" : group ? "Save" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
