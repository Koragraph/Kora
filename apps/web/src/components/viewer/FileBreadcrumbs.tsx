import type { HostId } from "@kora/contracts";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useRefreshOnWorkspaceChange";
import { isAbsolutePath } from "~/thread/terminal-links";
import { cn } from "~/util/utils";
import { FileEntryIcon } from "../thread/FileEntryIcon";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/spin-refresh-icon";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fileBreadcrumbChildren, fileBreadcrumbParent, fileBreadcrumbs } from "./filePath";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

type Props = {
  cwd: string;
  hostId: HostId;
  onOpenFile: (relativePath: string) => void;
  projectName: string;
  relativePath: string;
  workspaceMutationId: string | null;
};

const LABEL_CLASS = "max-w-40 truncate rounded-sm px-0.5";

function lastSegment(path: string, fallback: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? fallback;
}

function Labelled({
  label,
  full,
  children,
}: {
  label: string;
  full: string;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup className="max-w-80" side="top">
        {full}
      </TooltipPopup>
    </Tooltip>
  );
}

function DirectoryMenuBody(props: {
  cwd: string;
  hostId: HostId;
  directory: string;
  rootPath: string;
  currentFile: string;
  projectName: string;
  workspaceMutationId: string | null;
  setDirectory: (path: string) => void;
  close: () => void;
  onOpenFile: (relativePath: string) => void;
}) {
  const theme = useTheme().resolvedTheme;
  const query = useProjectEntriesQuery(props.hostId, props.cwd, props.directory || undefined);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    refresh: query.refresh,
    resourceKey: `files:${props.hostId}:${props.cwd}`,
  });

  const { directory, rootPath } = props;
  const parent = fileBreadcrumbParent(directory);
  const canGoBack =
    directory !== rootPath &&
    parent !== null &&
    (rootPath === "" || parent === rootPath || parent.startsWith(`${rootPath}/`));
  const parentLabel = parent === null ? "" : lastSegment(parent, props.projectName);

  const children = query.data ? fileBreadcrumbChildren(query.data.entries, directory) : [];
  const truncated = query.data?.truncated === true;

  let body: ReactElement;
  if (query.isPending && !query.data) {
    body = (
      <MenuItem disabled>
        <Spinner />
        Loading folder…
      </MenuItem>
    );
  } else if (query.error && !query.data) {
    body = (
      <MenuItem closeOnClick={false} onClick={query.refresh}>
        <RefreshIcon refreshing={query.isPending} />
        Retry loading folder
      </MenuItem>
    );
  } else if (!query.data && !truncated) {
    body = <MenuItem disabled>This folder is no longer available.</MenuItem>;
  } else if (children.length === 0) {
    body = (
      <MenuItem disabled>
        {truncated
          ? "No entries from this folder are available in the partial workspace index."
          : "This folder is empty."}
      </MenuItem>
    );
  } else {
    body = (
      <>
        {children.map((child) => {
          const isCurrent = child.path === props.currentFile;
          return (
            <MenuItem
              aria-current={isCurrent ? "page" : undefined}
              className={cn(
                isCurrent && "bg-foreground/8",
                child.ignored && "text-muted-foreground",
              )}
              closeOnClick={child.kind !== "directory"}
              key={child.path}
              onClick={() => {
                if (child.kind === "directory") {
                  props.setDirectory(child.path);
                  return;
                }
                props.close();
                props.onOpenFile(child.path);
              }}
            >
              <FileEntryIcon kind={child.kind} pathValue={child.path} theme={theme} />
              <Tooltip>
                <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                  {child.label}
                </TooltipTrigger>
                <TooltipPopup side="right">{child.path}</TooltipPopup>
              </Tooltip>
              {child.kind === "directory" ? (
                <ChevronRightIcon className="ms-auto text-muted-foreground" />
              ) : null}
            </MenuItem>
          );
        })}
      </>
    );
  }

  return (
    <>
      {canGoBack && parent !== null ? (
        <>
          <MenuItem closeOnClick={false} onClick={() => props.setDirectory(parent)}>
            <ArrowLeftIcon />
            <span className="truncate">{`Back to ${parentLabel}`}</span>
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuGroup key={directory}>{body}</MenuGroup>
      {query.error && query.data ? (
        <>
          <MenuSeparator />
          <MenuItem closeOnClick={false} onClick={query.refresh}>
            <RefreshIcon refreshing={query.isPending} />
            Refresh failed — retry
          </MenuItem>
        </>
      ) : null}
      {truncated ? (
        <>
          <MenuSeparator />
          <MenuItem disabled>Some workspace entries are not shown.</MenuItem>
        </>
      ) : null}
    </>
  );
}

function DirectoryBreadcrumb(
  props: Omit<Props, "relativePath"> & {
    crumbPath: string;
    label: string;
    currentFile: string;
  },
) {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState(props.crumbPath);

  // A different crumb or file starts the menu over.
  useEffect(() => {
    setOpen(false);
    setDirectory(props.crumbPath);
  }, [props.crumbPath, props.currentFile]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) setDirectory(props.crumbPath);
    },
    [props.crumbPath],
  );

  return (
    <Menu onOpenChange={onOpenChange} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  aria-label={`Browse ${props.label}`}
                  className={cn(
                    LABEL_CLASS,
                    "cursor-pointer text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground pointer-coarse:py-3",
                  )}
                  type="button"
                />
              }
            />
          }
        >
          {props.label}
        </TooltipTrigger>
        <TooltipPopup className="max-w-80" side="top">
          {props.crumbPath || props.projectName}
        </TooltipPopup>
      </Tooltip>
      {open ? (
        <MenuPopup
          align="start"
          className="w-max min-w-32 max-w-[min(19rem,var(--available-width))]"
          side="bottom"
        >
          <DirectoryMenuBody
            close={() => setOpen(false)}
            currentFile={props.currentFile}
            cwd={props.cwd}
            directory={directory}
            hostId={props.hostId}
            onOpenFile={props.onOpenFile}
            projectName={props.projectName}
            rootPath={props.crumbPath}
            setDirectory={setDirectory}
            workspaceMutationId={props.workspaceMutationId}
          />
        </MenuPopup>
      ) : null}
    </Menu>
  );
}

export function FileBreadcrumbs(props: Props): ReactElement[] {
  const crumbs = fileBreadcrumbs(props.projectName, props.relativePath);
  const hostPath = isAbsolutePath(props.relativePath);

  return crumbs.map((crumb, index) => {
    const isFile = crumb.kind === "file";
    let inner: ReactElement;
    if (isFile) {
      inner = (
        <Labelled full={crumb.path || props.projectName} label={crumb.label}>
          <span aria-current="page" className={cn(LABEL_CLASS, "font-medium text-foreground")}>
            {crumb.label}
          </span>
        </Labelled>
      );
    } else if (hostPath) {
      inner = (
        <Labelled full={crumb.path || props.projectName} label={crumb.label}>
          <span className={cn(LABEL_CLASS, "text-muted-foreground")}>{crumb.label}</span>
        </Labelled>
      );
    } else {
      inner = (
        <DirectoryBreadcrumb
          crumbPath={crumb.path}
          currentFile={props.relativePath}
          cwd={props.cwd}
          hostId={props.hostId}
          label={crumb.label}
          onOpenFile={props.onOpenFile}
          projectName={props.projectName}
          workspaceMutationId={props.workspaceMutationId}
        />
      );
    }

    return (
      <div
        className="flex min-w-0 shrink-0 items-center"
        data-current-file-crumb={isFile ? true : undefined}
        key={`${crumb.kind}:${crumb.path}`}
      >
        {index > 0 ? <ChevronRightIcon className="mx-1 size-3.5 text-muted-foreground/60" /> : null}
        {inner}
      </div>
    );
  });
}
