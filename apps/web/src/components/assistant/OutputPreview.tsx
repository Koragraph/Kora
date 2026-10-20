/**
 * Extra right-panel renderers for assistant outputs that `FileViewerPanel`'s
 * markdown/table/source paths don't already cover: HTML (sandboxed iframe),
 * JSON (pretty tree or highlighted source) and a binary fallback card for
 * images, PDFs and office/archive formats `projects.readFile` cannot read
 * (it fails with `binary_file` — there is no signed-asset-URL path for local
 * chat-project files yet, so these can only offer "copy path"/reveal, not an
 * inline render).
 */
import { Hint } from "~/components/ui/hint";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyText";
import { readLocalApi } from "~/localApi";
import { toastManager } from "~/components/ui/toast";

import { FileSurfaceAction } from "../viewer/fileSurfaceChrome";
import SourceFilePreview from "../viewer/ReadOnlySourceViewer";
import {
  resolveHtmlPreviewFrame,
  withRemoteContent,
  type HtmlPreviewFrame,
} from "./htmlPreviewFrame";
import { outputKindIcon, outputKindLabel, type OutputKind } from "./outputs";

function useHtmlPreviewFrame(html: string): HtmlPreviewFrame {
  // Resolved frames are keyed by the HTML they were made for; anything else is pending.
  const [resolved, setResolved] = useState<{
    readonly html: string;
    readonly frame: HtmlPreviewFrame;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void resolveHtmlPreviewFrame(
      html,
      typeof window === "undefined" ? undefined : window.koraHtmlPreview?.register,
    ).then((frame) => {
      if (!cancelled) setResolved({ html, frame });
    });
    return () => {
      cancelled = true;
    };
  }, [html]);
  return resolved !== null && resolved.html === html ? resolved.frame : { kind: "pending" };
}

export function HtmlOutputPreview(props: { readonly name: string; readonly html: string }) {
  const [showSource, setShowSource] = useState(false);
  const frame = useHtmlPreviewFrame(props.html);
  // Strict by default (no remote assets); the opt-in is per document, so a new page starts strict again.
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const remoteAllowed = frame.kind === "url" && remoteUrl === frame.url;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-border/60 bg-background px-2">
        {frame.kind === "url" && !showSource && !remoteAllowed ? (
          <Button
            data-html-preview-load-remote=""
            onClick={() => setRemoteUrl(frame.url)}
            size="xs"
            title="Reload this page with images, fonts and scripts from the web"
            variant="ghost"
          >
            Load remote content
          </Button>
        ) : null}
        <FileSurfaceAction
          label={showSource ? "Show rendered page" : "Show HTML source"}
          pressed={showSource}
          onPress={() => setShowSource((current) => !current)}
        >
          {showSource ? "</>" : "▶"}
        </FileSurfaceAction>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {showSource ? (
          <SourceFilePreview name={props.name} text={props.html} />
        ) : frame.kind === "pending" ? null : (
          // No same-origin, no top navigation, scripts only: the agent's page
          // can run its own JS but can neither read Kora's DOM/storage nor
          // steer the browser away from the preview.
          <iframe
            title={props.name}
            {...(frame.kind === "url"
              ? { src: remoteAllowed ? withRemoteContent(frame.url) : frame.url }
              : { srcDoc: props.html })}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}

function formatJson(text: string): { pretty: string; valid: boolean } {
  try {
    return { pretty: JSON.stringify(JSON.parse(text), null, 2), valid: true };
  } catch {
    return { pretty: text, valid: false };
  }
}

export function JsonOutputPreview(props: { readonly name: string; readonly json: string }) {
  const { pretty, valid } = useMemo(() => formatJson(props.json), [props.json]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!valid ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
          Couldn't parse this as JSON — showing the raw source.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <SourceFilePreview name={props.name} text={pretty} />
      </div>
    </div>
  );
}

/**
 * Images, PDFs and office/archive formats: `projects.readFile` refuses
 * binary content (`binary_file`), and there is no signed asset URL a local
 * chat-project file can load into an `<img>`/`<iframe>` in the browser
 * client. Until that lands, the clearest honest surface is "here's the path,
 * open it yourself" — never a silent no-op.
 */
export function OutputBinaryFallback(props: {
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string | null;
  readonly kind: OutputKind;
}) {
  const Icon = outputKindIcon(props.kind);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "file path" });
  const copyPath = props.absolutePath ?? props.relativePath;
  const hasShellBridge = typeof window !== "undefined" && Boolean(window.shellBridge);

  const reveal = () => {
    // No general "reveal in Finder" bridge exists for arbitrary host paths
    // yet (only a browser-artifact-scoped one). Copying is always visible
    // feedback, whether or not a desktop bridge is present.
    copyToClipboard(copyPath, undefined);
    toastManager.add({ type: "success", title: "Path copied" });
    if (!hasShellBridge) return;
    void readLocalApi()
      ?.shell.openExternal(`file://${encodeURI(copyPath)}`)
      .catch(() => {
        // openExternal refuses file:// URLs by design; the copied path is the
        // fallback the user acts on, so a rejection here is expected and quiet.
      });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Icon className="size-8 text-muted-foreground" aria-hidden />
      <div className="max-w-sm">
        <p className="text-sm font-medium text-foreground">{props.name}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Kora can't preview this {outputKindLabel(props.kind).toLowerCase()} inline yet. Open it in
          your file manager or a native app.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="secondary" className="gap-1.5" onClick={reveal}>
          {isCopied ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden />
          )}
          {isCopied ? "Copied" : "Copy path"}
        </Button>
      </div>
      <Hint label={copyPath}>
        <p className="max-w-sm truncate font-mono text-[11px] text-muted-foreground">{copyPath}</p>
      </Hint>
    </div>
  );
}
