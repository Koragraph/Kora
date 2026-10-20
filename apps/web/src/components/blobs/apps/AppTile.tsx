// An app's mark: its first letter on a quiet tile. (No remote logos: loading images from a third party's CDN would tell it
// when you open this page.)
import { cn } from "~/util/utils";

export function AppTile(props: {
  readonly name: string;
  readonly size?: "sm" | "md";
  readonly className?: string;
}) {
  const letter = props.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-xl bg-foreground/[0.08] font-semibold text-foreground/85",
        props.size === "sm" ? "size-7 text-[12px]" : "size-10 text-[15px]",
        props.className,
      )}
    >
      {letter}
    </span>
  );
}
