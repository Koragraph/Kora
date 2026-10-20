import { useCopyToClipboard } from "~/hooks/useCopyText";
import { useAtomAction } from "~/atoms/use-atom-command";
import { projectHost } from "~/atoms/projects";
import { threadToast, toastManager } from "../ui/toast";
import { Input } from "../ui/input";
import {
  DialogDescription,
  Dialog,
  DialogFooter,
  DialogTitle,
  DialogHeader,
  DialogPopup,
  DialogPanel,
} from "../ui/dialog";
import { Button } from "../ui/button";
import ReplyMarkdown from "../ReplyMarkdown";
import {
  buildCollapsedPlanProposalPreviewMarkdown,
  buildPlanProposalMarkdownFilename,
  normalizePlanMarkdownForExport,
  stripDisplayedPlanMarkdown,
  downloadPlanAsTextFile,
  planProposalTitle,
} from "../../planProposal";
import type { HostThreadRef, HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { useState, useMemo, memo } from "react";

const COLLAPSE_CHARS = 900;
const COLLAPSE_LINES = 20;
const PREVIEW_LINES = 10;

export const PlanProposalCard = memo(function PlanProposalCard({
  planMarkdown,
  hostId,
  threadRef,
  cwd,
  workspaceRoot,
}: {
  threadRef?: HostThreadRef | undefined;
  workspaceRoot: string | undefined;
  cwd: string | undefined;
  planMarkdown: string;
  hostId: HostId;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savePath, setSavePath] = useState("");

  const writeFile = useAtomAction(projectHost.writeFile, { reportFailure: false });

  const title = planProposalTitle(planMarkdown) ?? "Proposed plan";
  const filename = useMemo(() => buildPlanProposalMarkdownFilename(planMarkdown), [planMarkdown]);
  const exportMarkdown = useMemo(
    () => normalizePlanMarkdownForExport(planMarkdown),
    [planMarkdown],
  );
  const collapsible =
    planMarkdown.length > COLLAPSE_CHARS || planMarkdown.split("\n").length > COLLAPSE_LINES;
  const collapsed = collapsible && !expanded;
  const bodyMarkdown = collapsed
    ? buildCollapsedPlanProposalPreviewMarkdown(planMarkdown, { maxLines: PREVIEW_LINES })
    : stripDisplayedPlanMarkdown(planMarkdown);

  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) =>
      toastManager.add(
        threadToast({
          description: error.message || "An error occurred while copying.",
          title: "Could not copy plan",
          type: "error",
        }),
      ),
    target: "plan",
  });

  const openSave = () => {
    if (!workspaceRoot) {
      toastManager.add({
        description: "This chat does not have a workspace path to save into.",
        title: "Workspace path is unavailable",
        type: "error",
      });
      return;
    }
    setSavePath((previous) => previous || filename);
    setSaveOpen(true);
  };

  const save = async () => {
    const relativePath = savePath.trim();
    if (!relativePath) {
      toastManager.add({ type: "warning", title: "Enter a workspace path" });
      return;
    }
    if (!workspaceRoot) return;
    setSaving(true);
    try {
      const result = await writeFile({
        hostId,
        input: { cwd: workspaceRoot, relativePath, contents: exportMarkdown },
      });
      if (result._tag === "Success") {
        setSaveOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved into the project",
          description: result.value.relativePath,
        });
      } else if (!isAtomActionInterrupted(result)) {
        const failure = squashAtomActionFailure(result);
        toastManager.add(
          threadToast({
            description:
              failure instanceof Error ? failure.message : "An error occurred while saving.",
            title: "Could not save plan",
            type: "error",
          }),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative rounded-xl bg-card/60 py-4 pr-4 pl-5 sm:pr-5 sm:pl-6">
      <span
        aria-hidden="true"
        className="absolute top-4 bottom-4 left-0 w-[3px] rounded-full bg-foreground/70"
      />
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.14em]">
            Proposed plan
          </p>
          <h3 className="mt-0.5 truncate font-medium text-[15px] text-foreground">{title}</h3>
        </div>
        <div aria-label="Plan actions" className="flex gap-0.5" role="group">
          <Button
            onClick={() => copyToClipboard(exportMarkdown, undefined)}
            size="xs"
            variant="ghost"
          >
            {isCopied ? "Copied" : "Copy"}
          </Button>
          <Button disabled={!workspaceRoot || saving} onClick={openSave} size="xs" variant="ghost">
            Save into project
          </Button>
          <Button
            onClick={() => downloadPlanAsTextFile(filename, exportMarkdown)}
            size="xs"
            variant="ghost"
          >
            .md
          </Button>
        </div>
      </div>
      <div className={collapsed ? "relative mt-4 max-h-[26rem] overflow-hidden" : "mt-4"}>
        <ReplyMarkdown
          cwd={cwd}
          headingLevelOffset={3}
          isStreaming={false}
          text={bodyMarkdown}
          {...(threadRef ? { threadRef } : {})}
          hostId={hostId}
        />
        {collapsed ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card via-card/80 to-transparent" />
        ) : null}
      </div>
      {collapsible ? (
        <button
          className="mt-3 cursor-pointer font-medium text-muted-foreground text-xs underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          data-scroll-anchor-ignore=""
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show less" : "Read the whole plan"}
        </button>
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!saving) setSaveOpen(open);
        }}
        open={saveOpen}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save the plan into this project</DialogTitle>
            <DialogDescription>
              Where should it go? The path is relative to{" "}
              <code>{workspaceRoot ?? "the project"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <label className="grid gap-1.5 font-medium text-foreground text-xs">
              File
              <Input
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={filename}
                spellCheck={false}
                value={savePath}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={saving}
              onClick={() => setSaveOpen(false)}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void save()} size="sm">
              {saving ? "Saving…" : "Save plan"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
