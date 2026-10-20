import { watchVisibleAnimation } from "~/util/visibleAnimation";
import { cn } from "~/util/utils";
import { LoaderCircleIcon } from "lucide-react";

function Spinner({ className, ...props }: React.ComponentPropsWithoutRef<typeof LoaderCircleIcon>) {
  return (
    <LoaderCircleIcon
      className={cn("motion-safe:visible-animate-spin", className)}
      ref={watchVisibleAnimation}
      aria-label="Loading"
      role="status"
      {...props}
    />
  );
}

export { Spinner };
