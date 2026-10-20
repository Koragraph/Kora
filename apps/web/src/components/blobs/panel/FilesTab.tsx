// Files: what this blob has made (its workspace's outputs/ and files/), newest first. Opening one shows it in the
// app's file viewer; spreadsheets, documents, decks, PDFs and images preview in place (BlobOutputCard).
import type { WorkspaceFile, HostThreadRef } from "@kora/contracts";
import { CopyIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { toastManager } from "../../ui/toast";
import { BlobOutputCard } from "../previews/BlobOutputCards";
import { useBlobsApi } from "../shell/blobsApi";
import { PanelEmpty } from "./PanelEmpty";

export function FilesTab(props: {
  readonly blobId: string;
  readonly workspace: string;
  readonly threadRef: HostThreadRef | null;
  /** Bumps when a turn settles, so new outputs appear without reopening the tab. */
  readonly refreshKey: string | null;
}) {
  const api = useBlobsApi();
  const [files, setFiles] = useState<readonly WorkspaceFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.files(props.blobId, null).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setFiles([...r.value.files].sort((a, b) => b.modifiedAt - a.modifiedAt));
        setError(null);
      } else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [props.blobId, props.refreshKey, api.hostId]);

  const copyFolder = (
    <Button
      variant="outline"
      size="xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.workspace);
          toastManager.add({ type: "success", title: "Folder path copied" });
        } catch {
          toastManager.add({ type: "error", title: "Could not copy the path" });
        }
      }}
    >
      <CopyIcon />
      Copy folder path
    </Button>
  );

  if (files === null && error === null) {
    return (
      <div className="space-y-2 p-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 rounded-xl" />
        ))}
      </div>
    );
  }
  if (error !== null) {
    return (
      <PanelEmpty icon={FolderOpenIcon} title="Couldn’t list files">
        {error}
      </PanelEmpty>
    );
  }
  if (!files || files.length === 0) {
    return (
      <PanelEmpty icon={FolderOpenIcon} title="No files yet" action={copyFolder}>
        Reports, spreadsheets and anything else this blob makes land in its folder and show up here.
      </PanelEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-2" data-blob-files>
      {files.map((f) =>
        api.hostId === null ? null : (
          <BlobOutputCard
            key={f.path}
            hostId={api.hostId}
            cwd={props.workspace}
            threadRef={props.threadRef}
            blobId={props.blobId}
            relativePath={f.relPath}
          />
        ),
      )}
      <div className="px-1 pt-2">{copyFolder}</div>
    </div>
  );
}
