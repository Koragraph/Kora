// A file path that wraps at its slashes, never in the middle of a name ("/Users/me/Blobs-Dev/P|intu" read as two paths).
// `~` replaces the home folder.
import { Fragment } from "react";

import { cn } from "~/util/utils";
import { tildify } from "./blobsRoot";

export function pathParts(path: string): string[] {
  return tildify(path).split("/");
}

export function PathText(props: { readonly path: string; readonly className?: string }) {
  const parts = pathParts(props.path);
  return (
    <code className={cn("[overflow-wrap:break-word] [word-break:normal]", props.className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? "/" : null}
          {index > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </code>
  );
}
