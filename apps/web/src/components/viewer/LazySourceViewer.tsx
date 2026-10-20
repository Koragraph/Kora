import { lazy, Suspense } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";

const SourceViewer = lazy(() => import("./ReadOnlySourceViewer"));

/** Highlighted read-only source, loaded on demand so message rendering never waits on the highlighter. */
export function ReadOnlySourceViewer(props: { name: string; text: string }) {
  return (
    <Suspense fallback={<FileSurfaceLoading className="p-4" />}>
      <SourceViewer {...props} />
    </Suspense>
  );
}
