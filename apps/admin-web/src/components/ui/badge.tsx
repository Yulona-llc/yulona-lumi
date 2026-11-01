import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold [&>svg]:size-3", {
  variants: {
    variant: {
      default: "bg-primary/15 text-accent-foreground",
      secondary: "bg-secondary text-secondary-foreground",
      outline: "border text-foreground",
      success: "bg-success/12 text-success",
      warning: "bg-warning/14 text-warning",
      destructive: "bg-destructive/12 text-destructive",
      info: "bg-info/12 text-info",
    },
  },
  defaultVariants: { variant: "secondary" },
});

function Badge({ className, variant, asChild = false, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
export { Badge, badgeVariants };
