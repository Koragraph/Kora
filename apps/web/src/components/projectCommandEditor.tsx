import { Textarea } from "./ui/textarea";
import { Switch } from "./ui/switch";
import { PopoverTrigger, PopoverPopup, Popover } from "./ui/popover";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogHeader,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogPanel,
  DialogPopup,
} from "./ui/dialog";
import { Button } from "./ui/button";
import {
  AlertDialogPopup,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
  AlertDialogTitle,
  AlertDialog,
  AlertDialogHeader,
} from "./ui/alert-dialog";
import { cn } from "../util/utils";
import type { ProjectCommandIcon, ProjectAction } from "@kora/contracts";
import {
  type AtomActionResult,
  squashAtomActionFailure,
  isAtomActionInterrupted,
} from "@kora/client-runtime/store/runtime";
import { useLayoutEffect, type FormEvent, useState, useRef } from "react";
import {
  FlaskConicalIcon,
  ListChecksIcon,
  HammerIcon,
  type LucideIcon,
  WrenchIcon,
  PlayIcon,
  BugIcon,
} from "lucide-react";

const ICONS: ReadonlyArray<{ id: ProjectCommandIcon; label: string; Icon: LucideIcon }> = [
  { id: "play", label: "Play", Icon: PlayIcon },
  { id: "test", label: "Test", Icon: FlaskConicalIcon },
  { id: "lint", label: "Lint", Icon: ListChecksIcon },
  { id: "configure", label: "Configure", Icon: WrenchIcon },
  { id: "build", label: "Build", Icon: HammerIcon },
  { id: "debug", label: "Debug", Icon: BugIcon },
];

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectCommandIcon;
  className?: string;
}) {
  const Icon = ICONS.find((entry) => entry.id === icon)?.Icon ?? PlayIcon;
  return <Icon className={className} />;
}

export interface NewProjectCommandInput {
  /** Setup scripts only. */
  waitForSetup: boolean;
  runOnWorktreeCreate: boolean;
  previewUrl: string | null;
  icon: ProjectCommandIcon;
  autoOpenPreview: boolean;
  command: string;
  name: string;
}

export type ProjectCommandActionResult = AtomActionResult<void, unknown>;

type ScriptSubmitHandler = (
  id: string | null,
  values: NewProjectCommandInput,
) => Promise<ProjectCommandActionResult>;

export const EMPTY_PROJECT_COMMAND_INPUT: NewProjectCommandInput = {
  autoOpenPreview: false,
  previewUrl: null,
  waitForSetup: false,
  runOnWorktreeCreate: false,
  icon: "play",
  command: "",
  name: "",
};

export interface ProjectCommandEditorRequest {
  error?: string;
  initial: NewProjectCommandInput;
  /** null = adding a new script. */
  scriptId: string | null;
}

export function editorRequestForScript(script: ProjectAction): ProjectCommandEditorRequest {
  return {
    initial: {
      waitForSetup: script.runOnWorktreeCreate && script.async === false,
      autoOpenPreview: script.autoOpenPreview ?? false,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      previewUrl: script.previewUrl ?? null,
      command: script.command,
      name: script.name,
      icon: script.icon,
    },
    scriptId: script.id,
  };
}

const switchRowClass =
  "flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]";

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Failed to save action.";
}

export function ProjectCommandEditorDialog(props: {
  request: ProjectCommandEditorRequest | null;
  onSubmit: ScriptSubmitHandler;
  onClose: () => void;
  onDelete: (scriptId: string) => void;
}) {
  const { request, onSubmit, onDelete, onClose } = props;
  const [form, setForm] = useState<NewProjectCommandInput>(EMPTY_PROJECT_COMMAND_INPUT);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Identifies the request whose save is in flight; anything finishing for another request is ignored.
  const pending = useRef<ProjectCommandEditorRequest | null>(null);

  useLayoutEffect(() => {
    if (!request) return;
    setForm(request.initial);
    setIconPickerOpen(false);
    setError(request.error ?? null);
    setSaving(false);
    setConfirmingDelete(false);
    return () => {
      pending.current = null;
    };
  }, [request]);

  const editing = request?.scriptId != null;
  const patch = (next: Partial<NewProjectCommandInput>) =>
    setForm((current) => ({ ...current, ...next }));

  const close = () => {
    pending.current = null;
    setSaving(false);
    setIconPickerOpen(false);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || pending.current !== null) return;
    const name = form.name.trim();
    const command = form.command.trim();
    if (name === "") return setError("Name is required.");
    if (command === "") return setError("Command is required.");
    const previewUrl = form.previewUrl?.trim() || null;
    const payload: NewProjectCommandInput = {
      name,
      command,
      icon: form.icon,
      runOnWorktreeCreate: form.runOnWorktreeCreate,
      waitForSetup: form.runOnWorktreeCreate && form.waitForSetup,
      previewUrl,
      autoOpenPreview: previewUrl !== null && form.autoOpenPreview,
    };

    pending.current = request;
    setError(null);
    setSaving(true);
    const finishFailure = (message: string) => {
      if (pending.current !== request) return;
      pending.current = null;
      setSaving(false);
      setError(message);
    };
    try {
      const result = await onSubmit(request.scriptId, payload);
      if (pending.current !== request) return;
      if (result._tag === "Failure") {
        if (isAtomActionInterrupted(result)) {
          pending.current = null;
          setSaving(false);
          return;
        }
        finishFailure(failureMessage(squashAtomActionFailure(result)));
        return;
      }
      close();
    } catch (cause) {
      finishFailure(failureMessage(cause));
    }
  };

  const handleClick = () => {
    const scriptId = request?.scriptId;
    setConfirmingDelete(false);
    close();
    if (scriptId != null) onDelete(scriptId);
  };

  const dialogDescriptionPart = (
    <DialogDescription>
      Actions are project-scoped commands you can run from the top bar.
    </DialogDescription>
  );

  const popoverTriggerPart = (
    <PopoverTrigger
      render={
        <Button
          className="size-9 shrink-0 hover:bg-popover data-pressed:bg-popover dark:border-transparent dark:bg-white/[0.035]"
          aria-label="Choose icon"
          variant="outline"
          type="button"
        />
      }
    >
      <ScriptIcon icon={form.icon} className="size-[18px]" />
    </PopoverTrigger>
  );

  const divPart = (
    <div className="grid grid-cols-3 gap-2">
      {ICONS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className={cn(
            "relative flex flex-col items-center gap-2 rounded-md border p-2 text-xs",
            form.icon === id
              ? "border-primary/70 bg-primary/10 dark:ring-1 dark:ring-primary/30"
              : "border-border/70 hover:bg-accent/60 dark:border-transparent dark:bg-white/[0.035]",
          )}
          onClick={() => {
            patch({ icon: id });
            setIconPickerOpen(false);
          }}
        >
          <Icon className="size-4" />
          {label}
        </button>
      ))}
    </div>
  );

  const alertDialogHeaderPart = (
    <AlertDialogHeader>
      <AlertDialogTitle>Delete action "{form.name}"?</AlertDialogTitle>
      <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
    </AlertDialogHeader>
  );

  const alertDialogFooterPart = (
    <AlertDialogFooter>
      <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
      <Button onClick={handleClick} variant="destructive" disabled={saving}>
        Delete action
      </Button>
    </AlertDialogFooter>
  );

  return (
    <>
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup>
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Action" : "Add Action"}</DialogTitle>
              {dialogDescriptionPart}
            </DialogHeader>
            <DialogPanel>
              <fieldset disabled={saving} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="script-name">Name</Label>
                  <div className="flex items-center gap-2">
                    <Popover open={iconPickerOpen} onOpenChange={setIconPickerOpen}>
                      {popoverTriggerPart}
                      <PopoverPopup align="start">{divPart}</PopoverPopup>
                    </Popover>
                    <Input
                      onChange={(event) => patch({ name: event.target.value })}
                      placeholder="Test"
                      value={form.name}
                      id="script-name"
                      autoFocus
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="script-command">Command</Label>
                  <Textarea
                    onChange={(event) => patch({ command: event.target.value })}
                    placeholder="bun test"
                    value={form.command}
                    id="script-command"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="script-preview-url">Preview URL (optional)</Label>
                  <Input
                    onChange={(event) => patch({ previewUrl: event.target.value })}
                    placeholder="http://localhost:5173"
                    value={form.previewUrl ?? ""}
                    id="script-preview-url"
                  />
                  <p className="text-xs text-muted-foreground">
                    Open this URL in the in-app preview when this action runs.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <label className={switchRowClass}>
                    Run automatically on worktree creation
                    <Switch
                      checked={form.runOnWorktreeCreate}
                      onCheckedChange={(checked) => patch({ runOnWorktreeCreate: checked })}
                    />
                  </label>
                  <label className={cn(switchRowClass, !form.runOnWorktreeCreate && "opacity-60")}>
                    Wait for it to finish before the agent starts
                    <Switch
                      checked={form.waitForSetup}
                      disabled={!form.runOnWorktreeCreate}
                      onCheckedChange={(checked) => patch({ waitForSetup: checked })}
                    />
                  </label>
                  <label
                    className={cn(switchRowClass, !(form.previewUrl ?? "").trim() && "opacity-60")}
                  >
                    Open preview automatically when this action runs
                    <Switch
                      checked={form.autoOpenPreview}
                      disabled={!(form.previewUrl ?? "").trim()}
                      onCheckedChange={(checked) => patch({ autoOpenPreview: checked })}
                    />
                  </label>
                </div>

                {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
              </fieldset>
            </DialogPanel>
            <DialogFooter className="dark:border-transparent dark:bg-transparent">
              {editing ? (
                <Button
                  onClick={() => setConfirmingDelete(true)}
                  variant="destructive-outline"
                  className="mr-auto"
                  type="button"
                >
                  Delete
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : "Save action"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogPopup>
          {alertDialogHeaderPart}
          {alertDialogFooterPart}
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
