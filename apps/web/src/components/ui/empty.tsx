import { cn } from "~/util/utils";
import { type VariantProps, cva } from "class-variance-authority";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-6 text-balance p-6 text-center md:p-12",
        className,
      )}
      data-slot="empty"
      {...props}
    />
  );
}

const emptyHeaderCls1 = "flex max-w-sm flex-col items-center text-center";

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn(emptyHeaderCls1, className)} data-slot="empty-header" {...props} />;
}

const emptyMediaVariants = cva(
  "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "relative flex size-9 shrink-0 items-center justify-center rounded-md border bg-card not-dark:bg-clip-padding text-foreground shadow-sm/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg:not([class*='size-'])]:size-4.5",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const emptyMediaCls1 =
  "-translate-x-0.5 -rotate-10 pointer-events-none absolute bottom-px origin-bottom-left scale-84 shadow-none";
const emptyMediaCls2 =
  "pointer-events-none absolute bottom-px origin-bottom-right translate-x-0.5 rotate-10 scale-84 shadow-none";

function EmptyMedia(
  incoming: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>,
) {
  const { variant = "default", className, ...props } = incoming;
  return (
    <div
      data-variant={variant}
      data-slot="empty-media"
      className={cn("relative mb-6", className)}
      {...props}
    >
      {variant === "icon" && (
        <>
          <div
            className={cn(emptyMediaVariants({ className, variant }), emptyMediaCls1)}
            aria-hidden="true"
          />
          <div
            className={cn(emptyMediaVariants({ className, variant }), emptyMediaCls2)}
            aria-hidden="true"
          />
        </>
      )}
      <div className={cn(emptyMediaVariants({ className, variant }))} {...props} />
    </div>
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("font-heading font-semibold text-xl", className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      className={cn(
        "text-muted-foreground text-sm [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-title]+&]:mt-1",
        className,
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

const emptyContentCls1 =
  "flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm";

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn(emptyContentCls1, className)} data-slot="empty-content" {...props} />;
}

export { EmptyDescription, EmptyContent, EmptyHeader, EmptyTitle, EmptyMedia, Empty };
