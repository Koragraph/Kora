/**
 * Highlighted source for files that cannot be edited: captured attachments,
 * host files outside the workspace and truncated reads. Same surface theme,
 * word-wrap preference and virtualization as the editable workspace file.
 */

import { PREFERRED_HIGHLIGHTER } from "~/util/syntaxHighlighting";
import { resolveDiffThemeName } from "~/util/diffRendering";
import { useTheme } from "~/hooks/useTheme";
import { useClientPrefs } from "~/hooks/usePrefs";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkers";
import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";
import { type FileOptions, Virtualizer, File } from "@pierre/diffs/react";

export default function ReadOnlySourceViewer(props: {
  readonly onPostRender?: FileOptions<unknown>["onPostRender"];
  readonly cacheKey?: string;
  readonly text: string;
  readonly name: string;
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientPrefs((settings) => settings.wordWrap);
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        className="file-viewer-virtualizer min-h-0 flex-1 overflow-auto"
        key={`${props.name}:${resolvedTheme}:${props.text.length}`}
      >
        <File
          className="min-h-full"
          file={{
            contents: props.text,
            name: props.name,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          options={{
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            themeType: resolvedTheme,
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            overflow: wordWrap ? "wrap" : "scroll",
            disableFileHeader: true,
            ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
          }}
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}
