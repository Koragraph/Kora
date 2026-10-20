import { cn } from "~/util/utils";
import { type ComponentProps, isValidElement, type ReactNode, Children } from "react";
import { type VariantProps, cva } from "class-variance-authority";

const alertVariants = cva("relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm", {
  variants: {
    variant: {
      default: "bg-transparent dark:bg-input/32 [&_[data-alert-icon]]:text-muted-foreground",
      error:
        "border-error/32 bg-error-surface text-error-foreground [&_[data-alert-icon]]:text-error [&_[data-slot=alert-description]]:text-error-foreground/80",
      info: "border-info/32 bg-info/4 [&_[data-alert-icon]]:text-info",
      success: "border-success/32 bg-success/4 [&_[data-alert-icon]]:text-success",
      warning:
        "border-warning/32 bg-warning-surface text-warning-foreground [&_[data-alert-icon]]:text-warning [&_[data-slot=alert-description]]:text-warning-foreground/80",
    },
  },
  defaultVariants: { variant: "default" },
});

type Region = "icon" | "content" | "action";

function slotNameOf(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return undefined;
  const props = node.props as { "data-slot"?: unknown };
  if (typeof props["data-slot"] === "string") return props["data-slot"];
  const type = node.type as { displayName?: string; name?: string };
  if (typeof node.type === "string") return undefined;
  const name = type.displayName ?? type.name;
  switch (name) {
    case "AlertDescription":
      return "alert-description";
    case "AlertTitle":
      return "alert-title";
    case "AlertAction":
      return "alert-action";
    default:
      return name;
  }
}

function regionOf(node: ReactNode): Region {
  if (!isValidElement(node)) return "content";
  const slot = slotNameOf(node);
  if (slot === "alert-action") return "action";
  if (slot === "alert-title" || slot === "alert-description") return "content";
  return "icon";
}

function Alert({
  className,
  variant,
  controlAlignment = "center",
  children,
  ...props
}: ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & { controlAlignment?: "center" | "first-line" }) {
  const regions: Record<Region, ReactNode[]> = { icon: [], content: [], action: [] };
  for (const child of Children.toArray(children)) {
    regions[regionOf(child)].push(child);
  }
  const hasActions = regions.action.length > 0;
  const centered = controlAlignment === "center";

  return (
    <div
      role="alert"
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <div
        className={cn(
          "flex gap-2",
          centered
            ? "items-center"
            : cn("items-start", hasActions && "min-h-7 pt-1 sm:min-h-6 sm:pt-0.5"),
        )}
      >
        {regions.icon.length > 0 && (
          <div
            data-alert-icon=""
            className={cn(
              centered ? "h-4 w-4 [&>svg]:size-full" : "h-lh w-4",
              "flex shrink-0 items-center justify-center [&>svg]:size-4",
            )}
          >
            {regions.icon}
          </div>
        )}
        {regions.content.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">{regions.content}</div>
        )}
        {hasActions && (
          <div
            className={cn(
              "shrink-0",
              centered ? "self-center" : "flex h-lh self-start items-center",
            )}
          >
            {regions.action}
          </div>
        )}
      </div>
    </div>
  );
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("font-medium", className)} data-slot="alert-title" {...props} />;
}
AlertTitle.displayName = "AlertTitle";

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2.5 text-muted-foreground", className)}
      data-slot="alert-description"
      {...props}
    />
  );
}
AlertDescription.displayName = "AlertDescription";

function AlertAction({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex gap-1", className)} data-slot="alert-action" {...props} />;
}
AlertAction.displayName = "AlertAction";

export { Alert, AlertTitle, AlertDescription, AlertAction };
