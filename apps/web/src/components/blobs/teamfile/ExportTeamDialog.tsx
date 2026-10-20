// "Share your team" / "Export <blob>". A team file is one Markdown file; this dialog shows EXACTLY what goes in it before
// anything is written - tick and untick blobs, groups, Kora's description, routines and skills - and what is removed or
// never included. The numbers come from the daemon's own export (so the scrub note is the real one), refreshed as you tick.

import { cn } from "~/util/utils";
import { STARTER_OUTFITS, BlobAvatar } from "~/components/blobs/avatar";
import {
  NEVER_INCLUDED_DEFAULT,
  type ExportGroupOption,
  type ExportBlobOption,
  type ExportReportWire,
  initialSelection,
  type ExportSelection,
  type TeamExportApi,
  exportSummary,
  bytesLabel,
  groupKeeps,
  toggleId,
  plural,
} from "./teamfileModel";
import { Input } from "../../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { useEffect, useState, useMemo, useRef } from "react";
import { ShieldCheckIcon, DownloadIcon, CheckIcon, CopyIcon, LockIcon } from "lucide-react";

function Tick(props: { readonly on: boolean; readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-md ring-1 transition-colors ring-inset",
        props.on ? "bg-foreground text-background ring-foreground" : "ring-border",
        props.className,
      )}
    >
      {props.on ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

function Row(props: {
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.on}
      aria-disabled={props.disabled}
      data-export-row={props.testId}
      onClick={() => !props.disabled && props.onToggle()}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.disabled ? "opacity-50" : "hover:bg-muted/60",
        props.on && !props.disabled && "bg-foreground/[0.04]",
      )}
    >
      <Tick on={props.on && !props.disabled} />
      {props.children}
    </button>
  );
}

const SectionTitle = (props: { readonly children: React.ReactNode }) => (
  <div className="px-1 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">
    {props.children}
  </div>
);

export function ExportTeamDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly blobs: ReadonlyArray<ExportBlobOption>;
  readonly groups: ReadonlyArray<ExportGroupOption>;
  /** Kora's blob id (groups that include her keep her). */
  readonly koraId: string | null;
  /** Opened from one blob's menu: only that blob starts ticked. */
  readonly onlyBlobId?: string;
  readonly api: TeamExportApi;
  /** Test seam / no debounce in tests. */
  readonly debounceMs?: number;
}) {
  const { blobs, groups, api } = props;
  const [sel, setSel] = useState<ExportSelection>(() =>
    initialSelection(blobs, groups, props.onlyBlobId ? { blobId: props.onlyBlobId } : undefined),
  );
  const [report, setReport] = useState<ExportReportWire | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (props.open) {
      setSel(
        initialSelection(
          blobs,
          groups,
          props.onlyBlobId ? { blobId: props.onlyBlobId } : undefined,
        ),
      );
      setReport(null);
      setErr(null);
      setDone(null);
    }
    // re-seed only when the dialog opens
  }, [props.open, props.onlyBlobId]);

  // The roster can still be loading when the dialog opens (many blobs): the selection was seeded empty ("Tick at least one blob")
  // and stayed that way. When the options arrive and nothing is ticked, tick them like a fresh open would.
  const seeded = useRef(0);
  useEffect(() => {
    if (!props.open) return;
    if (blobs.length > seeded.current && sel.blobIds.length === 0) {
      setSel(
        initialSelection(
          blobs,
          groups,
          props.onlyBlobId ? { blobId: props.onlyBlobId } : undefined,
        ),
      );
    }
    seeded.current = blobs.length;
  }, [blobs.length, groups.length, props.open]);

  useEffect(() => {
    if (!props.open) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void api.preview(sel).then((r) => {
        if (mine !== seq.current) return;
        if (r.ok) {
          setReport(r.value);
          setErr(null);
        } else setErr(r.message);
      });
    }, props.debounceMs ?? 120);
    return () => clearTimeout(t);
  }, [sel, props.open, api, props.debounceMs]);

  const groupState = useMemo(
    () => groups.map((g) => ({ g, ...groupKeeps(g, sel, props.koraId) })),
    [groups, sel, props.koraId],
  );
  const groupsOk = groupState.filter((s) => sel.groupIds.includes(s.g.id) && s.ok).length;
  const nothing = sel.blobIds.length === 0;
  const single = sel.blobIds.length === 1 && groupsOk === 0;
  const memberName = (id: string) =>
    id === props.koraId ? "Kora" : (blobs.find((b) => b.id === id)?.name ?? "?");

  const run = async (kind: "save" | "copy") => {
    if (nothing || busy) return;
    setBusy(kind);
    setErr(null);
    setDone(null);
    const r = kind === "save" ? await api.save(sel) : await api.copy(sel);
    setBusy(null);
    if (!r.ok) setErr(r.message);
    else if (kind === "copy") setDone("Copied. Paste it anywhere.");
    else {
      const path = (r.value as { path: string | null }).path;
      if (path === null) return; // the save sheet was cancelled
      setDone("Saved.");
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg" data-export-dialog>
        <DialogHeader>
          <DialogTitle>
            {single
              ? `Share ${blobs.find((b) => b.id === sel.blobIds[0])?.name ?? "this blob"}`
              : "Share your team"}
          </DialogTitle>
          <DialogDescription>
            One Markdown file anyone can open in Kora. Here is everything that goes in it. Nothing
            else does.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 max-h-[min(62vh,640px)] flex-col gap-4 overflow-y-auto px-6 pb-5">
          {!single || sel.name ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium">File name</span>
              <Input
                value={sel.name}
                onChange={(e) => setSel({ ...sel, name: e.target.value })}
                placeholder="My team"
                aria-label="Team name"
                autoComplete="off"
                spellCheck={false}
                data-export-name
              />
            </label>
          ) : null}

          {/* Up top: the reassurance is the first thing someone sharing a team wants, not something to scroll for. */}
          <section aria-label="Never included" className="rounded-xl ring-1 ring-border ring-inset">
            <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[12.5px] font-medium">
              <LockIcon className="size-3.5" aria-hidden />
              Never in the file
            </div>
            <ul
              className="flex flex-wrap gap-x-4 gap-y-1 px-3 pb-2.5 text-[12px] text-muted-foreground"
              data-export-never
            >
              {(report?.neverIncluded ?? NEVER_INCLUDED_DEFAULT).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>

          <section aria-label="Blobs">
            <SectionTitle>Blobs</SectionTitle>
            <div className="flex flex-col gap-0.5">
              {blobs.map((b) => {
                const on = sel.blobIds.includes(b.id);
                const detail = report?.blobs.find((x) => x.id === b.id);
                return (
                  <Row
                    key={b.id}
                    on={on}
                    testId={b.id}
                    onToggle={() => setSel({ ...sel, blobIds: toggleId(sel.blobIds, b.id) })}
                  >
                    <span className="grid size-8 shrink-0 place-items-center">
                      <BlobAvatar outfit={b.outfit} size={28} still eyesFollowCursor={false} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{b.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {[
                          b.title,
                          "personality",
                          sel.skills && b.skills ? plural(b.skills, "skill") : null,
                          sel.routines && b.routines ? plural(b.routines, "routine") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    {on && detail && detail.removed > 0 ? (
                      <span
                        className="shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground"
                        data-export-removed
                      >
                        {detail.removed} removed
                      </span>
                    ) : null}
                  </Row>
                );
              })}
            </div>
          </section>

          {groups.length > 0 ? (
            <section aria-label="Groups">
              <SectionTitle>Groups</SectionTitle>
              <div className="flex flex-col gap-0.5">
                {groupState.map(({ g, kept, ok }) => (
                  <Row
                    key={g.id}
                    on={sel.groupIds.includes(g.id)}
                    disabled={!ok}
                    testId={g.id}
                    onToggle={() => setSel({ ...sel, groupIds: toggleId(sel.groupIds, g.id) })}
                  >
                    <span
                      aria-hidden
                      className="grid size-8 shrink-0 place-items-center text-[15px] font-medium text-muted-foreground"
                    >
                      #
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{g.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {ok
                          ? g.memberIds.map(memberName).join(", ")
                          : `Only ${kept} of its members are ticked`}
                      </span>
                    </span>
                  </Row>
                ))}
              </div>
            </section>
          ) : null}

          <section aria-label="Also in the file">
            <SectionTitle>Also</SectionTitle>
            <div className="flex flex-col gap-0.5">
              <Row
                on={sel.chief}
                testId="chief"
                onToggle={() => setSel({ ...sel, chief: !sel.chief })}
              >
                <span className="grid size-8 shrink-0 place-items-center">
                  <BlobAvatar
                    outfit={STARTER_OUTFITS.kora}
                    chief
                    chiefScale={1}
                    size={28}
                    still
                    eyesFollowCursor={false}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">Describe Kora</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    So readers see how you run things. It never changes their Kora.
                  </span>
                </span>
              </Row>
              <Row
                on={sel.routines}
                testId="routines"
                onToggle={() => setSel({ ...sel, routines: !sel.routines })}
              >
                <span className="min-w-0 flex-1 pl-0.5">
                  <span className="block text-[13.5px] font-medium">Suggested routines</span>
                  <span className="block text-[11.5px] text-muted-foreground">
                    Imported paused. They never run until turned on.
                  </span>
                </span>
              </Row>
              <Row
                on={sel.skills}
                testId="skills"
                onToggle={() => setSel({ ...sel, skills: !sel.skills })}
              >
                <span className="min-w-0 flex-1 pl-0.5">
                  <span className="block text-[13.5px] font-medium">Skill names</span>
                  <span className="block text-[11.5px] text-muted-foreground">
                    Just the names and one-liners, never their files.
                  </span>
                </span>
              </Row>
            </div>
          </section>

          {report?.scrubNote ? (
            <div
              className="flex items-start gap-2 rounded-xl bg-foreground/[0.05] px-3 py-2.5 text-[12.5px]"
              role="status"
              data-export-scrub
            >
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">{report.scrubNote}.</span>{" "}
                <span className="text-muted-foreground">
                  Secret-looking text and personal details are replaced before the file is made.
                </span>
              </span>
            </div>
          ) : null}

          {err ? (
            <p role="alert" className="text-[12.5px] text-destructive-foreground" data-export-error>
              {err}
            </p>
          ) : null}
        </div>

        <DialogFooter className="items-center">
          <span
            className="mr-auto text-[12px] text-muted-foreground tabular-nums"
            data-export-summary
            role="status"
          >
            {done ??
              (nothing
                ? "Tick at least one blob."
                : `${exportSummary(sel, groupsOk)}${report ? ` · ${bytesLabel(report.bytes)}` : ""}`)}
          </span>
          <Button
            variant="outline"
            disabled={nothing || busy !== null}
            onClick={() => void run("copy")}
            data-export-copy
          >
            <CopyIcon />
            Copy
          </Button>
          <Button
            disabled={nothing || busy !== null}
            onClick={() => void run("save")}
            data-export-save
          >
            <DownloadIcon />
            {busy === "save" ? "Saving…" : "Save file"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
