// New blob / Edit blob. One dialog, eight sections (Identity, Soul, Model, Access, Permissions, Apps, Memory, Skills).
// The draft lives only inside the open dialog: closing it (Cancel, Esc, backdrop) throws it away.

import { cn, getLocalFileManagerName } from "~/util/utils";
import { readLocalApi } from "~/localApi";
import { readConfirmDialogState } from "~/confirm";
import { OutfitPicker } from "~/components/blobs/avatar";
import { matchingSoulPreset, SOUL_PRESETS } from "./soulPresets";
import {
  editorDraftFromBlobDraft,
  editorDraftFromBlob,
  validateEditorDraft,
  isEditorDraftDirty,
  newEditorDraft,
  toProfilePatch,
  type EditorDraft,
  toBlobDraft,
  TITLE_MAX,
  NAME_MAX,
  SOUL_MAX,
} from "./blobDraft";
import { useEngineLabel } from "../shell/useEngineLabel";
import { POSTURES } from "../shell/postureCopy";
import { newBlobFolderLabel, tildify } from "../shell/blobsRoot";
import { useBlobsState, useBlobsApi } from "../shell/blobsApi";
import { announceBlobCreated } from "../shell/blobReaction";
import { suggestBlobName } from "../shell/blobNames";
import { BlobModelField } from "../shell/BlobModelPicker";
import { useBlobPanel } from "../chat/blobPanelStore";
import { BrowserSettingsFor } from "../browser/BrowserSettings";
import { AppGrantsEditor } from "../apps/AppGrantsEditor";
import { toastManager } from "../../ui/toast";
import { Textarea } from "../../ui/textarea";
import { Switch } from "../../ui/switch";
import { Spinner } from "../../ui/spinner";
import { Input } from "../../ui/input";
import {
  DialogHeader,
  DialogPopup,
  DialogDescription,
  Dialog,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import type { BlobDefaults, BlobDetail, BlobDraft } from "@kora/contracts";
import { type ComponentType, useEffect, useState, useMemo } from "react";
import {
  ShieldCheckIcon,
  BookOpenIcon,
  SparklesIcon,
  FolderIcon,
  BrainIcon,
  DicesIcon,
  CopyIcon,
  PlugIcon,
  UserIcon,
  CpuIcon,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";

type SectionId =
  | "identity"
  | "soul"
  | "model"
  | "access"
  | "permissions"
  | "apps"
  | "memory"
  | "skills";

const SECTIONS: ReadonlyArray<{
  id: SectionId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  editOnly?: boolean;
}> = [
  { id: "identity", label: "Identity", icon: UserIcon },
  { id: "soul", label: "Soul", icon: SparklesIcon },
  { id: "model", label: "Model", icon: CpuIcon },
  { id: "access", label: "Access", icon: FolderIcon },
  { id: "permissions", label: "Permissions", icon: ShieldCheckIcon },
  { id: "apps", label: "Apps", icon: PlugIcon, editOnly: true },
  { id: "memory", label: "Memory", icon: BrainIcon, editOnly: true },
  { id: "skills", label: "Skills", icon: BookOpenIcon, editOnly: true },
];

export function BlobEditorDialog(props: {
  readonly open: boolean;
  /** null = a new blob. */
  readonly blobId: string | null;
  readonly onOpenChange: (open: boolean) => void;
  /** A new blob that starts from this draft (Tweak on a proposal card). */
  readonly initialDraft?: BlobDraft;
  /** The proposal the draft came from: Create passes it to `blobs.create` so the card flips to hired. */
  readonly proposalId?: string;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        className="h-[min(640px,calc(100dvh-2rem))] max-w-[860px] overflow-hidden"
        data-blob-editor
      >
        {props.open ? (
          <EditorBody
            blobId={props.blobId}
            onClose={() => props.onOpenChange(false)}
            {...(props.initialDraft ? { initialDraft: props.initialDraft } : {})}
            {...(props.proposalId ? { proposalId: props.proposalId } : {})}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function EditorBody({
  blobId,
  onClose,
  initialDraft,
  proposalId,
}: {
  blobId: string | null;
  onClose: () => void;
  initialDraft?: BlobDraft;
  proposalId?: string;
}) {
  const api = useBlobsApi();
  const router = useRouter();
  const panel = useBlobPanel();
  const { snapshot } = useBlobsState();
  const labelOf = useEngineLabel();
  const isNew = blobId === null;
  const [loaded, setLoaded] = useState<{
    draft: EditorDraft;
    detail: BlobDetail | null;
  } | null>(null);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [section, setSection] = useState<SectionId>("identity");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touchedName, setTouchedName] = useState(false);

  const blobs = snapshot?.blobs ?? [];
  const takenNames = useMemo(
    () => blobs.filter((b) => !b.archivedAt && b.id !== blobId).map((b) => b.name),
    [blobs, blobId],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (isNew && initialDraft) {
        const initial = editorDraftFromBlobDraft(initialDraft);
        setTouchedName(true);
        setLoaded({ draft: initial, detail: null });
        setDraft(initial);
        return;
      }
      if (isNew) {
        const r = await api.getDefaults();
        const defaults: BlobDefaults | null = r.ok ? r.value : null;
        const initial = newEditorDraft({ defaults, takenNames });
        if (!cancelled) {
          setLoaded({ draft: initial, detail: null });
          setDraft(initial);
        }
        return;
      }
      const r = await api.get(blobId);
      if (cancelled) return;
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const initial = editorDraftFromBlob(r.value.profile, r.value.soul);
      setLoaded({ draft: initial, detail: r.value });
      setDraft(initial);
    };
    void load();
    return () => {
      cancelled = true;
    };
    // The draft is built once when the dialog opens; later roster changes must not reset what you typed.
  }, [blobId]);

  const chief = loaded?.detail?.profile.role === "chief";
  const errors = draft ? validateEditorDraft(draft, blobs, blobId) : {};
  const dirty = draft && loaded ? isEditorDraftDirty(draft, loaded.draft) : false;
  const canSave = draft !== null && !saving && Object.keys(errors).length === 0 && (isNew || dirty);

  const requestClose = async () => {
    if (saving) return;
    if (dirty) {
      const ok = await readLocalApi()?.dialogs.confirm("Discard your changes?", {
        variant: "destructive",
        confirmLabel: "Discard",
        description: "What you changed on this blob has not been saved.",
      });
      if (!ok) return;
    }
    onClose();
  };

  const save = async () => {
    if (!draft || !loaded || !canSave) return;
    setSaving(true);
    setError(null);
    if (isNew) {
      const r = await api.create(toBlobDraft(draft, initialDraft), proposalId ?? null);
      if (!r.ok) {
        setSaving(false);
        return setError(r.message);
      }
      // Helpers are on for every new blob; a draft that switched them off says so right after the hire.
      if (!draft.helpers) await api.update(r.value.id, { helpers: false });
      setSaving(false);
      announceBlobCreated(r.value.id);
      onClose();
      if (proposalId) {
        // A tweaked proposal is answered inside Kora's chat: stay there (the card flips to hired).
        toastManager.add({ type: "success", title: `${r.value.name} is on the team` });
        return;
      }
      void router.navigate({ to: "/blobs/$blobId", params: { blobId: r.value.id } });
      return;
    }
    const patch = toProfilePatch(loaded.draft, draft, loaded.detail?.profile.toolGrants);
    if (Object.keys(patch).length > 0) {
      const r = await api.update(blobId, patch);
      if (!r.ok) {
        setSaving(false);
        return setError(r.message);
      }
    }
    if (draft.soul.trim() !== loaded.draft.soul.trim()) {
      const r = await api.setSoul(blobId, draft.soul.trim());
      if (!r.ok) {
        setSaving(false);
        return setError(r.message);
      }
    }
    setSaving(false);
    toastManager.add({ type: "success", title: `${draft.name.trim()} saved` });
    onClose();
  };

  // Escape / backdrop go through the same discard guard as Cancel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // A confirm on top ("Discard your changes?") owns Escape: it closes itself and the editor stays.
        if (readConfirmDialogState().status !== "idle") return;
        event.stopPropagation();
        void requestClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const visible = SECTIONS.filter((s) => !s.editOnly || !isNew);

  if (error && !draft) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div>
          <p className="text-sm text-foreground">{error}</p>
          <Button className="mt-4" variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (!draft || !loaded) {
    return (
      <div className="grid flex-1 place-items-center" aria-busy>
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  const patch = (next: Partial<EditorDraft>) => setDraft((d) => (d ? { ...d, ...next } : d));

  return (
    <>
      <DialogHeader className="pb-3">
        <DialogTitle>{isNew ? "New blob" : `Edit ${loaded.draft.name}`}</DialogTitle>
        <DialogDescription>
          {isNew
            ? "A coworker with its own personality, model and memory."
            : "Changes apply to its next thread."}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 border-t border-border/70 max-sm:flex-col">
        <nav
          role="tablist"
          aria-label="Blob settings"
          aria-orientation="vertical"
          className="flex shrink-0 gap-0.5 p-2 sm:w-44 sm:flex-col sm:border-e sm:border-border/70 max-sm:overflow-x-auto"
        >
          {visible.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              data-editor-section={s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                section === s.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <s.icon className="size-3.5 shrink-0" />
              {s.label}
              {s.id === "identity" && errors.name ? (
                <span aria-hidden className="ms-auto size-1.5 rounded-full bg-destructive" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5" role="tabpanel">
          {section === "identity" ? (
            <Section title="Identity" hint="Name, role and how it looks.">
              <Field label="Name" {...(errors.name && touchedName ? { error: errors.name } : {})}>
                <div className="flex gap-2">
                  <Input
                    aria-label="Name"
                    aria-invalid={!!errors.name && touchedName}
                    value={draft.name}
                    maxLength={NAME_MAX + 8}
                    onChange={(e) => {
                      setTouchedName(true);
                      patch({ name: e.target.value });
                    }}
                    onBlur={() => setTouchedName(true)}
                    placeholder="Popo"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    aria-label="Suggest a name"
                    onClick={() => {
                      setTouchedName(false);
                      patch({ name: suggestBlobName(takenNames, Math.random, draft.name) });
                    }}
                  >
                    <DicesIcon />
                    <span className="max-sm:sr-only">Suggest</span>
                  </Button>
                </div>
              </Field>
              <Field label="Title" hint="What it does for you, in a word or two.">
                <Input
                  aria-label="Title"
                  value={draft.title}
                  maxLength={TITLE_MAX}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder="Researcher"
                />
              </Field>
              <Field label="Outfit">
                <OutfitPicker
                  value={draft.outfit}
                  chief={chief}
                  compact
                  onChange={(outfit) => patch({ outfit })}
                />
              </Field>
            </Section>
          ) : null}

          {section === "soul" ? (
            <Section
              title="Soul"
              hint="Its personality and standing instructions. It is always a warm, concise coworker; this adds character."
            >
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label="Starter personalities"
              >
                {SOUL_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-soul-preset={p.id}
                    aria-pressed={matchingSoulPreset(draft.soul)?.id === p.id}
                    onClick={() => patch({ soul: p.text })}
                    className={cn(
                      "h-7 rounded-full px-3 text-[12px] ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      matchingSoulPreset(draft.soul)?.id === p.id
                        ? "bg-foreground text-background ring-foreground"
                        : "text-muted-foreground ring-border hover:text-foreground hover:ring-foreground/40",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Textarea
                aria-label="Personality"
                value={draft.soul}
                onChange={(e) => patch({ soul: e.target.value })}
                className="mt-3"
                size="lg"
                rows={9}
                placeholder="How should this blob behave?"
              />
              <div className="mt-1.5 flex justify-between text-[11.5px] text-muted-foreground">
                <span className={errors.soul ? "text-destructive" : ""}>{errors.soul ?? " "}</span>
                <span className="tabular-nums">
                  {draft.soul.length.toLocaleString()} / {SOUL_MAX.toLocaleString()}
                </span>
              </div>
            </Section>
          ) : null}

          {section === "model" ? (
            <Section
              title="Model"
              hint="Which AI runs this blob. Your own subscription, nothing proxied."
            >
              <BlobModelField
                value={draft.engine}
                bestLabel={snapshot?.engines.best ? labelOf(snapshot.engines.best) : null}
                onChange={(engine) => patch({ engine })}
              />
            </Section>
          ) : null}

          {section === "access" ? (
            <Section
              title="Access"
              hint="Where this blob works. It reads and writes freely in its own folder."
            >
              <div className="rounded-xl bg-card p-3 ring-1 ring-border">
                <div className="flex items-center gap-2">
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <code
                    className="min-w-0 flex-1 truncate text-[12.5px] text-foreground"
                    data-blob-workspace
                  >
                    {loaded.detail?.profile.workspace
                      ? tildify(loaded.detail.profile.workspace)
                      : newBlobFolderLabel(snapshot?.blobs ?? [], draft.name)}
                  </code>
                  {loaded.detail ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(loaded.detail!.profile.workspace);
                          toastManager.add({ type: "success", title: "Path copied" });
                        } catch {
                          toastManager.add({ type: "error", title: "Could not copy the path" });
                        }
                      }}
                    >
                      <CopyIcon />
                      Copy
                    </Button>
                  ) : null}
                </div>
                <p className="mt-2 text-[12px] leading-snug text-muted-foreground">
                  {isNew
                    ? `Created for you in ${getLocalFileManagerName(navigator.platform)} when you hire this blob. `
                    : `Visible in ${getLocalFileManagerName(navigator.platform)}. Renaming the blob does not move it. `}
                  Anything outside this folder, it asks first.
                </p>
              </div>
              {loaded.detail?.profile && loaded.detail.profile.role !== "chief" ? (
                <div className="mt-4 space-y-1.5" data-blob-browser-access>
                  <div className="text-[12.5px] font-medium text-foreground">Its browser</div>
                  <p className="text-[12px] leading-snug text-muted-foreground">
                    A private browser of its own, set up once from the Computer tab (a 98 MB
                    download, never in the middle of a chat).
                  </p>
                  <BrowserSettingsFor blobId={loaded.detail.profile.id} />
                </div>
              ) : null}
            </Section>
          ) : null}

          {section === "permissions" ? (
            <Section title="Permissions" hint="How much it may do without asking.">
              <div role="radiogroup" aria-label="Permissions" className="grid gap-2">
                {PERMISSIONS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.permission === p.id}
                    data-permission={p.id}
                    onClick={() => patch({ permission: p.id })}
                    className={cn(
                      "flex items-start gap-3 rounded-xl p-3 text-left ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      draft.permission === p.id
                        ? "bg-card ring-foreground/40"
                        : "ring-border hover:bg-card/60",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ring-1",
                        draft.permission === p.id ? "ring-foreground" : "ring-border",
                      )}
                    >
                      {draft.permission === p.id ? (
                        <span className="size-2 rounded-full bg-foreground" />
                      ) : null}
                    </span>
                    <span>
                      <span className="block text-[13px] font-medium text-foreground">
                        {p.label}
                        {p.id === "auto" ? (
                          <span className="ms-1.5 text-[11px] font-normal text-muted-foreground">
                            recommended
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                        {p.body}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[11.5px] leading-snug text-muted-foreground">
                Kora’s own tools always ask before sending, posting, deleting or paying, on every
                model. Codex and free models can’t pause a shell command, so there the blob is also
                told to ask in chat first.
              </p>
              <div
                className="mt-5 flex items-start justify-between gap-4 rounded-xl p-3 ring-1 ring-border"
                data-helpers-row
              >
                <div>
                  <p className="text-[13px] font-medium text-foreground">Free helpers</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                    Lets {draft.name.trim() || "this blob"} hand reading and checking legwork to
                    free models, at most two at a time, so your own plan is spent on the thinking.
                    When the free models are busy or down it just does the work itself.
                  </p>
                </div>
                <Switch
                  aria-label="Free helpers"
                  checked={draft.helpers}
                  onCheckedChange={(next) => patch({ helpers: next })}
                />
              </div>
            </Section>
          ) : null}

          {section === "apps" ? (
            <Section
              title="Apps"
              hint="Which of your connected apps this blob may use. Nothing is allowed until you say so."
            >
              <AppGrantsEditor
                blobName={loaded.draft.name}
                grants={draft.apps}
                onChange={(apps) => patch({ apps })}
              />
            </Section>
          ) : null}

          {section === "memory" ? (
            <Section title="Memory" hint="What this blob remembers about you and your work.">
              <p className="text-[12.5px] leading-snug text-muted-foreground">
                Memory has its own tab: see every fact with its date and source, correct or forget
                it, and edit the always-on notes.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                onClick={() => {
                  panel.show("memory");
                  onClose();
                  if (blobId) void router.navigate({ to: "/blobs/$blobId", params: { blobId } });
                }}
              >
                <BrainIcon />
                Open the Memory tab
              </Button>
            </Section>
          ) : null}

          {section === "skills" ? (
            <Section title="Skills" hint="Playbooks this blob can read when a job calls for one.">
              {(loaded.detail?.skills.length ?? 0) === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">No skills yet.</p>
              ) : (
                <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-border">
                  {loaded.detail!.skills.map((s) => (
                    <li key={s.name} className="flex items-start gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-foreground">{s.name}</div>
                        {s.description ? (
                          <div className="text-[12px] leading-snug text-muted-foreground">
                            {s.description}
                          </div>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">
                        {s.enabled ? "On" : "Off"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}
        </div>
      </div>
      <DialogFooter variant="bare" className="items-center border-t border-border/70">
        {error ? (
          <span role="alert" className="me-auto text-[12px] text-destructive">
            {error}
          </span>
        ) : null}
        <Button variant="ghost" onClick={() => void requestClose()} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={!canSave} data-editor-save>
          {saving ? <Spinner className="size-3.5" /> : null}
          {isNew ? "Create blob" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}

const PERMISSIONS = POSTURES;

function Section(props: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{props.title}</h3>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{props.hint}</p>
      </header>
      {props.children}
    </section>
  );
}

function Field(props: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-foreground">{props.label}</span>
        {props.hint ? (
          <span className="text-[11.5px] text-muted-foreground">{props.hint}</span>
        ) : null}
      </div>
      {props.children}
      {props.error ? (
        <p role="alert" className="text-[11.5px] text-destructive">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
