/**
 * Compact cards rendered under an assistant turn on the assistant lane, one per
 * file the turn produced under the project root. See `outputs.ts` for how the
 * path list is derived and `OutputPreview.tsx` for what "Open" shows.
 */

import { resolvePathLinkTarget } from "~/thread/terminal-links";
import { readLocalApi } from "~/localApi";
import { useCopyToClipboard } from "~/hooks/useCopyText";
import { toastManager } from "~/components/ui/toast";
import { Hint } from "~/components/ui/hint";
import { Button } from "~/components/ui/button";
import {
  classifyOutputKind,
  truncateOutputName,
  outputDisplayName,
  useOpenChatOutput,
  formatOutputSize,
  outputKindLabel,
  outputKindIcon,
  type OutputKind,
} from "./outputs";
import { useProjectFile } from "../viewer/projectFilesQueryState";
import type { HostThreadRef, HostId } from "@kora/contracts";
import { ExternalLinkIcon, FolderOpenIcon } from "lucide-react";

function revealOutputPath(absolutePath: string, copyToClipboard: (value: string) => void) {
  copyToClipboard(absolutePath);
  toastManager.add({ type: "success", title: "Path copied" });
  if (typeof window === "undefined" || !window.shellBridge) return;
  void readLocalApi()
    ?.shell.openExternal(`file://${encodeURI(absolutePath)}`)
    .catch(() => {
      // No dedicated "reveal in Finder" bridge exists yet; the copied path
      // above is the real fallback, so a rejected file:// open stays quiet.
    });
}

function OutputCard(props: {
  readonly hostId: HostId;
  readonly cwd: string;
  readonly threadRef: HostThreadRef;
  readonly relativePath: string;
}) {
  const kind: OutputKind = classifyOutputKind(props.relativePath);
  const Icon = outputKindIcon(kind);
  const name = outputDisplayName(props.relativePath);
  const displayName = truncateOutputName(name);
  const canReadSize = kind !== "image" && kind !== "pdf" && kind !== "other";
  const file = useProjectFile(props.hostId, props.cwd, props.relativePath, canReadSize);
  const openOutput = useOpenChatOutput(props.threadRef);
  const { copyToClipboard } = useCopyToClipboard({ target: "file path" });
  const absolutePath = resolvePathLinkTarget(props.relativePath, props.cwd);

  // A name the agent mentioned but never wrote (or has since removed) gets no card.
  if (canReadSize && !file.isPending && !file.data && file.error) return null;

  const sizeLabel =
    file.data && !file.isPending ? ` · ${formatOutputSize(file.data.byteLength)}` : "";

  return (
    <div className="flex min-w-0 max-w-[26rem] items-center gap-2.5 rounded-[var(--radius)] border border-border/60 bg-card px-3 py-2 transition-colors hover:bg-card/80">
      <Icon className="size-7 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <Hint label={name}>
          <p className="truncate text-xs font-medium text-foreground">{displayName}</p>
        </Hint>
        <p className="truncate text-[11px] text-muted-foreground">
          {outputKindLabel(kind)}
          {sizeLabel}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant="secondary"
          className="gap-1"
          onClick={() => openOutput(props.relativePath)}
        >
          <ExternalLinkIcon className="size-3.5" aria-hidden />
          Open
        </Button>
        <Button
          aria-label="Reveal file"
          onClick={() => revealOutputPath(absolutePath, copyToClipboard)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <FolderOpenIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function OutputCardGroup(props: {
  readonly hostId: HostId;
  readonly cwd: string;
  readonly threadRef: HostThreadRef;
  readonly relativePaths: ReadonlyArray<string>;
}) {
  if (props.relativePaths.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-output-card-group>
      {props.relativePaths.map((relativePath) => (
        <OutputCard
          key={relativePath}
          hostId={props.hostId}
          cwd={props.cwd}
          threadRef={props.threadRef}
          relativePath={relativePath}
        />
      ))}
    </div>
  );
}
