import { cn } from "~/util/utils";
import { useFaviconForThreadUrl } from "~/stores/webIconStore";
import { BrowserMockup } from "./BrowserMockup";
import type { HostThreadRef } from "@kora/contracts";
import { type ReactNode, useState } from "react";

export function FaviconImage(props: {
  sources: ReadonlyArray<string | null | undefined>;
  className?: string | undefined;
  fallback: ReactNode;
}) {
  const sources = props.sources.filter((source): source is string => Boolean(source));
  return (
    <FaviconImageAttempt
      className={props.className}
      fallback={props.fallback}
      key={sources.join("\0")}
      sources={sources}
    />
  );
}

function FaviconImageAttempt(props: {
  sources: ReadonlyArray<string>;
  className?: string | undefined;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const source = props.sources.find((candidate) => !failed.has(candidate));
  if (!source) {
    return props.fallback;
  }
  return (
    <img
      onError={() => setFailed((current) => new Set(current).add(source))}
      className={props.className}
      aria-hidden="true"
      draggable={false}
      src={source}
      alt=""
    />
  );
}

export function WebFaviconIcon(props: {
  className?: string | undefined;
  threadRef: HostThreadRef;
  url: string;
}) {
  const { className, threadRef, url } = props;
  const sources = [useFaviconForThreadUrl(threadRef, url)];
  return (
    <FaviconImage
      sources={sources}
      fallback={<BrowserMockup className={cn("size-7 shrink-0", className)} />}
      className={cn("size-7 shrink-0 rounded object-contain", className)}
    />
  );
}
