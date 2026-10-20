import { cn } from "~/util/utils";
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

const separatorCls1 =
  "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch";

function Separator({ orientation = "horizontal", className, ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      className={cn(separatorCls1, className)}
      orientation={orientation}
      data-slot="separator"
      {...props}
    />
  );
}

export { Separator };
