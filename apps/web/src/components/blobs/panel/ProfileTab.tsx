// Profile: who this blob is, at a glance, with the way into the full editor.
import type { BlobDetail } from "@kora/contracts";
import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { BlobAvatar } from "~/components/blobs/avatar";
import { readLocalApi } from "~/localApi";
import { toastManager } from "../../ui/toast";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { DecisionLog } from "../apps/DecisionLog";
import { grantsLine, normalizeGrants } from "../apps/appsModel";
import { BlobEditorDialog } from "../editor/BlobEditorDialog";
import { useEngineLabel } from "../shell/useEngineLabel";
import { useBlobsApi } from "../shell/blobsApi";
import { PathText } from "../shell/PathText";
import type { RosterEntry } from "../shell/useBlobRoster";

const PERMISSION_LABEL = { ask: "Ask", auto: "Auto", full: "Full" } as const;

export function ProfileTab(props: { readonly entry: RosterEntry }) {
  const { entry } = props;
  const { blob, chief, status } = entry;
  const labelOf = useEngineLabel();
  const api = useBlobsApi();
  const [detail, setDetail] = useState<BlobDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  // Same words and call as the roster's right-click "Retire…" (BlobsNavContent): the profile is where people look first.
  const retire = async () => {
    const ok = await readLocalApi()?.dialogs.confirm(
      `Retire ${blob.name}? Its chats, memory and files are kept, and you can rehire it later.`,
      { confirmLabel: `Retire ${blob.name}` },
    );
    if (!ok) return;
    setRetiring(true);
    const r = await api.archive(blob.id);
    setRetiring(false);
    if (!r.ok) toastManager.add({ type: "error", title: r.message });
  };

  useEffect(() => {
    let cancelled = false;
    void api.get(blob.id).then((r) => {
      if (!cancelled && r.ok) setDetail(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [blob.id, blob.updatedAt, api.hostId]);

  return (
    <div className="space-y-5 p-4" data-blob-profile>
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <BlobAvatar
          outfit={entry.outfit}
          state={status.visual}
          size={96}
          chief={chief}
          badge={chief}
          label={blob.name}
        />
        <div className={chief ? "pt-3" : undefined}>
          <div className="text-[17px] font-semibold tracking-tight text-foreground">
            {blob.name}
          </div>
          {blob.title ? (
            <div className="text-[12.5px] text-muted-foreground">{blob.title}</div>
          ) : null}
        </div>
        <Button variant="outline" size="xs" onClick={() => setEditing(true)} data-edit-blob>
          <PencilIcon />
          Edit blob
        </Button>
      </div>

      <dl className="divide-y divide-border/60 rounded-xl text-[12.5px] ring-1 ring-border/70">
        <Row label="Model">{labelOf(blob.engine)}</Row>
        <Row label="Permissions">{PERMISSION_LABEL[blob.permission]}</Row>
        <Row label="Folder">
          <PathText path={blob.workspace} className="text-[11.5px]" />
        </Row>
      </dl>

      <AlwaysAllowed blob={blob} />

      <section>
        <h4 className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Soul
        </h4>
        <p className="line-clamp-[8] text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/85">
          {detail ? detail.soul || "No personality written yet." : " "}
        </p>
      </section>

      {detail && detail.skills.length > 0 ? (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Skills
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {detail.skills.map((s) => (
              <li key={s.name}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="block rounded-full px-2.5 py-0.5 text-[11.5px] text-muted-foreground ring-1 ring-border/70">
                        {s.name}
                      </span>
                    }
                  />
                  <TooltipPopup>{s.description}</TooltipPopup>
                </Tooltip>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {blob.toolGrants?.apps && normalizeGrants(blob.toolGrants.apps).mode !== "none" ? (
        <section data-blob-apps>
          <div className="mb-1.5 flex items-baseline justify-between">
            <h4 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Apps
            </h4>
            <span className="text-[11.5px] text-muted-foreground">
              {grantsLine(blob.toolGrants.apps)}
            </span>
          </div>
          <DecisionLog blobId={blob.id} />
        </section>
      ) : null}
      {chief ? null : blob.archivedAt != null ? (
        <section className="border-t border-border/60 pt-3" data-blob-retire-section>
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={retiring}
            onClick={() => {
              setRetiring(true);
              void api.rehire(blob.id).then((r) => {
                setRetiring(false);
                if (!r.ok) toastManager.add({ type: "error", title: r.message });
              });
            }}
            data-rehire-blob
          >
            <ArchiveRestoreIcon />
            Rehire {blob.name}
          </Button>
          <p className="mt-1 text-[11.5px] leading-4 text-muted-foreground">
            {blob.name} is retired: its chats, memory and files are kept.
          </p>
        </section>
      ) : (
        <section className="border-t border-border/60 pt-3" data-blob-retire-section>
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={retiring}
            onClick={() => void retire()}
            data-retire-blob
          >
            <ArchiveIcon />
            Retire {blob.name}
          </Button>
          <p className="mt-1 text-[11.5px] leading-4 text-muted-foreground">
            Its chats, memory and files are kept; you can rehire it any time.
          </p>
        </section>
      )}
      <BlobEditorDialog open={editing} blobId={blob.id} onOpenChange={setEditing} />
    </div>
  );
}

/** The standing "Always for this blob" answers (from approval cards), each with a way to take it back. */
function AlwaysAllowed(props: { readonly blob: RosterEntry["blob"] }) {
  const api = useBlobsApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rules = props.blob.toolGrants?.approvals ?? [];
  if (rules.length === 0) return null;
  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    const r = await api.update(props.blob.id, {
      toolGrants: { ...props.blob.toolGrants, approvals: rules.filter((x) => x.id !== id) },
    });
    setBusy(null);
    if (!r.ok) setError(r.message);
  };
  return (
    <section data-blob-always-allowed>
      <h4 className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        Always allowed
      </h4>
      <ul className="divide-y divide-border/60 rounded-xl text-[12.5px] ring-1 ring-border/70">
        {rules.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 break-words text-foreground/90">{r.label}</span>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null}
              onClick={() => void remove(r.id)}
              data-always-remove={r.id}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-1 text-[11.5px] text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-3 py-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 flex-1 text-foreground">{props.children}</dd>
    </div>
  );
}
