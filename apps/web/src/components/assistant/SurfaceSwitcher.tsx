// Flat segmented control in the titlebar: Kora | Code. A hairline-bordered pair of segments, the active one on a flat
// fill (no pill, no lift). It sits at the right end of the sidebar's header (and after the toggle with the sidebar
// closed), so it stays reachable either way. Behaviour lives in useSurfaceSwitch.
import { cn } from "../../util/utils";
import { PixelSprite } from "../sprite";
import type { AppSurface } from "./surfaceStore";

const SEGMENTS = [
  { id: "blobs", label: "Kora" },
  { id: "code", label: "Code" },
] as const;

export function SurfaceSwitcher(props: {
  readonly value: AppSurface;
  readonly onChange: (next: AppSurface) => void;
  readonly className?: string | undefined;
}) {
  const { value, onChange } = props;
  return (
    <div
      role="tablist"
      aria-label="Surface"
      className={cn(
        "flex h-7 items-stretch overflow-hidden rounded-lg border border-white/7 [-webkit-app-region:no-drag]",
        props.className,
      )}
    >
      {SEGMENTS.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1 px-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            i > 0 && "border-l border-white/7",
            value === tab.id
              ? "bg-[#111113] text-sidebar-foreground"
              : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
          )}
        >
          {tab.id === "blobs" ? (
            <PixelSprite state="idle" size={12} still />
          ) : (
            <span aria-hidden className="font-mono text-[11px] leading-none">
              {"</>"}
            </span>
          )}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
